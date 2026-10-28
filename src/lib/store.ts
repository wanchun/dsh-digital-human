/**
 * Durable registry of digital humans.
 *
 * A digital human is a directory: `persona.md` for the human-editable identity,
 * `config.json` for the machine configuration, and the per-human working state
 * (memory, session index, conversation logs) beside them. The directory is the
 * only source of truth; there is no combined registry file.
 */

import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_PERMISSION_PRESET } from './types.js'
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
export function normalizeHuman(input, now = new Date().toISOString()): Human {
  if (!input || typeof input !== 'object') throw new Error('digital human must be an object')
  const id = requireSlug(input.id, 'digital human id')
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : id
  const icon = iconValue(input.icon)
  const im = input.im && typeof input.im === 'object' ? input.im : {}
  return {
    id,
    name,
    description: typeof input.description === 'string' ? input.description : '',
    enabled: input.enabled !== false,
    systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : '',
    ...(icon === undefined ? {} : { icon }),
    workspace: typeof input.workspace === 'string' && input.workspace ? input.workspace : '',
    skills: stringList(input.skills, 'skills'),
    peers: stringList(input.peers, 'peers'),
    im: {
      botId: typeof im.botId === 'string' && im.botId ? requireSlug(im.botId, 'im.botId') : '',
      targetId: typeof im.targetId === 'string' && im.targetId ? requireTarget(im.targetId, 'im.targetId') : '',
      ...(typeof im.owner === 'string' && im.owner.trim() ? { owner: im.owner.trim() } : {}),
    },
    subscriptions: subscriptionList(input.subscriptions),
    memory: input.memory !== false,
    permissionPreset:
      typeof input.permissionPreset === 'string' && input.permissionPreset.trim()
        ? input.permissionPreset.trim()
        : DEFAULT_PERMISSION_PRESET,
    ...(configMap(input.config) === undefined ? {} : { config: configMap(input.config) }),
    ...(configSchemaList(input.configSchema).length === 0 ? {} : { configSchema: configSchemaList(input.configSchema) }),
    sessionMode: input.sessionMode === 'single' ? 'single' : 'thread',
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
    updatedAt: now,
  }
}

/** Fields the config file owns. Identity and prose live in the persona file. */
const CONFIG_FIELDS = [
  'enabled', 'workspace', 'skills', 'peers', 'im', 'permissionPreset', 'memory',
  'subscriptions', 'config', 'configSchema', 'sessionMode', 'icon', 'createdAt', 'updatedAt',
]

/** Largest icon the registry accepts, measured on the data URI itself. */
const ICON_MAX_CHARS = 64 * 1024

/** The only image forms an icon may take: a base64 data URI, never a URL. */
const ICON_DATA_URI = /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/

/** Validate one optional icon. Empty means "no icon", not "an empty icon". */
function iconValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('icon must be a string')
  const text = value.trim()
  if (!text) return undefined
  if (text.length > ICON_MAX_CHARS) throw new Error(`icon exceeds ${ICON_MAX_CHARS} characters`)
  if (!ICON_DATA_URI.test(text)) throw new Error('icon must be a base64 data URI for png, jpeg, webp or svg+xml')
  return text
}

/** Collapse a value that must stay on one frontmatter line. */
function oneLine(value): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Render the persona file: a two-key frontmatter block, then the prompt verbatim.
 *
 * The body is not touched: a prompt is authored prose, and trimming or re-wrapping
 * it would silently change what the model reads.
 */
export function personaText(human: Human): string {
  return `---\nname: ${oneLine(human.name)}\ndescription: ${oneLine(human.description)}\n---\n${human.systemPrompt}`
}

/**
 * Read a persona file back.
 *
 * Only the two keys this file owns are parsed; anything else in the block is
 * ignored. The body starts after the closing delimiter, byte for byte.
 */
export function parsePersona(text: string, id: string) {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    throw new Error(`persona for ${id} must start with a frontmatter block`)
  }
  const end = lines.findIndex((line, at) => at > 0 && line.trim() === '---')
  if (end < 0) throw new Error(`persona for ${id} has no closing frontmatter delimiter`)
  const meta: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!match) throw new Error(`persona for ${id} has a malformed line: ${JSON.stringify(line)}`)
    let value = match[2].trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    meta[match[1]] = value
  }
  return {
    name: meta.name?.trim() || '',
    description: meta.description ?? '',
    body: end + 1 < lines.length ? lines.slice(end + 1).join('\n') : '',
  }
}

/** What the config file holds for one record. */
function configOf(human: Human): Record<string, unknown> {
  return {
    enabled: human.enabled,
    workspace: human.workspace,
    skills: human.skills,
    peers: human.peers,
    im: {
      botId: human.im.botId,
      targetId: human.im.targetId,
      ...(human.im.owner ? { owner: human.im.owner } : {}),
    },
    permissionPreset: human.permissionPreset,
    sessionMode: human.sessionMode ?? 'thread',
    ...(human.icon ? { icon: human.icon } : {}),
    memory: human.memory,
    subscriptions: human.subscriptions,
    ...(human.config ? { config: human.config } : {}),
    ...(human.configSchema ? { configSchema: human.configSchema } : {}),
    createdAt: human.createdAt,
    updatedAt: human.updatedAt,
  }
}

/** The config file's text for one record. */
export function configText(human: Human): string {
  return `${JSON.stringify(configOf(human), null, 2)}\n`
}

/**
 * Compose one record from its persona and its config.
 *
 * Shared by the registry and the bundle importer: both hold the same two pieces and
 * must produce the same record, or an import would silently differ from a save.
 */
export function composeRecord(
  id: string,
  config: Record<string, unknown>,
  persona: { name: string; description: string; body: string },
): Human {
  const picked = Object.fromEntries(CONFIG_FIELDS.filter((field) => config[field] !== undefined).map((field) => [field, config[field]]))
  const normalized = normalizeHuman({
    id,
    name: persona.name || id,
    description: persona.description,
    systemPrompt: persona.body,
    ...picked,
  }, typeof config.createdAt === 'string' ? config.createdAt : undefined)
  // Reading must not rewrite history. `normalizeHuman` stamps `updatedAt` for a
  // write, so a plain load would make every record look edited just now.
  return typeof config.updatedAt === 'string' ? { ...normalized, updatedAt: config.updatedAt } : normalized
}

/**
 * Whether a record read back from disk matches the one that was written.
 *
 * Name and description live on one frontmatter line, so their internal whitespace
 * is collapsed on the way out; the comparison applies the same rule to the source
 * instead of pretending the file kept it. The prompt is compared line-ending
 * normalized for the same reason: the file is text, and a CRLF source becomes LF.
 */
function sameRecord(read: Human, source: Human): boolean {
  const shape = (human: Human) => JSON.stringify({
    ...human,
    name: oneLine(human.name),
    description: oneLine(human.description),
    systemPrompt: human.systemPrompt.replace(/\r\n/g, '\n'),
  })
  return shape(read) === shape(source)
}

/** Registry backed by one directory per human plus their private state. */
export class HumanStore {
  #home
  #humans
  /** Tail of the operation chain; see {@link #serialize}. */
  #queue = Promise.resolve()
  /** Counts writes, so one process never reuses a temp file name. */
  #writes = 0

  constructor(home: string) {
    this.#home = home
    this.#humans = join(home, 'humans')
  }

  get home() {
    return this.#home
  }

  /** The registry root: one directory per digital human. */
  get file() {
    return this.#humans
  }

  /** Root of one human's private state (record, sessions, conversations, memory). */
  dir(id) {
    return join(this.#humans, requireSlug(id, 'digital human id'))
  }

  personaPath(id) {
    return join(this.dir(id), 'persona.md')
  }

  configPath(id) {
    return join(this.dir(id), 'config.json')
  }

  memoryPath(id) {
    return join(this.dir(id), 'memory.md')
  }

  sessionIndexPath(id) {
    return join(this.dir(id), 'sessions.json')
  }

  /**
   * The append-only edge log: one line per peer message, recording which Sessions
   * talked to each other on which thread.
   *
   * It is the durable answer to "who asked me", which the thread name cannot give:
   * a name is a label shared by two agents, while an edge names both Sessions.
   */
  edgePath(id) {
    return join(this.dir(id), 'edges.jsonl')
  }

  /**
   * The work-item ledger: one line per state change, never rewritten.
   *
   * It sits beside the conversation logs it describes, so a restart reads the same
   * directory it wrote.
   */
  taskPath(id) {
    return join(this.dir(id), 'tasks.jsonl')
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

  /** Compose one record from the two files that describe it. */
  async #read(id: string): Promise<Human | undefined> {
    const personaPath = this.personaPath(id)
    const configPath = this.configPath(id)
    const hasPersona = existsSync(personaPath)
    const hasConfig = existsSync(configPath)
    if (!hasPersona && !hasConfig) return undefined
    if (!hasConfig) throw new Error(`digital human ${id} has no config.json`)
    let config: Record<string, unknown>
    try {
      config = JSON.parse(await readFile(configPath, 'utf8'))
    } catch (error) {
      throw new Error(`config.json of ${id} is not valid JSON: ${error.message}`)
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`config.json of ${id} must hold a JSON object`)
    }
    const persona = hasPersona
      ? parsePersona(await readFile(personaPath, 'utf8'), id)
      : { name: id, description: '', body: '' }
    return composeRecord(id, config, persona)
  }

  /** Write one record's two files atomically. Never call this outside {@link #serialize}. */
  async #writeRecord(human: Human) {
    const dir = this.dir(human.id)
    await this.ensureDir(dir)
    const writes = async (path: string, text: string) => {
      const temp = `${path}.${process.pid}.${++this.#writes}.tmp`
      await writeFile(temp, text, 'utf8')
      await rename(temp, path)
    }
    await writes(this.configPath(human.id), configText(human))
    await writes(this.personaPath(human.id), personaText(human))
  }

  /** Remove the two record files, leaving memory and conversation state intact. */
  async #removeRecord(id: string) {
    const remove = (path: string) => unlink(path).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
    await remove(this.personaPath(id))
    await remove(this.configPath(id))
  }

  /**
   * Read the registry. One directory per record; there is no combined file and no
   * fallback to the old one.
   *
   * A fresh registry is seeded only when the registry root does not exist yet. An
   * empty root means the operator removed every record, not that seeding should run
   * again and resurrect them.
   */
  async load(seed: Human[] = []): Promise<Human[]> {
    const records: Human[] = []
    if (existsSync(this.#humans)) {
      for (const name of readdirSync(this.#humans)) {
        if (!SLUG.test(name)) continue
        const full = join(this.#humans, name)
        try {
          if (!statSync(full).isDirectory()) continue
        } catch {
          continue
        }
        const record = await this.#read(name)
        if (record) records.push(record)
      }
    }
    records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id))
    // A legacy file and no directories is the one state this code refuses to guess
    // at: reading it would be the fallback the split removed, and starting empty
    // would look like every digital human was deleted. Say what to run instead.
    if (records.length === 0 && existsSync(this.legacyPath())) {
      throw new Error('a legacy humans.json is present; run "node tools/migrate.mjs" before starting')
    }
    if (records.length === 0 && !existsSync(this.#humans)) {
      for (const entry of seed) {
        const record = normalizeHuman(entry)
        await this.#writeRecord(record)
        records.push(record)
      }
    }
    return records
  }

  /** The legacy combined registry, when a deployment still has one. */
  legacyPath() {
    return join(this.#home, 'humans.json')
  }

  /**
   * Read the legacy combined registry.
   *
   * A separate path from `load`: normal reads never fall back to the old file, so
   * a host that starts before migration cannot mistake stale data for the truth.
   * Only the migration command calls this.
   */
  async readLegacy(): Promise<Human[]> {
    const path = this.legacyPath()
    if (!existsSync(path)) return []
    let parsed
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      throw new Error(`legacy registry is not valid JSON: ${error.message}`)
    }
    if (!Array.isArray(parsed)) throw new Error('legacy registry must hold a JSON array')
    return parsed.map((entry) => {
      const normalized = normalizeHuman(entry, entry?.createdAt)
      return typeof entry?.updatedAt === 'string' ? { ...normalized, updatedAt: entry.updatedAt } : normalized
    })
  }

  /** Copy the legacy file aside, stamping the backup with the moment it was taken. */
  async #backupLegacy() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = `${this.legacyPath()}.legacy-${stamp}`
    await copyFile(this.legacyPath(), target)
    return target
  }

  /**
   * Migrate the legacy combined registry into record directories.
   *
   * The legacy file is deleted only after every record has been written back and
   * read again field for field, so a partial migration leaves the source intact.
   * A target directory that already holds a record aborts the run before anything
   * is written: a migration must never overwrite a record someone already edited.
   *
   * @param options.dryRun - report the plan without writing, backing up or deleting.
   */
  migrateLegacy({ dryRun = false } = {}): Promise<{
    dryRun: boolean
    records: Array<{ id: string; dir: string }>
    backup?: string
    removed?: string
    reason?: string
  }> {
    return this.#serialize(async () => {
      const path = this.legacyPath()
      if (!existsSync(path)) return { dryRun, records: [] as Array<{ id: string; dir: string }>, reason: 'no legacy registry' }
      const records = await this.readLegacy()
      const plan = records.map((entry) => ({ id: entry.id, dir: this.dir(entry.id) }))
      const conflicts = records.filter((entry) => existsSync(this.personaPath(entry.id)) || existsSync(this.configPath(entry.id)))
      if (conflicts.length > 0) {
        throw new Error(`refusing to migrate: ${conflicts.map((entry) => entry.id).join(', ')} already has a record directory`)
      }
      if (dryRun) return { dryRun, records: plan }
      const backup = await this.#backupLegacy()
      const written: string[] = []
      try {
        for (const record of records) {
          await this.#writeRecord(record)
          written.push(record.id)
          const read = await this.#read(record.id)
          if (read === undefined || !sameRecord(read, record)) {
            throw new Error(`record ${record.id} did not round-trip`)
          }
        }
      } catch (error) {
        for (const id of written) await this.#removeRecord(id)
        throw new Error(`migration aborted, legacy registry kept: ${error.message}`)
      }
      await unlink(path)
      return { dryRun, records: plan, backup, removed: path }
    })
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

  /** Replace the whole registry: write every record, drop the ones no longer listed. */
  write(records) {
    return this.#serialize(async () => {
      const wanted = records.map((entry) => normalizeHuman(entry))
      const ids = new Set(wanted.map((entry) => entry.id))
      if (existsSync(this.#humans)) {
        for (const name of readdirSync(this.#humans)) {
          if (!SLUG.test(name) || ids.has(name)) continue
          await this.#removeRecord(name)
        }
      }
      for (const record of wanted) await this.#writeRecord(record)
      return wanted
    })
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
      // An optional field the caller cleared must not survive the merge: the
      // normalizer omits an empty icon, so spreading would keep the stored one.
      if (typeof input.icon === 'string' && input.icon.trim() === '') delete merged.icon
      await this.#writeRecord(merged)
      return merged
    })
  }

  remove(id: string, seed: Human[] = []): Promise<boolean> {
    return this.#serialize(async () => {
      const records = await this.load(seed)
      if (!records.some((entry) => entry.id === id)) return false
      await this.#removeRecord(id)
      return true
    })
  }
}
