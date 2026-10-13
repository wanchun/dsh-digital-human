/**
 * Durable registry of digital humans.
 *
 * A digital human is a record, not a plugin row: the registry file is the only
 * source of truth, so humans are created, edited, paused, and deleted without
 * touching a composition. `humans.json` is small and human-editable on purpose;
 * per-human working state lives beside it under `humans/<id>/`.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Human, HumanPatch } from './types.js'

/** Identifier shape shared by ids, conversation ids, and IM bot ids. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Identifier shape of an IM target, which is the IM platform's own grammar.
 *
 * Deliberately looser than {@link SLUG}: a real target carries `:` and `@`
 * (`direct:…`, `@user:host`), so the stricter shape would refuse to store a target
 * the IM plugin itself sends to happily.
 */
const IM_TARGET = /^[A-Za-z0-9._:@-]{1,128}$/

/** Fail loud on an IM target the platform itself would not accept. */
function requireTarget(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IM_TARGET.test(value)) {
    throw new Error(`${label} must match ${IM_TARGET}: ${JSON.stringify(value)}`)
  }
  return value
}

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

/**
 * Read the free-form config bag.
 *
 * A persona names its own keys, so nothing here is validated against a schema.
 * Keys and values are trimmed and an entry with no value is dropped: that keeps
 * "unset" distinguishable from "set to empty", which is the distinction a persona
 * relies on when it falls back to a role term.
 *
 * @returns the map, or undefined when nothing is configured.
 */
function configMap(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('config must be an object')
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    const name = key.trim()
    const text = typeof entry === 'string' ? entry.trim() : ''
    if (name && text) out[name] = text
  }
  return Object.keys(out).length > 0 ? out : undefined
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

/** Field kinds the settings page knows how to render. */
const CONFIG_FIELD_TYPES = ['text', 'number', 'boolean', 'select']

/**
 * Platform facts a declared field may resolve from.
 *
 * Kept in step with `builtinConfig` in `presets.ts`: a name accepted here but not
 * supplied there would silently resolve to nothing.
 */
const CONFIG_FIELD_FACTS = ['self_name', 'self_id', 'owner_id', 'owner_chat', 'peer_name', 'peer_id']

/**
 * Read the declared config schema.
 *
 * A declaration is authored configuration, so a malformed one fails loudly rather
 * than being dropped: a silently ignored field would leave a persona reading a
 * placeholder that never resolves, which is far harder to notice than a save that
 * refuses.
 */
function configSchemaList(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('configSchema must be an array')
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('configSchema entries must be objects')
    const key = typeof entry.key === 'string' ? entry.key.trim() : ''
    if (!key) throw new Error('configSchema entries need a key')
    if (entry.type !== undefined && !CONFIG_FIELD_TYPES.includes(entry.type)) {
      throw new Error(`configSchema field ${key} has an unknown type: ${JSON.stringify(entry.type)}`)
    }
    if (entry.from !== undefined && !CONFIG_FIELD_FACTS.includes(entry.from)) {
      throw new Error(`configSchema field ${key} has an unknown source: ${JSON.stringify(entry.from)}`)
    }
    const options = Array.isArray(entry.options)
      ? entry.options.map((option) => {
        if (!option || typeof option !== 'object') throw new Error(`configSchema field ${key} has a malformed option`)
        const label = typeof option.label === 'string' ? option.label.trim() : ''
        const optionValue = typeof option.value === 'string' ? option.value.trim() : ''
        if (!label || !optionValue) throw new Error(`configSchema field ${key} has an option with no label or value`)
        return { label, value: optionValue }
      })
      : []
    return {
      key,
      ...(typeof entry.label === 'string' && entry.label.trim() ? { label: entry.label.trim() } : {}),
      ...(entry.type === undefined ? {} : { type: entry.type }),
      ...(typeof entry.description === 'string' && entry.description.trim() ? { description: entry.description.trim() } : {}),
      // Trimmed like every other declared string: an untrimmed default would reach
      // the prompt with its padding intact.
      ...(typeof entry.default === 'string' && entry.default.trim() ? { default: entry.default.trim() } : {}),
      ...(entry.required === true ? { required: true } : {}),
      ...(entry.hidden === true ? { hidden: true } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(entry.from === undefined ? {} : { from: entry.from }),
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
  return {
    id,
    name,
    description: typeof input.description === 'string' ? input.description : '',
    enabled: input.enabled !== false,
    systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : '',
    workspace: typeof input.workspace === 'string' && input.workspace ? input.workspace : '',
    skills: stringList(input.skills, 'skills'),
    peers: stringList(input.peers, 'peers'),
    im: {
      botId: typeof im.botId === 'string' && im.botId ? requireSlug(im.botId, 'im.botId') : '',
      targetId: typeof im.targetId === 'string' && im.targetId ? requireTarget(im.targetId, 'im.targetId') : '',
      // An owner is an IM sender id or a display name. Both are opaque and may
      // carry uppercase and separators, so neither goes through requireSlug —
      // the same rule that would reject the real sender id.
      ...(typeof im.owner === 'string' && im.owner.trim() ? { owner: im.owner.trim() } : {}),
    },
    subscriptions: subscriptionList(input.subscriptions),
    memory: input.memory !== false,
    // Absent means "the platform default", which the platform resolves. Storing
    // an empty string would make a record claim a preset that does not exist.
    ...(typeof input.permissionPreset === 'string' && input.permissionPreset.trim()
      ? { permissionPreset: input.permissionPreset.trim() }
      : {}),
    ...(configMap(input.config) === undefined ? {} : { config: configMap(input.config) }),
    ...(configSchemaList(input.configSchema).length === 0 ? {} : { configSchema: configSchemaList(input.configSchema) }),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
    updatedAt: now,
  }
}

/** Registry backed by one JSON document plus a per-human state directory. */
export class HumanStore {
  #home
  #file
  #cache
  /** Modification time of the file behind {@link #cache}. */
  #cachedAt
  /** Tail of the operation chain; see {@link #serialize}. */
  #queue = Promise.resolve()
  /** Counts writes, so one process never reuses a temp file name. */
  #writes = 0

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

  /** The file's modification time, or undefined when it is absent. */
  #mtime(): number | undefined {
    try {
      return statSync(this.#file).mtimeMs
    } catch {
      return undefined
    }
  }

  /**
   * Read the registry, creating it from `seed` on first use.
   *
   * The cache is keyed to the file's modification time rather than held
   * forever. `humans.json` is a plain JSON file that people edit by hand, and a
   * permanent cache both hides those edits and lets the next save overwrite
   * them from the stale copy.
   */
  async load(seed: Human[] = []): Promise<Human[]> {
    const stamp = this.#mtime()
    if (this.#cache && stamp !== undefined && stamp === this.#cachedAt) return this.#cache
    if (stamp === undefined) {
      const records = seed.map((entry) => normalizeHuman(entry))
      // The unqueued write, because this can run inside a queued operation: a save
      // reads before it writes, and a queued write here would wait on the very
      // operation that is waiting on it.
      await this.#writeNow(records)
      this.#cache = records
      this.#cachedAt = this.#mtime()
      return records
    }
    const raw = await readFile(this.#file, 'utf8')
    const parsed = raw.trim() ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) throw new Error(`${this.#file} must hold a JSON array`)
    const records = parsed.map((entry) => {
      const normalized = normalizeHuman(entry, entry?.createdAt)
      // Reading must not rewrite history. `normalizeHuman` stamps `updatedAt` for a
      // write, so a plain load would make every record look edited just now and
      // erase the stored value in memory.
      return typeof entry?.updatedAt === 'string' ? { ...normalized, updatedAt: entry.updatedAt } : normalized
    })
    this.#cache = records
    this.#cachedAt = stamp
    return records
  }

  /**
   * Run one registry operation to completion before the next one starts.
   *
   * A read-modify-write is only atomic if the read is inside the same critical
   * section as the write. Two saves racing — an operator's and a startup claim's,
   * for instance — otherwise both read the same base and the second silently
   * discards the first.
   */
  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const run: Promise<T> = this.#queue.then(work, work)
    // The chain must survive a failed operation, or every later one is skipped.
    this.#queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Replace the whole registry atomically. */
  write(records) {
    return this.#serialize(() => this.#writeNow(records))
  }

  /** The write itself. Never call this outside {@link #serialize}. */
  async #writeNow(records) {
    await this.ensureDir(dirname(this.#file))
    // The sequence number is what makes the temp name unique within a process: a
    // per-pid name lets two writers in the same process rename over each other,
    // and one of them then fails with ENOENT.
    const temp = `${this.#file}.${process.pid}.${++this.#writes}.tmp`
    await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
    await rename(temp, this.#file)
    this.#cache = records
    this.#cachedAt = this.#mtime()
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

  upsert(input: HumanPatch, seed: Human[] = []): Promise<Human> {
    return this.#serialize(async () => {
      const records = await this.load(seed)
      const next = normalizeHuman(input)
      const index = records.findIndex((entry) => entry.id === next.id)
      const merged = index >= 0
        ? { ...records[index], ...next, createdAt: records[index].createdAt }
        : next
      const updated = index >= 0
        ? records.map((entry, at) => (at === index ? merged : entry))
        : [...records, merged]
      await this.#writeNow(updated)
      return merged
    })
  }

  remove(id: string, seed: Human[] = []): Promise<boolean> {
    return this.#serialize(async () => {
      const records = await this.load(seed)
      const updated = records.filter((entry) => entry.id !== id)
      if (updated.length === records.length) return false
      await this.#writeNow(updated)
      return true
    })
  }
}
