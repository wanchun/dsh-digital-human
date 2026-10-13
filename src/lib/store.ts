/**
 * Durable registry of digital humans.
 *
 * A digital human is a record, not a plugin row: the registry file is the only
 * source of truth, so humans are created, edited, paused, and deleted without
 * touching a composition. `humans.json` is small and human-editable on purpose;
 * per-human working state lives beside it under `humans/<id>/`.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Human, HumanPatch } from './types.js'

/** Identifier shape shared by ids, conversation ids, and IM bot ids. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Default registry root when the plugin row configures none. */
export function defaultHome() {
  return join(homedir(), '.dsh', 'digital-human')
}

/** Fail loud on identifiers that would escape their directory or confuse IM targets. */
export function requireSlug(value, label) {
  if (typeof value !== 'string' || !SLUG.test(value)) {
    throw new Error(`${label} must match ${SLUG}: ${JSON.stringify(value)}`)
  }
  return value
}

function stringList(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) throw new Error(`${label} entries must be non-empty strings`)
    return entry.trim()
  })
}

function subscriptionList(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('subscriptions must be an array')
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('subscriptions entries must be objects')
    const cron = typeof entry.cron === 'string' ? entry.cron.trim() : ''
    if (!cron) throw new Error('subscriptions entries need a cron expression')
    return {
      cron,
      prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
      ...(entry.conversationId === undefined ? {} : { conversationId: requireSlug(entry.conversationId, 'conversationId') }),
      enabled: entry.enabled !== false,
    }
  })
}

/**
 * Validate and default one digital-human record. Unknown fields are dropped, so
 * a hand-edited file cannot smuggle state the runtime does not understand.
 */
export function normalizeHuman(input, now = new Date().toISOString()) {
  if (!input || typeof input !== 'object') throw new Error('digital human must be an object')
  const id = requireSlug(input.id, 'digital human id')
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : id
  const im = input.im && typeof input.im === 'object' ? input.im : {}
  const escalation = input.escalation && typeof input.escalation === 'object' ? input.escalation : {}
  return {
    id,
    name,
    description: typeof input.description === 'string' ? input.description : '',
    enabled: input.enabled !== false,
    systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : '',
    workspace: typeof input.workspace === 'string' && input.workspace ? input.workspace : '',
    model: typeof input.model === 'string' && input.model ? input.model : '',
    skills: stringList(input.skills, 'skills'),
    peers: stringList(input.peers, 'peers'),
    im: {
      botId: typeof im.botId === 'string' && im.botId ? requireSlug(im.botId, 'im.botId') : '',
      targetId: typeof im.targetId === 'string' && im.targetId ? requireSlug(im.targetId, 'im.targetId') : '',
    },
    subscriptions: subscriptionList(input.subscriptions),
    memory: input.memory !== false,
    escalation: {
      enabled: escalation.enabled === true,
      timeoutHours: Number.isFinite(escalation.timeoutHours) ? escalation.timeoutHours : 24,
    },
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
    updatedAt: now,
  }
}

/** Registry backed by one JSON document plus a per-human state directory. */
export class HumanStore {
  #home
  #file
  #cache

  constructor(home: string) {
    this.#home = home
    this.#file = join(home, 'humans.json')
  }

  get home() {
    return this.#home
  }

  get file() {
    return this.#file
  }

  /** Root of one human's private state (sessions, conversations, memory). */
  dir(id) {
    return join(this.#home, 'humans', requireSlug(id, 'digital human id'))
  }

  memoryPath(id) {
    return join(this.dir(id), 'memory.md')
  }

  sessionIndexPath(id) {
    return join(this.dir(id), 'sessions.json')
  }

  conversationPath(id, conversationId) {
    // Percent-encode: a Halo conversation id carries colons, which are legal in
    // the id but not a safe filename. Plain ids encode to themselves, so
    // existing logs keep their names.
    return join(this.dir(id), 'conversations', `${encodeURIComponent(conversationId)}.jsonl`)
  }

  async ensureDir(path) {
    await mkdir(path, { recursive: true })
  }

  /** Read the registry, creating it from `seed` on first use. */
  async load(seed: Human[] = []): Promise<Human[]> {
    if (this.#cache) return this.#cache
    if (!existsSync(this.#file)) {
      const records = seed.map((entry) => normalizeHuman(entry))
      await this.write(records)
      this.#cache = records
      return records
    }
    const raw = await readFile(this.#file, 'utf8')
    const parsed = raw.trim() ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) throw new Error(`${this.#file} must hold a JSON array`)
    const records = parsed.map((entry) => normalizeHuman(entry, entry?.createdAt))
    this.#cache = records
    return records
  }

  /** Replace the whole registry atomically. */
  async write(records) {
    await this.ensureDir(dirname(this.#file))
    const temp = `${this.#file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
    await rename(temp, this.#file)
    this.#cache = records
    return records
  }

  async list(seed: Human[] = []): Promise<Human[]> {
    return [...(await this.load(seed))]
  }

  /** Resolve by exact id first, then by exact display name. */
  async get(idOrName: string, seed: Human[] = []): Promise<Human | undefined> {
    const records = await this.load(seed)
    return records.find((entry) => entry.id === idOrName)
      ?? records.find((entry) => entry.name === idOrName)
  }

  async upsert(input: HumanPatch, seed: Human[] = []): Promise<Human> {
    const records = await this.load(seed)
    const next = normalizeHuman(input)
    const index = records.findIndex((entry) => entry.id === next.id)
    const merged = index >= 0
      ? { ...records[index], ...next, createdAt: records[index].createdAt }
      : next
    const updated = index >= 0
      ? records.map((entry, at) => (at === index ? merged : entry))
      : [...records, merged]
    await this.write(updated)
    return merged
  }

  async remove(id: string, seed: Human[] = []): Promise<boolean> {
    const records = await this.load(seed)
    const updated = records.filter((entry) => entry.id !== id)
    if (updated.length === records.length) return false
    await this.write(updated)
    return true
  }
}
