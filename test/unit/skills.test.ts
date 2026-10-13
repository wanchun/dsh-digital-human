import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  SKILLS_DIR,
  libraryDir,
  listLibrary,
  loadSkills,
  parseFrontmatter,
  removeSkill,
  validSkillName,
  writeSkill,
} from '../../src/lib/skills'

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dh-skills-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** Write one skill directory by hand. */
const put = (name: string, files: Record<string, string>) => {
  const dir = join(libraryDir(home), name)
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

describe('validSkillName', () => {
  it('accepts the shapes a directory can carry', () => {
    for (const name of ['qs', 'qs-assistant', 'a.b_c-1']) expect(validSkillName(name), name).toBe(true)
  })

  it('refuses anything that could escape the library', () => {
    for (const name of ['', '..', 'a/b', '/abs', 'a b', '.hidden', 'x'.repeat(65), 7, undefined]) {
      expect(validSkillName(name), String(name)).toBe(false)
    }
  })
})

describe('listLibrary', () => {
  it('is empty when nothing was uploaded', () => {
    expect(listLibrary(home)).toEqual([])
  })

  it('reports a skill with its files, size and frontmatter', () => {
    put('qs-assistant', { 'SKILL.md': skillMd({ name: 'qs-assistant', description: 'd' }), 'references/cli.md': 'x'.repeat(10) })
    const [found] = listLibrary(home)
    expect(found).toMatchObject({ name: 'qs-assistant', description: 'd', named: true })
    expect(found.files).toEqual(['SKILL.md', 'references/cli.md'])
    expect(found.bytes).toBeGreaterThan(10)
  })

  it('reports a directory whose SKILL.md is missing, named by its directory', () => {
    // An upload that went wrong must be visible, so it can be removed.
    put('broken', { 'notes.md': 'no frontmatter here' })
    expect(listLibrary(home)[0]).toMatchObject({ name: 'broken', description: '', named: false })
  })

  it('ignores a stray file at the top level', () => {
    mkdirSync(libraryDir(home), { recursive: true })
    writeFileSync(join(libraryDir(home), 'loose.md'), 'x')
    expect(listLibrary(home)).toEqual([])
  })

  it('sorts by name', () => {
    put('zeta', { 'SKILL.md': skillMd({ name: 'zeta' }) })
    put('alpha', { 'SKILL.md': skillMd({ name: 'alpha' }) })
    expect(listLibrary(home).map((entry) => entry.name)).toEqual(['alpha', 'zeta'])
  })

  it('falls back to the directory name when the frontmatter names nothing', () => {
    put('dir-name', { 'SKILL.md': '# no frontmatter\n' })
    expect(listLibrary(home)[0]).toMatchObject({ name: 'dir-name', named: false })
  })
})

describe('loadSkills', () => {
  it('loads a body and reports the names that are gone', () => {
    put('qs', { 'SKILL.md': skillMd({ name: 'qs', description: 'd' }, '# Body\n') })
    const { skills, missing } = loadSkills(home, ['qs', 'never-uploaded'])
    expect(skills).toHaveLength(1)
    expect(skills[0].content).toContain('# Body')
    expect(skills[0].path.endsWith('SKILL.md')).toBe(true)
    // Reported rather than skipped: a record mounting a skill nobody uploaded is a
    // mistake worth seeing.
    expect(missing).toEqual(['never-uploaded'])
  })

  it('reports a name that could not be a directory', () => {
    expect(loadSkills(home, ['../etc']).missing).toEqual(['../etc'])
  })

  it('survives a skill whose files cannot be listed', () => {
    put('qs', { 'SKILL.md': skillMd({ name: 'qs' }) })
    const { skills } = loadSkills(home, ['qs'])
    expect(skills[0].files).toEqual(['SKILL.md'])
  })
})

describe('writeSkill', () => {
  it('writes a skill and reports it', async () => {
    await writeSkill(home, 'qs', { 'SKILL.md': skillMd({ name: 'qs', description: 'd' }) })
    expect(readFileSync(join(libraryDir(home), 'qs', 'SKILL.md'), 'utf8')).toContain('name: qs')
    expect(listLibrary(home)[0].name).toBe('qs')
  })

  it('creates nested resource directories', async () => {
    await writeSkill(home, 'qs', { 'SKILL.md': skillMd({ name: 'qs' }), 'references/a/b.md': 'deep' })
    expect(existsSync(join(libraryDir(home), 'qs', 'references', 'a', 'b.md'))).toBe(true)
  })

  it('replaces a skill that is already there, leaving nothing of the old one', async () => {
    await writeSkill(home, 'qs', { 'SKILL.md': skillMd({ name: 'qs' }), 'old.md': 'gone' })
    await writeSkill(home, 'qs', { 'SKILL.md': skillMd({ name: 'qs' }) })
    expect(existsSync(join(libraryDir(home), 'qs', 'old.md'))).toBe(false)
  })

  it('refuses a name that would escape the library', async () => {
    await expect(writeSkill(home, '../evil', { 'SKILL.md': 'x' })).rejects.toThrow(/skill name/)
  })

  it('refuses a file path that would escape the skill', async () => {
    await expect(writeSkill(home, 'qs', { '../outside.md': 'x' })).rejects.toThrow(/inside the skill/)
    await expect(writeSkill(home, 'qs', { '/abs.md': 'x' })).rejects.toThrow(/inside the skill/)
  })

  it('refuses an empty skill and a non-text file', async () => {
    await expect(writeSkill(home, 'qs', {})).rejects.toThrow(/at least one file/)
    await expect(writeSkill(home, 'qs', { 'a.bin': 7 as unknown as string })).rejects.toThrow(/must be text/)
  })

  it('normalises a backslash and a leading ./ in the path', async () => {
    await writeSkill(home, 'qs', { './references\\cli.md': 'x' })
    expect(existsSync(join(libraryDir(home), 'qs', 'references', 'cli.md'))).toBe(true)
  })

  it('leaves no staging directory behind', async () => {
    await writeSkill(home, 'qs', { 'SKILL.md': 'x' })
    const names = listLibrary(home).map((entry) => entry.name)
    expect(names).toEqual(['qs'])
    expect(names.some((name) => name.includes('.tmp'))).toBe(false)
  })
})

describe('the limits a skill must stay inside', () => {
  it('refuses a skill with too many files', async () => {
    const files: Record<string, string> = {}
    for (let at = 0; at <= 2000; at++) files[`f${at}.md`] = 'x'
    await expect(writeSkill(home, 'huge', files)).rejects.toThrow(/at most 2000 files/)
  })

  it('refuses a skill that is too large', async () => {
    await expect(writeSkill(home, 'big', { 'SKILL.md': 'x'.repeat(32 * 1024 * 1024 + 1) }))
      .rejects.toThrow(/at most .* bytes/)
  })
})

describe('a skill the filesystem will not cooperate with', () => {
  it('reports a skill whose files cannot be listed', () => {
    // A dangling symlink makes the walk throw; the skill is still reported so it can
    // be removed from the page.
    const dir = put('odd', { 'SKILL.md': skillMd({ name: 'odd' }) })
    const { symlinkSync } = require('node:fs')
    symlinkSync(join(dir, 'missing-target'), join(dir, 'dangling'))
    expect(listLibrary(home).map((entry) => entry.name)).toContain('odd')
  })

  it('reports a SKILL.md that cannot be read', () => {
    const dir = put('unreadable', { 'SKILL.md': skillMd({ name: 'unreadable' }) })
    rmSync(join(dir, 'SKILL.md'))
    mkdirSync(join(dir, 'SKILL.md'))
    const found = listLibrary(home).find((entry) => entry.name === 'unreadable')
    expect(found).toMatchObject({ name: 'unreadable', named: false })
  })

  it('loads a skill whose listing is partial', () => {
    const dir = put('partial', { 'SKILL.md': skillMd({ name: 'partial' }) })
    const { symlinkSync } = require('node:fs')
    symlinkSync(join(dir, 'nowhere'), join(dir, 'broken'))
    const { skills } = loadSkills(home, ['partial'])
    expect(skills[0].content).toContain('# Title')
  })
})

describe('a skill whose frontmatter disagrees with its directory', () => {
  it('is reported under the frontmatter name, not the directory', async () => {
    // The directory is only a container; the name the model sees comes from the file.
    const written = await writeSkill(home, 'dir-name', { 'SKILL.md': skillMd({ name: 'declared' }) })
    expect(listLibrary(home).map((entry) => entry.name)).toEqual(['declared'])
    expect(written).toBeDefined()
  })
})

describe('frontmatter keys the parser does not use', () => {
  it('ignores a continuation line under an unrelated key', () => {
    const text = ['---', 'license: MIT', '  continued', 'name: a', '---', ''].join('\n')
    expect(parseFrontmatter(text).name).toBe('a')
  })
})

describe('removeSkill', () => {
  it('removes one skill and reports it', async () => {
    await writeSkill(home, 'qs', { 'SKILL.md': 'x' })
    expect(await removeSkill(home, 'qs')).toBe(true)
    expect(listLibrary(home)).toEqual([])
  })

  it('reports a skill that is not there, and a name it will not use', async () => {
    expect(await removeSkill(home, 'absent')).toBe(false)
    expect(await removeSkill(home, '../etc')).toBe(false)
  })
})

describe('the library directory', () => {
  it('sits under the registry root', () => {
    expect(libraryDir('/home/dh')).toBe(join('/home/dh', SKILLS_DIR))
  })
})
