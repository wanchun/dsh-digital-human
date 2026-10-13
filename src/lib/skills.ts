/**
 * The plugin's skill space.
 *
 * Skills used to have one home — the deployment's global directory — so every
 * agent saw every skill and a digital human could not be given a private one. The
 * plugin keeps its own library instead, and each record names the skills it
 * mounts; a preset-scoped `ctx.skills.register` then makes them visible to that
 * digital human alone.
 *
 * A skill is a directory with a `SKILL.md` whose YAML frontmatter carries `name`
 * and `description`. Extra files beside it are resources the body may reference, so
 * they travel with the skill rather than being summarised away.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Files one skill may hold before it is refused, guarding a runaway upload. */
const MAX_SKILL_FILES = 2000

/** Bytes one skill may hold before it is refused. */
const MAX_SKILL_BYTES = 32 * 1024 * 1024

/** Directory name of the plugin's skill space, under the registry root. */
export const SKILLS_DIR = 'skills'

/** Where the plugin's skills live. */
export function libraryDir(home: string): string {
  return join(home, SKILLS_DIR)
}

/** Whether a name is a usable skill directory name. */
export function validSkillName(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
}

/**
 * Read one `SKILL.md` frontmatter block.
 *
 * The format is the one the skill loader itself reads: a leading `---` fence, then
 * `key: value` lines, where a value may continue on indented lines. Only `name`,
 * `description` and `whenToUse` are taken, because those are what a registration
 * needs — anything else stays in the body's own file.
 *
 * @returns the parsed fields; absent ones are empty strings.
 */
export function parseFrontmatter(text: string): { name: string; description: string; whenToUse: string } {
  const fields = { name: '', description: '', whenToUse: '' }
  const lines = String(text ?? '').split('\n')
  if (lines[0]?.trim() !== '---') return fields
  const end = lines.findIndex((line, at) => at > 0 && line.trim() === '---')
  if (end === -1) return fields
  let key = ''
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
    if (match) {
      key = match[1]
      // A block scalar (`|`) starts on the next line.
      const inline = match[2].trim()
      if (inline && inline !== '|' && inline !== '>') assign(fields, key, inline)
      continue
    }
    // A continuation line belongs to the key above it.
    if (key && /^\s+\S/.test(line)) append(fields, key, line.trim())
  }
  for (const field of ['name', 'description', 'whenToUse'] as const) {
    fields[field] = fields[field].replace(/\s+/g, ' ').trim()
  }
  return fields
}

/** Fold one frontmatter value into the fields a registration uses. */
function assign(fields: Record<string, string>, key: string, value: string): void {
  const target = key === 'whenToUse' || key === 'when_to_use' ? 'whenToUse' : key
  if (target in fields) fields[target] = value
}

/** Append a continuation line to the value above it. */
function append(fields: Record<string, string>, key: string, value: string): void {
  const target = key === 'whenToUse' || key === 'when_to_use' ? 'whenToUse' : key
  if (target in fields) fields[target] = `${fields[target]} ${value}`
}

/** One skill as the library reports it, without its body. */
export interface LibrarySkill {
  name: string
  description: string
  whenToUse: string
  /** Relative paths of every file in the skill, sorted. */
  files: string[]
  /** Total size in bytes. */
  bytes: number
  /** Whether the frontmatter named it; an unnamed skill takes its directory name. */
  named: boolean
}

/** One skill with its body, ready to register. */
export interface LoadedSkill extends LibrarySkill {
  /** Absolute path of the skill's own `SKILL.md`. */
  path: string
  content: string
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
 * List the plugin's skill library.
 *
 * A directory without a readable `SKILL.md` is reported as a skill whose name is
 * its directory name and whose description is empty, rather than being hidden: an
 * upload that went wrong should be visible, not silent.
 */
export function listLibrary(home: string): LibrarySkill[] {
  const root = libraryDir(home)
  if (!existsSync(root)) return []
  const found: LibrarySkill[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    let files: string[] = []
    let bytes = 0
    try {
      files = filesUnder(dir).sort()
      for (const file of files) bytes += statSync(join(dir, file)).size
    } catch {
      // An unreadable skill is still reported, so it can be removed from the page.
    }
    const parsed = readSkillFile(join(dir, 'SKILL.md'))
    found.push({
      name: parsed?.name || entry.name,
      description: parsed?.description ?? '',
      whenToUse: parsed?.whenToUse ?? '',
      files,
      bytes,
      named: Boolean(parsed?.name),
    })
  }
  return found.sort((left, right) => left.name.localeCompare(right.name))
}

/** Parse one `SKILL.md`, or undefined when it is absent or unreadable. */
function readSkillFile(path: string) {
  try {
    const text = readFileSync(path, 'utf8')
    return { ...parseFrontmatter(text), text }
  } catch {
    return undefined
  }
}

/**
 * Load the named skills, with bodies.
 *
 * @param names - the skills a record mounts, in its own order.
 * @returns one entry per name that exists; a missing name is reported so the
 *   caller can say which one is gone rather than silently mounting fewer.
 */
export function loadSkills(home: string, names: string[]): { skills: LoadedSkill[]; missing: string[] } {
  const skills: LoadedSkill[] = []
  const missing: string[] = []
  for (const name of names) {
    if (!validSkillName(name)) {
      missing.push(String(name))
      continue
    }
    const dir = join(libraryDir(home), name)
    const file = readSkillFile(join(dir, 'SKILL.md'))
    if (!file) {
      missing.push(name)
      continue
    }
    let files: string[] = []
    let bytes = 0
    try {
      files = filesUnder(dir).sort()
      for (const entry of files) bytes += statSync(join(dir, entry)).size
    } catch {
      // The body is what matters; a partial listing is not worth failing over.
    }
    skills.push({
      name: file.name || name,
      description: file.description,
      whenToUse: file.whenToUse,
      files,
      bytes,
      named: Boolean(file.name),
      path: join(dir, 'SKILL.md'),
      content: file.text,
    })
  }
  return { skills, missing }
}

/**
 * Write one skill into the library.
 *
 * @param home - the registry root.
 * @param name - the directory name; the frontmatter may name it differently.
 * @param files - relative path to text content. Every path must stay inside the
 *   skill's own directory, or an upload could write anywhere.
 */
export async function writeSkill(home: string, name: string, files: Record<string, string>): Promise<LibrarySkill> {
  if (!validSkillName(name)) throw new Error(`skill name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}: ${JSON.stringify(name)}`)
  const entries = Object.entries(files ?? {})
  if (entries.length === 0) throw new Error('a skill needs at least one file')
  if (entries.length > MAX_SKILL_FILES) throw new Error(`a skill may hold at most ${MAX_SKILL_FILES} files`)
  let bytes = 0
  for (const [path, content] of entries) {
    if (typeof content !== 'string') throw new Error(`skill file ${JSON.stringify(path)} must be text`)
    const clean = String(path).replace(/\\/g, '/').replace(/^\.\//, '')
    if (!clean || clean.startsWith('/') || clean.split('/').includes('..')) {
      throw new Error(`skill file ${JSON.stringify(path)} must stay inside the skill`)
    }
    bytes += Buffer.byteLength(content)
  }
  if (bytes > MAX_SKILL_BYTES) throw new Error(`a skill may hold at most ${MAX_SKILL_BYTES} bytes`)
  const root = libraryDir(home)
  await mkdir(root, { recursive: true })
  const dir = join(root, name)
  // Written into a fresh directory and swapped in, so a failed upload cannot leave
  // half a skill behind that the preset would then mount.
  const staging = `${dir}.${process.pid}.tmp`
  await rm(staging, { recursive: true, force: true })
  for (const [path, content] of entries) {
    const clean = String(path).replace(/\\/g, '/').replace(/^\.\//, '')
    const target = join(staging, clean)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  await rm(dir, { recursive: true, force: true })
  await rename(staging, dir)
  return listLibrary(home).find((entry) => entry.name === name || entry.files.length > 0 && entry.name === name)
    ?? { name, description: '', whenToUse: '', files: Object.keys(files), bytes, named: false }
}

/** Remove one skill from the library. */
export async function removeSkill(home: string, name: string): Promise<boolean> {
  if (!validSkillName(name)) return false
  const dir = join(libraryDir(home), name)
  if (!existsSync(dir)) return false
  await rm(dir, { recursive: true, force: true })
  return true
}
