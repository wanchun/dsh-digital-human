import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUNDLE_FORMAT, packHuman, readBundle, readTar, unpackHuman, writeTar } from '../../src/lib/bundle'
import { libraryDir, listLibrary, writeSkill } from '../../src/lib/skills'
import { normalizeHuman } from '../../src/lib/store'

let home = ''

beforeEach(async () => {
  home = await mkdtempSync(join(tmpdir(), 'dh-bundle-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const human = (patch: Record<string, unknown> = {}) => normalizeHuman({
  id: 'pm', name: '研发PM助手', systemPrompt: '你是 {{bot}}。', skills: [], ...patch,
})

describe('the tar container', () => {
  it('round-trips files, nested paths and empty content', () => {
    const files = {
      'a.txt': Buffer.from('hello'),
      'dir/b.md': Buffer.from('# b'),
      'empty': Buffer.alloc(0),
    }
    const back = readTar(writeTar(files))
    for (const [name, content] of Object.entries(files)) {
      expect(back[name]?.toString('utf8'), name).toBe(content.toString('utf8'))
    }
  })

  it('pads a body to a block and ends with two empty blocks', () => {
    const archive = writeTar({ 'x': Buffer.alloc(513, 0x61) })
    expect(archive.length % 512).toBe(0)
    expect(archive.subarray(-1024).every((byte) => byte === 0)).toBe(true)
  })

  it('moves a long path into the prefix field rather than truncating it', () => {
    const long = `${'d'.repeat(120)}/${'f'.repeat(60)}.md`
    const back = readTar(writeTar({ [long]: Buffer.from('x') }))
    expect(Object.keys(back)).toEqual([long])
  })

  it('refuses a path that fits neither field', () => {
    expect(() => writeTar({ [`${'d'.repeat(160)}/${'f'.repeat(120)}`]: Buffer.from('x') }))
      .toThrow(/too long for a tar header/)
  })

  it('skips a link entry instead of following it', () => {
    // A symlink entry must not become a file the import would write.
    const archive = writeTar({ 'real.md': Buffer.from('x') })
    const link = Buffer.from(archive)
    link.write('1', 156, 1, 'utf8') // typeflag: hard link
    expect(Object.keys(readTar(link))).toEqual([])
  })

  it('stops at the end-of-archive marker', () => {
    const archive = Buffer.concat([writeTar({ 'a': Buffer.from('x') }), Buffer.from('junk')])
    expect(Object.keys(readTar(archive))).toEqual(['a'])
  })
})

describe('packing one digital human', () => {
  it('carries the record and the skills it mounts, and strips the local fields', async () => {
    await writeSkill(home, 'qs', { 'SKILL.md': '---\nname: qs\ndescription: d\n---\n# Body\n', 'references/x.md': 'r' })
    const record = human({
      skills: ['qs'],
      im: { botId: 'wecom_1', targetId: 'rtcpc-result-group', owner: 'wohR_owner' },
    })
    const { archive, manifest } = packHuman(home, record)
    expect(manifest).toMatchObject({ format: BUNDLE_FORMAT, id: 'pm', skills: ['qs'], memory: false })
    const preview = readBundle(archive)
    expect(preview.human.systemPrompt).toContain('{{bot}}')
    // A binding is the machine's, not the record's.
    expect(preview.human.im).toEqual({})
    expect(preview.skills).toEqual([{ name: 'qs', files: 2, bytes: expect.any(Number) }])
  })

  it('omits the memory unless asked, and carries it when it is', async () => {
    mkdirSync(join(home, 'humans', 'pm'), { recursive: true })
    writeFileSync(join(home, 'humans', 'pm', 'memory.md'), '# now\n')
    expect(packHuman(home, human()).manifest.memory).toBe(false)
    const withMemory = packHuman(home, human(), { includeMemory: true })
    expect(withMemory.manifest.memory).toBe(true)
    expect(readTar(gunzipSync(withMemory.archive))['memory.md'].toString('utf8')).toBe('# now\n')
  })

  it('skips a mounted skill that is not in the library', () => {
    const { manifest } = packHuman(home, human({ skills: ['never-uploaded'] }))
    expect(manifest.skills).toEqual([])
  })
})

describe('the parts of a bundle that are easy to get wrong', () => {
  it('packs a record with no binding at all', () => {
    // A raw record, not a normalized one: normalizeHuman always supplies an `im`, so
    // this is the shape a hand-written registry entry has before the page saves it.
    const bare = { id: 'bare', name: 'Bare' } as unknown as ReturnType<typeof normalizeHuman>
    expect(readBundle(packHuman(home, bare).archive).human.im).toBeUndefined()
    expect(readBundle(packHuman(home, normalizeHuman({ id: 'bare', name: 'Bare' })).archive).human.im).toEqual({})
  })

  it('ignores a mounted name that could not be a directory', () => {
    const { manifest } = packHuman(home, human({ skills: ['../etc'] }))
    expect(manifest.skills).toEqual([])
  })

  it('keeps a directory entry out of the files it reads back', () => {
    const withDir = readTar(writeTar({ 'skills/a/': Buffer.alloc(0), 'skills/a/SKILL.md': Buffer.from('x') }))
    expect(Object.keys(withDir)).toEqual(['skills/a/', 'skills/a/SKILL.md'])
  })

  it('reports the skills a bundle carries, counted per directory', () => {
    const files = {
      'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}","id":"pm","name":"x","skills":["a","b"]}`),
      'human.json': Buffer.from('{"id":"pm","name":"x"}'),
      'skills/a/SKILL.md': Buffer.from('a'),
      'skills/b/SKILL.md': Buffer.from('b'),
      'skills/b/ref.md': Buffer.from('r'),
      'notes.md': Buffer.from('ignored'),
    }
    const preview = readBundle(gzipSync(writeTar(files)))
    expect(preview.skills).toEqual([
      { name: 'a', files: 1, bytes: 1 },
      { name: 'b', files: 2, bytes: 2 },
    ])
  })

  it('refuses a bundle over the size limit', () => {
    const big = Buffer.alloc(64 * 1024 * 1024 + 1)
    expect(() => readBundle(big)).toThrow(/at most/)
  })
})

describe('a skill directory with nothing in it', () => {
  it('is packed as a skill with no files', () => {
    // A directory can be created by hand, and the packer must not fail on it.
    mkdirSync(join(libraryDir(home), 'empty'), { recursive: true })
    const { manifest } = packHuman(home, human({ skills: ['empty'] }))
    // Not carried, because it holds nothing: the manifest and the archive agree.
    expect(manifest.skills).toEqual([])
    expect(readBundle(packHuman(home, human({ skills: ['empty'] })).archive).skills).toEqual([])
  })
})

describe('paths a tar may carry', () => {
  it('normalises a leading ./ and a backslash', () => {
    const back = readTar(writeTar({ './a/b.md': Buffer.from('x') }))
    expect(Object.keys(back)).toEqual(['a/b.md'])
  })

  it('ignores an entry with no usable name', () => {
    const archive = Buffer.from(writeTar({ 'a': Buffer.from('x') }))
    archive.write('\0', 0, 1, 'utf8')
    expect(Object.keys(readTar(archive))).toEqual([])
  })

  it('counts no skill for a path with no name segment', () => {
    const files = {
      'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}","id":"pm","name":"x"}`),
      'human.json': Buffer.from('{"id":"pm","name":"x"}'),
      'skills//SKILL.md': Buffer.from('x'),
    }
    expect(readBundle(gzipSync(writeTar(files))).skills).toEqual([])
  })
})

describe('reading a bundle', () => {
  it('refuses an empty, a non-gzip and a foreign archive', () => {
    expect(() => readBundle(Buffer.alloc(0))).toThrow(/empty/)
    expect(() => readBundle(Buffer.from('not gzip'))).toThrow(/not a readable/)
    const foreign = gzipSync(writeTar({ 'manifest.json': Buffer.from('{"format":"other/1"}'), 'human.json': Buffer.from('{}') }))
    expect(() => readBundle(foreign)).toThrow(/unsupported bundle format/)
  })

  it('refuses an archive with no record', () => {
    const partial = gzipSync(writeTar({ 'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}"}`) }))
    expect(() => readBundle(partial)).toThrow(/no manifest.json or human.json/)
    const noId = gzipSync(writeTar({
      'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}"}`),
      'human.json': Buffer.from('{"name":"x"}'),
    }))
    expect(() => readBundle(noId)).toThrow(/no usable digital human record/)
  })

  it('refuses unreadable JSON', () => {
    const broken = gzipSync(writeTar({
      'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}"}`),
      'human.json': Buffer.from('{ not json'),
    }))
    expect(() => readBundle(broken)).toThrow(/JSON is unreadable/)
  })
})

describe('unpacking a bundle', () => {
  it('writes the skills and reports the record to store', async () => {
    await writeSkill(home, 'qs', { 'SKILL.md': '---\nname: qs\ndescription: d\n---\n# Body\n' })
    const { archive } = packHuman(home, human({ skills: ['qs'] }))
    rmSync(libraryDir(home), { recursive: true, force: true })
    expect(listLibrary(home)).toEqual([])
    const result = await unpackHuman(home, archive)
    expect(result).toMatchObject({ id: 'pm', renamed: false, skills: ['qs'], memory: false })
    expect(result.record.id).toBe('pm')
    expect(readFileSync(join(libraryDir(home), 'qs', 'SKILL.md'), 'utf8')).toContain('# Body')
  })

  it('writes under another id when asked, and reports the rename', async () => {
    const { archive } = packHuman(home, human())
    const result = await unpackHuman(home, archive, { id: 'pm-copy' })
    expect(result).toMatchObject({ id: 'pm-copy', renamed: true })
    expect(result.record.id).toBe('pm-copy')
  })

  it('refuses an id it will not use', async () => {
    const { archive } = packHuman(home, human())
    await expect(unpackHuman(home, archive, { id: '../evil' })).rejects.toThrow(/id must match/)
  })

  it('keeps an existing skill when overwrite is off', async () => {
    await writeSkill(home, 'qs', { 'SKILL.md': 'MINE\n' })
    const other = mkdtempSync(join(tmpdir(), 'dh-bundle-src-'))
    await writeSkill(other, 'qs', { 'SKILL.md': '---\nname: qs\n---\nTHEIRS\n' })
    const { archive } = packHuman(other, human({ skills: ['qs'] }))
    const result = await unpackHuman(home, archive, { overwrite: false })
    expect(result.skills).toEqual([])
    expect(readFileSync(join(libraryDir(home), 'qs', 'SKILL.md'), 'utf8')).toBe('MINE\n')
    rmSync(other, { recursive: true, force: true })
  })

  it('refuses a skill carrying a binary file rather than mangling it', async () => {
    const files = {
      'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}","id":"pm","name":"x","skills":["bin"]}`),
      'human.json': Buffer.from('{"id":"pm","name":"x"}'),
      'skills/bin/SKILL.md': Buffer.from('---\nname: bin\n---\n'),
      'skills/bin/logo.png': Buffer.from([0x89, 0x50, 0x00, 0x4e]),
    }
    const archive = gzipSync(writeTar(files))
    await expect(unpackHuman(home, archive)).rejects.toThrow(/binary file/)
  })

  it('carries the memory when the bundle has it', async () => {
    mkdirSync(join(home, 'humans', 'pm'), { recursive: true })
    writeFileSync(join(home, 'humans', 'pm', 'memory.md'), '# now\n## State | x\n')
    const { archive } = packHuman(home, human(), { includeMemory: true })
    rmSync(join(home, 'humans', 'pm'), { recursive: true, force: true })
    const result = await unpackHuman(home, archive)
    expect(result.memory).toBe(true)
    expect(readFileSync(join(home, 'humans', 'pm', 'memory.md'), 'utf8')).toContain('## State | x')
  })

  it('reports a bundle whose skill carries no files', async () => {
    const files = {
      'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}","id":"pm","name":"x","skills":["empty"]}`),
      'human.json': Buffer.from('{"id":"pm","name":"x"}'),
    }
    const archive = gzipSync(writeTar(files))
    const result = await unpackHuman(home, archive)
    expect(result.skills).toEqual([])
    expect(existsSync(join(libraryDir(home), 'empty'))).toBe(false)
  })
})
