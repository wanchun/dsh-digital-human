/**
 * Import and export of one digital human, as a `.tar.gz` bundle.
 *
 * A record is not enough to move a digital human: its persona, its declared config,
 * its mounted skills and — optionally — its memory all belong to it. A single JSON
 * file could hold the record but not the skills, which are directory trees that may
 * carry binary resources.
 *
 * The container is `tar` + `gzip`, both written with node builtins: the package
 * keeps zero runtime dependencies, and the result is a file anyone can inspect with
 * `tar tzf` before importing it. An import is a prompt someone will follow, so being
 * able to read the package first matters.
 *
 * Bundle layout:
 * ```
 * manifest.json      format, version, exported time, contents
 * human.json         the record, with local-only fields stripped
 * memory.md          optional
 * skills/<name>/…    one directory per mounted skill
 * ```
 */

import { gunzipSync, gzipSync } from 'node:zlib'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Human } from './types.js'
import { libraryDir, validSkillName } from './skills.js'

/** Bundle format identifier, so a foreign archive is refused rather than guessed at. */
export const BUNDLE_FORMAT = 'dsh-digital-human/1'

/** Files one bundle may hold before it is refused. */
const MAX_BUNDLE_FILES = 5000

/** Bytes one bundle may hold before it is refused. */
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024

/** Bytes in one tar block. */
const BLOCK = 512

/** Fields a record carries that only mean something on the machine it came from. */
const LOCAL_ONLY = ['owner', 'targetId', 'botId'] as const

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
  id: string
  name: string
  /** Whether the bundle carries the memory file. */
  memory: boolean
  /** The skills it carries, by name. */
  skills: string[]
}

/** What a bundle holds, as the import page shows it before anything is written. */
export interface BundlePreview {
  manifest: BundleManifest
  human: Human
  /** Files per skill, for a size-and-shape summary. */
  skills: Array<{ name: string; files: number; bytes: number }>
  bytes: number
}

/** Every file under one directory, as paths relative to it. */
function filesUnder(root: string, at = root): string[] {
  const found: string[] = []
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const path = join(at, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(root, path))
    else if (entry.isFile()) found.push(path.slice(root.length + 1))
  }
  return found
}

/**
 * Pack one digital human.
 *
 * @param home - the registry root.
 * @param human - the record to pack.
 * @param options.includeMemory - whether to carry the memory file.
 * @returns the gzipped archive, and the manifest it embeds.
 */
export function packHuman(
  home: string,
  human: Human,
  { includeMemory = false }: { includeMemory?: boolean } = {},
): { archive: Buffer; manifest: BundleManifest } {
  const files: Record<string, Buffer> = {}
  const record = { ...human } as Record<string, unknown>
  if (record.im && typeof record.im === 'object') {
    // A binding is the machine's, not the record's: the bot id, its default target
    // and the claimed owner all name things that do not exist elsewhere.
    const im = { ...(record.im as Record<string, unknown>) }
    for (const field of LOCAL_ONLY) delete im[field]
    record.im = im
  }
  files['human.json'] = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8')

  const carried: string[] = []
  for (const name of human.skills ?? []) {
    if (!validSkillName(name)) continue
    const dir = join(libraryDir(home), name)
    if (!existsSync(dir)) continue
    const members = filesUnder(dir)
    // A skill with no files is not a skill: listing it would promise something the
    // bundle does not hold, and the import would silently mount nothing.
    if (members.length === 0) continue
    carried.push(name)
    for (const relative of members) {
      files[`skills/${name}/${relative}`] = readFileSync(join(dir, relative))
    }
  }

  const memoryPath = join(home, 'humans', human.id, 'memory.md')
  const memory = includeMemory && existsSync(memoryPath)
  if (memory) files['memory.md'] = readFileSync(memoryPath)

  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    id: human.id,
    name: human.name,
    memory,
    skills: carried,
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
  const humanText = files['human.json']?.toString('utf8')
  if (!manifestText || !humanText) throw new Error('the bundle has no manifest.json or human.json')
  let manifest: BundleManifest
  let human: Human
  try {
    manifest = JSON.parse(manifestText)
    human = JSON.parse(humanText)
  } catch (error) {
    throw new Error(`the bundle's JSON is unreadable: ${error.message}`)
  }
  if (manifest?.format !== BUNDLE_FORMAT) {
    throw new Error(`unsupported bundle format ${JSON.stringify(manifest?.format)}; expected ${BUNDLE_FORMAT}`)
  }
  if (!human || typeof human !== 'object' || typeof human.id !== 'string') {
    throw new Error('the bundle holds no usable digital human record')
  }
  const bySkill = new Map<string, { files: number; bytes: number }>()
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith('skills/')) continue
    const name = path.split('/')[1]
    if (!name) continue
    const entry = bySkill.get(name) ?? { files: 0, bytes: 0 }
    entry.files += 1
    entry.bytes += content.length
    bySkill.set(name, entry)
  }
  return {
    manifest,
    human,
    skills: [...bySkill].map(([name, entry]) => ({ name, ...entry })),
    bytes: archive.length,
  }
}

/** What an import did, so the page can report it rather than guess. */
export interface ImportResult {
  id: string
  /** The id the record was written under, which may differ when it was renamed. */
  renamed: boolean
  skills: string[]
  memory: boolean
  /** The record to store, with the ids the import actually used. */
  record: Human
}

/**
 * Write one bundle's contents into the registry.
 *
 * @param home - the registry root.
 * @param archive - the uploaded bundle.
 * @param options.id - the id to write under, overriding the bundle's own.
 * @param options.overwrite - whether an existing skill of the same name is replaced.
 * @returns what was written.
 */
export async function unpackHuman(
  home: string,
  archive: Buffer,
  { id, overwrite = true }: { id?: string; overwrite?: boolean } = {},
): Promise<ImportResult> {
  const preview = readBundle(archive)
  const target = String(id ?? preview.human.id).trim()
  if (!validSkillName(target)) throw new Error(`id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}: ${JSON.stringify(target)}`)
  const files = readTar(gunzipSync(archive))
  const written: string[] = []
  for (const skill of preview.skills) {
    const prefix = `skills/${skill.name}/`
    const entries: Record<string, string> = {}
    let binary = false
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith(prefix) || path === prefix) continue
      // A skill the plugin can mount is text: a binary resource would be registered
      // as mojibake, so it is reported instead of silently mangled.
      if (content.includes(0)) {
        binary = true
        continue
      }
      entries[path.slice(prefix.length)] = content.toString('utf8')
    }
    if (binary) throw new Error(`skill ${JSON.stringify(skill.name)} carries a binary file, which the skill space does not hold`)
    if (Object.keys(entries).length === 0) continue
    const dir = join(libraryDir(home), skill.name)
    if (existsSync(dir) && !overwrite) continue
    const staging = `${dir}.${process.pid}.tmp`
    await rm(staging, { recursive: true, force: true })
    for (const [path, content] of Object.entries(entries)) {
      const target2 = join(staging, path)
      await mkdir(dirname(target2), { recursive: true })
      await writeFile(target2, content, 'utf8')
    }
    await rm(dir, { recursive: true, force: true })
    await rename(staging, dir)
    written.push(skill.name)
  }
  const record = { ...preview.human, id: target, skills: written }
  const memory = files['memory.md']
  if (memory) {
    const dir = join(home, 'humans', target)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'memory.md'), memory.toString('utf8'), 'utf8')
  }
  return { id: target, renamed: target !== preview.human.id, skills: written, memory: Boolean(memory), record }
}
