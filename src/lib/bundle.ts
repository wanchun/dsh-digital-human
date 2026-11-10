/**
 * Import and export of one digital human, as a `.tar.gz` bundle.
 *
 * A record is not enough to move a digital human: its persona, its declared config
 * and — optionally — its memory belong to it. A single JSON file could not say which
 * half is the human-editable prose, so the bundle keeps the same two files the
 * registry keeps.
 *
 * Skills are not part of a bundle. They live in the deployment's global root,
 * installed by hand, so the record travels with the list of names it enables and
 * the behaviour of those skills is the destination machine's business.
 *
 * The container is `tar` + `gzip`, both written with node builtins: the package
 * keeps zero runtime dependencies, and the result is a file anyone can inspect with
 * `tar tzf` before importing it. An import is a prompt someone will follow, so being
 * able to read the package first matters.
 *
 * Bundle layout:
 * ```
 * manifest.json              format, exported time, the ids it carries, contents
 * humans/<id>/persona.md     one persona each, with local-only fields stripped
 * humans/<id>/config.json    the machine configuration beside it
 * memory/<id>.md             optional
 * ```
 *
 * An older bundle carries `humans/<id>.json` instead of the two files; the reader
 * accepts both so a package exported before the split still imports.
 *
 * A bundle carries one or many: an export of the whole registry is the same shape as
 * an export of a single record, so an import never has to ask which kind it got.
 */

import { gunzipSync, gzipSync } from 'node:zlib'
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Human } from './types.js'
import { composeRecord, configText, normalizeHuman, parsePersona, personaText, requireSlug } from './store.js'

/** A skill directory name the installer accepts: no separators, no traversal. */
const SKILL_NAME = /^[A-Za-z0-9._-]+$/

/** Bundle format identifier, so a foreign archive is refused rather than guessed at. */
export const BUNDLE_FORMAT = 'dsh-digital-human/2'

/** Layouts this reader understands: the current one and the combined-record one. */
const SUPPORTED_FORMATS = new Set([BUNDLE_FORMAT, 'dsh-digital-human/1'])

/** Files one bundle may hold before it is refused. */
const MAX_BUNDLE_FILES = 5000

/** Bytes one bundle may hold before it is refused. */
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024

/** Bytes in one tar block. */
const BLOCK = 512

/** Write one octal field, NUL-terminated, as tar wants it. */
function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`
}

/**
 * One tar header block.
 *
 * A path longer than the name field moves its leading directories into `prefix`,
 * which the format provides for exactly that. A path that fits neither is refused
 * rather than truncated, because a truncated path would unpack somewhere else.
 */
function header(name: string, size: number, mode: number): Buffer {
  const path = name.replace(/\\/g, '/').replace(/^\/+/, '')
  let prefix = ''
  let base = path
  if (Buffer.byteLength(path) > 100) {
    // The split is the LAST slash whose left half fits the prefix field and whose
    // right half fits the name field. Searching backwards from a fixed offset finds
    // the wrong one on a deeply nested path, and a wrong split writes the file
    // somewhere else on unpack.
    const cut = path.lastIndexOf('/')
    if (cut <= 0 || Buffer.byteLength(path.slice(cut + 1)) > 100 || Buffer.byteLength(path.slice(0, cut)) > 155) {
      throw new Error(`bundle path is too long for a tar header: ${JSON.stringify(name)}`)
    }
    prefix = path.slice(0, cut)
    base = path.slice(cut + 1)
  }
  const block = Buffer.alloc(BLOCK)
  block.write(base, 0, 100, 'utf8')
  block.write(octal(mode, 8), 100, 8, 'utf8')
  block.write(octal(0, 8), 108, 8, 'utf8')
  block.write(octal(0, 8), 116, 8, 'utf8')
  block.write(octal(size, 12), 124, 12, 'utf8')
  block.write(octal(Math.floor(Date.now() / 1000), 12), 136, 12, 'utf8')
  // The checksum field is read as spaces while the sum is taken, then written.
  block.write('        ', 148, 8, 'utf8')
  block.write('0', 156, 1, 'utf8')
  block.write('ustar\0', 257, 6, 'utf8')
  block.write('00', 263, 2, 'utf8')
  block.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  return block
}

/** Pack a path-to-bytes map into an uncompressed tar archive. */
export function writeTar(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    parts.push(header(name, content.length, 0o644))
    parts.push(content)
    const remainder = content.length % BLOCK
    if (remainder !== 0) parts.push(Buffer.alloc(BLOCK - remainder))
  }
  // Two empty blocks end an archive.
  parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}

/**
 * Read a tar archive into a path-to-bytes map.
 *
 * Only the regular-file and directory entries are taken; anything else (a link, a
 * device) is skipped rather than followed, so an archive cannot write outside the
 * directory it is unpacked into.
 */
export function readTar(archive: Buffer): Record<string, Buffer> {
  const files: Record<string, Buffer> = {}
  let at = 0
  while (at + BLOCK <= archive.length) {
    const block = archive.subarray(at, at + BLOCK)
    at += BLOCK
    // A zero block marks the end of the archive.
    if (block.every((byte) => byte === 0)) break
    const text = (from: number, length: number) =>
      block.subarray(from, from + length).toString('utf8').replace(/\0.*$/, '').trim()
    const name = text(0, 100)
    const prefix = text(345, 155)
    const size = parseInt(text(124, 12) || '0', 8) || 0
    const type = text(156, 1)
    const path = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '')
    const content = archive.subarray(at, at + size)
    at += Math.ceil(size / BLOCK) * BLOCK
    if (!path) continue
    if (type === '5') {
      files[`${path.replace(/\/$/, '')}/`] = Buffer.alloc(0)
      continue
    }
    if (type !== '' && type !== '0') continue
    files[path] = Buffer.from(content)
  }
  return files
}

/** One bundle's manifest. */
export interface BundleManifest {
  format: string
  exportedAt: string
  /** The records the bundle carries, in the order they were written. */
  humans: Array<{ id: string; name: string }>
  /** Whether the bundle carries any memory file. */
  memory: boolean
}

/** What a bundle holds, as the import page shows it before anything is written. */
export interface BundlePreview {
  manifest: BundleManifest
  /** Every record the bundle carries. */
  humans: Human[]
  bytes: number
}

/**
 * Pack one digital human.
 *
 * @param home - the registry root.
 * @param human - the record to pack.
 * @param options.includeMemory - whether to carry the memory file.
 * @returns the gzipped archive, and the manifest it embeds.
 */

/** Every regular file under one directory, in a stable order. */
function walkFiles(dir: string): string[] {
  const out: string[] = []
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name)
      const stat = statSync(full)
      if (stat.isDirectory()) visit(full)
      else if (stat.isFile()) out.push(full)
    }
  }
  visit(dir)
  return out
}

export function packHumans(
  home: string,
  humans: Human[],
  { includeMemory = false, skillsRoot }: { includeMemory?: boolean; skillsRoot?: string } = {},
): { archive: Buffer; manifest: BundleManifest } {
  if (humans.length === 0) throw new Error('there is no digital human to export')
  const files: Record<string, Buffer> = {}
  const records = humans.map((entry) => normalizeHuman(entry))
  for (const human of records) {
    // A binding is the machine's, not the record's: the bot id, its default target
    // and the claimed owner all name things that do not exist elsewhere. Writing
    // empty fields rather than deleting them keeps the config shape stable.
    const stripped: Human = { ...human, im: { botId: '', targetId: '' } }
    files[`humans/${human.id}/persona.md`] = Buffer.from(personaText(stripped), 'utf8')
    files[`humans/${human.id}/config.json`] = Buffer.from(configText(stripped), 'utf8')
  }

  // A record names the skills it may use, and a skill is a directory of files. Without
  // them the import lands on a machine where the whitelist points at nothing, so the
  // bundle carries the named ones and the import installs them into the global root.
  const skillNames = skillsRoot === undefined
    ? []
    : [...new Set(records.flatMap((human) => human.skills ?? []))].sort()
  for (const name of skillNames) {
    const dir = join(skillsRoot as string, name)
    if (!existsSync(dir)) continue
    for (const file of walkFiles(dir)) {
      const relative = file.slice(dir.length + 1)
      files[`skills/${name}/${relative}`] = readFileSync(file)
    }
  }

  let memory = false
  if (includeMemory) {
    for (const human of records) {
      const memoryPath = join(home, 'humans', human.id, 'memory.md')
      if (!existsSync(memoryPath)) continue
      files[`memory/${human.id}.md`] = readFileSync(memoryPath)
      memory = true
    }
  }

  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    humans: records.map((human) => ({ id: human.id, name: human.name })),
    memory,
  }
  files['manifest.json'] = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { archive: gzipSync(writeTar(files)), manifest }
}

/**
 * Read a bundle without writing anything.
 *
 * The page shows this before an import, because importing runs someone else's
 * prompt: the contents have to be visible first.
 */
export function readBundle(archive: Buffer): BundlePreview {
  if (!Buffer.isBuffer(archive) || archive.length === 0) throw new Error('the bundle is empty')
  if (archive.length > MAX_BUNDLE_BYTES) throw new Error(`a bundle may hold at most ${MAX_BUNDLE_BYTES} bytes`)
  let files: Record<string, Buffer>
  try {
    files = readTar(gunzipSync(archive))
  } catch (error) {
    throw new Error(`the bundle is not a readable .tar.gz: ${error.message}`)
  }
  if (Object.keys(files).length > MAX_BUNDLE_FILES) throw new Error(`a bundle may hold at most ${MAX_BUNDLE_FILES} files`)
  const manifestText = files['manifest.json']?.toString('utf8')
  if (!manifestText) throw new Error('the bundle has no manifest.json')
  let manifest: BundleManifest
  try {
    manifest = JSON.parse(manifestText)
  } catch (error) {
    throw new Error(`the bundle's JSON is unreadable: ${error.message}`)
  }
  if (!SUPPORTED_FORMATS.has(manifest?.format)) {
    throw new Error(`unsupported bundle format ${JSON.stringify(manifest?.format)}; expected ${BUNDLE_FORMAT}`)
  }
  const humans: Human[] = []
  // Current layout: one directory per record.
  for (const [path, content] of Object.entries(files)) {
    const match = /^humans\/([^/]+)\/config\.json$/.exec(path)
    if (!match) continue
    const id = match[1]
    let config: Record<string, unknown>
    try {
      config = JSON.parse(content.toString('utf8'))
    } catch (error) {
      throw new Error(`the config in ${path} is unreadable: ${error.message}`)
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`the bundle holds no usable digital human record at ${path}`)
    }
    const personaFile = files[`humans/${id}/persona.md`]
    const persona = personaFile
      ? parsePersona(personaFile.toString('utf8'), id)
      : { name: id, description: '', body: '' }
    humans.push(composeRecord(id, config, persona))
  }
  // Older layout: one combined record per file.
  if (humans.length === 0) {
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith('humans/') || !path.endsWith('.json')) continue
      let record: Human
      try {
        record = JSON.parse(content.toString('utf8'))
      } catch (error) {
        throw new Error(`the record in ${path} is unreadable: ${error.message}`)
      }
      if (!record || typeof record !== 'object' || typeof record.id !== 'string') {
        throw new Error(`the bundle holds no usable digital human record at ${path}`)
      }
      humans.push(record)
    }
  }
  if (humans.length === 0) throw new Error('the bundle holds no digital human record')
  // A package exported by an older version may still hold a `skills/` tree. Its
  // files are read and ignored: skills are installed by hand now, so an import must
  // not write into a root the operator owns.
  return { manifest, humans, bytes: archive.length }
}

/** What an import did, so the page can report it rather than guess. */
export interface ImportResult {
  /** The ids the records were written under, in the bundle's order. */
  ids: string[]
  /** Whether any id differs from the one the bundle carried. */
  renamed: boolean
  memory: boolean
  /** Skills written into the global root, and those already there that were left alone. */
  skills?: { installed: string[]; kept: string[] }
  /** The records to store, with the ids the import actually used. */
  records: Human[]
}

/**
 * Write one bundle's contents into the registry.
 *
 * The records and the memory are written here. A skill the bundle carries is
 * installed into the machine's global root, because that root is where a record's
 * whitelist resolves; a skill already present is left as this machine has it.
 *
 * @param home - the registry root.
 * @param archive - the uploaded bundle, holding one record or many.
 * @param options.id - an id to write a **single-record** bundle under.
 * @returns what was written.
 */
export async function unpackHumans(
  home: string,
  archive: Buffer,
  { id, skillsRoot }: { id?: string; skillsRoot?: string } = {},
): Promise<ImportResult> {
  const preview = readBundle(archive)
  if (id !== undefined && preview.humans.length !== 1) {
    throw new Error('an id can only be given when the bundle holds exactly one digital human')
  }
  const files = readTar(gunzipSync(archive))
  const records: Human[] = []
  let memory = false
  for (const carried of preview.humans) {
    const target = id ?? carried.id
    requireSlug(target, 'digital human id')
    records.push({ ...carried, id: target })
    const memoryFile = files[`memory/${carried.id}.md`]
    if (memoryFile) {
      const dir = join(home, 'humans', target)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'memory.md'), memoryFile.toString('utf8'), 'utf8')
      memory = true
    }
  }
  // A skill already on this machine is this machine's: importing must not rewrite prose
  // someone edited here. Missing ones are installed, so the whitelist the records carry
  // points at real directories after an import.
  const installed: string[] = []
  const kept: string[] = []
  if (skillsRoot !== undefined) {
    for (const [name, body] of Object.entries(files)) {
      if (!name.startsWith('skills/')) continue
      const rest = name.slice('skills/'.length)
      const slash = rest.indexOf('/')
      if (slash <= 0) continue
      const skill = rest.slice(0, slash)
      if (!SKILL_NAME.test(skill)) continue
      if (existsSync(join(skillsRoot, skill)) && !installed.includes(skill)) {
        if (!kept.includes(skill)) kept.push(skill)
        continue
      }
      const target = join(skillsRoot, skill, rest.slice(slash + 1))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, body)
      if (!installed.includes(skill)) installed.push(skill)
    }
  }
  return {
    ids: records.map((record) => record.id),
    renamed: records.some((record, at) => record.id !== preview.humans[at].id),
    memory,
    skills: { installed: installed.sort(), kept: kept.sort() },
    records,
  }
}
