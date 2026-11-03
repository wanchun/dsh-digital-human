/**
 * The global skill catalog.
 *
 * A skill has one home: the deployment's shared agent root, `~/.agents/skills`.
 * The operator installs a skill by hand, by copying its directory there, so this
 * module reads that root and never writes it. A skill is a directory with a
 * `SKILL.md` whose YAML frontmatter carries `name` and `description`.
 *
 * Two facts are read from one persona here as well: the skills it declares as
 * dependencies. The declaration is one line per skill, `依赖技能：<名字>`, so the
 * check needs no vocabulary of its own and matches no skill name in code.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Directory under the agents home that holds one directory per skill. */
export const SKILLS_DIR = 'skills'

/**
 * Skills whose rules the plugin carries itself.
 *
 * The rule is structural, not a preference: if a record cannot work without a
 * skill, that skill is mechanism, not a choice. Its rules travel in the operating
 * context every record gets, so the catalog never offers the name and a record's
 * list never has to mention it.
 */
const BUILTIN_SKILLS: readonly string[] = Object.freeze(['digital-human-comms'])

/** Whether a name is the plugin's own mechanism rather than a selectable skill. */
export function isBuiltinSkill(name: string): boolean {
  return BUILTIN_SKILLS.includes(name)
}

/**
 * Resolve the global skill root.
 *
 * Precedence mirrors the Harness's own agents-home resolution: an explicit value,
 * then `$DSH_AGENTS_HOME`, then `~/.agents`. The explicit value names the skills
 * directory itself, so a sandbox can point at its own root without owning the
 * deployment's.
 *
 * @param configured - an explicit skills root.
 * @param env - environment mapping used to read `DSH_AGENTS_HOME`.
 */
export function globalSkillsDir(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = typeof configured === 'string' && configured.trim() ? configured.trim() : undefined
  if (explicit) return resolve(explicit)
  const fromEnv = typeof env?.DSH_AGENTS_HOME === 'string' ? env.DSH_AGENTS_HOME.trim() : ''
  return join(resolve(fromEnv || join(homedir(), '.agents')), SKILLS_DIR)
}

/**
 * Read one `SKILL.md` frontmatter block.
 *
 * The format is the one the skill loader itself reads: a leading `---` fence, then
 * `key: value` lines, where a value may continue on indented lines. Only `name`,
 * `description` and `whenToUse` are taken, because those are what a catalog entry
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

/** Fold one frontmatter value into the fields a catalog entry uses. */
function assign(fields: Record<string, string>, key: string, value: string): void {
  const target = key === 'whenToUse' || key === 'when_to_use' ? 'whenToUse' : key
  if (target in fields) fields[target] = value
}

/** Append a continuation line to the value above it. */
function append(fields: Record<string, string>, key: string, value: string): void {
  const target = key === 'whenToUse' || key === 'when_to_use' ? 'whenToUse' : key
  if (target in fields) fields[target] = `${fields[target]} ${value}`
}

/** One skill as the catalog reports it. */
export interface CatalogSkill {
  name: string
  description: string
}

/**
 * List the skills installed under one root.
 *
 * Only a directory with a readable `SKILL.md` is a skill: that file is what the
 * loader mounts, so a directory without one would be a name the page offers and
 * nothing behind it. The frontmatter's name wins over the directory name, because
 * it is the name the model addresses. A built-in name is skipped: the plugin owns
 * that rule, and it is not something an operator turns on or off.
 */
export function readSkillCatalog(root: string): CatalogSkill[] {
  if (!existsSync(root)) return []
  const found: CatalogSkill[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const parsed = readSkillFile(join(root, entry.name, 'SKILL.md'))
    if (!parsed) continue
    const name = parsed.name || entry.name
    if (isBuiltinSkill(name)) continue
    found.push({ name, description: parsed.description })
  }
  return found.sort((left, right) => left.name.localeCompare(right.name))
}

/** Parse one `SKILL.md`, or undefined when it is absent or unreadable. */
function readSkillFile(path: string) {
  try {
    return parseFrontmatter(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}
