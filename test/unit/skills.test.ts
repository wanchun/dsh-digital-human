import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  SKILLS_DIR,
  globalSkillsDir,
  isBuiltinSkill,
  parseFrontmatter,
  readSkillCatalog,
} from '../../src/lib/skills'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dh-skills-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Write one skill directory by hand, the way an operator installs it. */
const put = (name: string, files: Record<string, string>) => {
  const dir = join(root, name)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
    writeFileSync(join(dir, path), content, 'utf8')
  }
  return dir
}

const skillMd = (fields: Record<string, string>, body = '# Title\n') =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}`

describe('parseFrontmatter', () => {
  it('reads name, description and whenToUse', () => {
    expect(parseFrontmatter(skillMd({ name: 'qs', description: 'query the platform', whenToUse: 'when asked' })))
      .toEqual({ name: 'qs', description: 'query the platform', whenToUse: 'when asked' })
  })

  it('folds a multi-line block value into one line', () => {
    const text = '---\nname: qs\ndescription: |\n  first line\n  second line\nwhenToUse: x\n---\nbody\n'
    expect(parseFrontmatter(text).description).toBe('first line second line')
  })

  it('accepts the snake_case spelling of whenToUse', () => {
    expect(parseFrontmatter(skillMd({ name: 'a', when_to_use: 'when' })).whenToUse).toBe('when')
  })

  it('is empty without a fence, without a closing fence, and for empty input', () => {
    const empty = { name: '', description: '', whenToUse: '' }
    expect(parseFrontmatter('# just a body\n')).toEqual(empty)
    expect(parseFrontmatter('---\nname: a\n')).toEqual(empty)
    expect(parseFrontmatter('')).toEqual(empty)
    expect(parseFrontmatter(undefined as unknown as string)).toEqual(empty)
  })

  it('ignores a key it does not use', () => {
    expect(parseFrontmatter(skillMd({ name: 'a', license: 'MIT' })).name).toBe('a')
  })

  it('ignores a continuation line with no key above it', () => {
    expect(parseFrontmatter('---\n  orphan\nname: a\n---\n').name).toBe('a')
  })

  it('ignores an empty inline value, leaving the field unset', () => {
    expect(parseFrontmatter('---\nname: a\ndescription:\n---\n').description).toBe('')
  })
})

describe('globalSkillsDir', () => {
  it('takes an explicit root as the skills directory itself', () => {
    expect(globalSkillsDir('/tmp/skills', {})).toBe('/tmp/skills')
  })

  it('reads DSH_AGENTS_HOME, and ignores a blank one', () => {
    expect(globalSkillsDir(undefined, { DSH_AGENTS_HOME: '/tmp/agents' })).toBe(join('/tmp/agents', SKILLS_DIR))
    expect(globalSkillsDir(undefined, { DSH_AGENTS_HOME: '   ' })).toBe(join(homedir(), '.agents', SKILLS_DIR))
    expect(globalSkillsDir('  ', {})).toBe(join(homedir(), '.agents', SKILLS_DIR))
  })

  it('falls back to ~/.agents/skills', () => {
    expect(globalSkillsDir(undefined, {})).toBe(join(homedir(), '.agents', SKILLS_DIR))
  })
})

describe('readSkillCatalog', () => {
  it('is empty when the root does not exist', () => {
    expect(readSkillCatalog(join(root, 'never-installed'))).toEqual([])
  })

  it('reports a skill with its frontmatter', () => {
    put('qs-assistant', { 'SKILL.md': skillMd({ name: 'qs-assistant', description: 'd' }), 'references/cli.md': 'x' })
    expect(readSkillCatalog(root)).toEqual([{ name: 'qs-assistant', description: 'd' }])
  })

  it('ignores an empty directory, a directory with no SKILL.md, and a stray file', () => {
    mkdirSync(join(root, 'empty'))
    put('notes-only', { 'notes.md': 'no frontmatter here' })
    writeFileSync(join(root, 'loose.md'), 'x')
    expect(readSkillCatalog(root)).toEqual([])
  })

  it('sorts by name and falls back to the directory name', () => {
    put('zeta', { 'SKILL.md': skillMd({ name: 'zeta' }) })
    put('dir-name', { 'SKILL.md': '# no frontmatter\n' })
    expect(readSkillCatalog(root).map((entry) => entry.name)).toEqual(['dir-name', 'zeta'])
  })

  it('skips a SKILL.md that cannot be read', () => {
    const dir = put('unreadable', { 'SKILL.md': skillMd({ name: 'unreadable' }) })
    rmSync(join(dir, 'SKILL.md'))
    mkdirSync(join(dir, 'SKILL.md'))
    expect(readSkillCatalog(root)).toEqual([])
  })
})

describe('the built-in rules', () => {
  it('names the plugin protocol, and is not otherwise a skill', () => {
    expect(isBuiltinSkill('digital-human-comms')).toBe(true)
    expect(isBuiltinSkill('qs-assistant')).toBe(false)
  })

  it('never offers a built-in name in the catalog', () => {
    // The rules travel in the operating context, so the name is not a choice an
    // operator can make; the directory is ignored even when it is still installed.
    put('digital-human-comms', { 'SKILL.md': skillMd({ name: 'digital-human-comms', description: 'protocol' }) })
    put('qs', { 'SKILL.md': skillMd({ name: 'qs' }) })
    expect(readSkillCatalog(root).map((entry) => entry.name)).toEqual(['qs'])
  })
})
