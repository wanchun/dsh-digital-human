import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUNDLE_FORMAT, packHumans, readBundle, readTar, unpackHumans, writeTar } from '../../src/lib/bundle'
import { libraryDir, listLibrary, writeSkill } from '../../src/lib/skills'
import { normalizeHuman } from '../../src/lib/store'

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dh-bundle-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const human = (patch: Record<string, unknown> = {}) => normalizeHuman({
  id: 'pm', name: '研发PM助手', systemPrompt: '你是 {{bot}}。', skills: [], ...patch,
})

const skillMd = (name: string) => `---\nname: ${name}\ndescription: d\n---\n# Body\n`

describe('the tar container', () => {
  it('round-trips files, nested paths and empty content', () => {
    const files = { 'a.txt': Buffer.from('hello'), 'dir/b.md': Buffer.from('# b'), empty: Buffer.alloc(0) }
    const back = readTar(writeTar(files))
    for (const [name, content] of Object.entries(files)) {
      expect(back[name]?.toString('utf8'), name).toBe(content.toString('utf8'))
    }
  })

  it('pads to a block and ends with two empty blocks', () => {
    const archive = writeTar({ x: Buffer.alloc(513, 0x61) })
    expect(archive.length % 512).toBe(0)
    expect(archive.subarray(-1024).every((byte) => byte === 0)).toBe(true)
  })

  it('moves a long path into the prefix field rather than truncating it', () => {
    const long = `${'d'.repeat(120)}/${'f'.repeat(60)}.md`
    expect(Object.keys(readTar(writeTar({ [long]: Buffer.from('x') })))).toEqual([long])
  })

  it('refuses a path that fits neither field', () => {
    expect(() => writeTar({ [`${'d'.repeat(160)}/${'f'.repeat(120)}`]: Buffer.from('x') }))
      .toThrow(/too long for a tar header/)
  })

  it('skips a link entry instead of following it', () => {
    const link = Buffer.from(writeTar({ 'real.md': Buffer.from('x') }))
    link.write('1', 156, 1, 'utf8') // typeflag: hard link
    expect(Object.keys(readTar(link))).toEqual([])
  })

  it('stops at the end-of-archive marker', () => {
    const archive = Buffer.concat([writeTar({ a: Buffer.from('x') }), Buffer.from('junk')])
    expect(Object.keys(readTar(archive))).toEqual(['a'])
  })

  it('normalises a leading ./ and ignores an entry with no name', () => {
    expect(Object.keys(readTar(writeTar({ './a/b.md': Buffer.from('x') })))).toEqual(['a/b.md'])
    const blank = Buffer.from(writeTar({ a: Buffer.from('x') }))
    blank.write('\0', 0, 1, 'utf8')
    expect(Object.keys(readTar(blank))).toEqual([])
  })
})

describe('packing', () => {
  it('carries the records and their skills, and strips the local fields', async () => {
    await writeSkill(home, 'qs', { 'SKILL.md': skillMd('qs'), 'references/x.md': 'r' })
    const record = human({ skills: ['qs'], im: { botId: 'wecom_1', targetId: 'group', owner: 'wohR' } })
    const { archive, manifest } = packHumans(home, [record])
    expect(manifest).toMatchObject({ format: BUNDLE_FORMAT, skills: ['qs'], memory: false })
    expect(manifest.humans).toEqual([{ id: 'pm', name: '研发PM助手' }])
    const preview = readBundle(archive)
    expect(preview.humans).toHaveLength(1)
    expect(preview.humans[0].systemPrompt).toContain('{{bot}}')
    // A binding is the machine's, not the record's.
    expect(preview.humans[0].im).toEqual({ botId: '', targetId: '' })
    expect(preview.skills).toEqual([{ name: 'qs', files: 2, bytes: expect.any(Number) }])
  })

  it('writes the persona and the config, never a combined record', async () => {
    const { archive } = packHumans(home, [human({ im: { botId: 'wecom_1', targetId: 'g', owner: 'o' } })])
    const files = readTar(gunzipSync(archive))
    expect(files['humans/pm/persona.md'].toString('utf8')).toContain('name: 研发PM助手')
    expect(JSON.parse(files['humans/pm/config.json'].toString('utf8'))).toMatchObject({ enabled: true, sessionMode: 'thread' })
    expect(files['humans/pm.json']).toBeUndefined()
  })

  it('carries many records in one bundle, with the union of their skills', async () => {
    await writeSkill(home, 'a', { 'SKILL.md': skillMd('a') })
    await writeSkill(home, 'b', { 'SKILL.md': skillMd('b') })
    const { manifest } = packHumans(home, [
      human({ id: 'one', name: 'One', skills: ['a'] }),
      human({ id: 'two', name: 'Two', skills: ['a', 'b'] }),
    ])
    // The shared skill travels once, not once per record.
    expect(manifest.skills).toEqual(['a', 'b'])
    expect(manifest.humans.map((entry) => entry.id)).toEqual(['one', 'two'])
  })

  it('refuses an empty export', () => {
    expect(() => packHumans(home, [])).toThrow(/no digital human to export/)
  })

  it('omits the memory unless asked, and carries one per record when it is', async () => {
    for (const id of ['one', 'two']) {
      mkdirSync(join(home, 'humans', id), { recursive: true })
      writeFileSync(join(home, 'humans', id, 'memory.md'), `# ${id}\n`)
    }
    const humans = [human({ id: 'one' }), human({ id: 'two' })]
    expect(packHumans(home, humans).manifest.memory).toBe(false)
    const withMemory = packHumans(home, humans, { includeMemory: true })
    expect(withMemory.manifest.memory).toBe(true)
    const files = readTar(gunzipSync(withMemory.archive))
    expect(files['memory/one.md'].toString('utf8')).toBe('# one\n')
    expect(files['memory/two.md'].toString('utf8')).toBe('# two\n')
  })

  it('carries the memory of the records that have one, and skips the rest', async () => {
    mkdirSync(join(home, 'humans', 'one'), { recursive: true })
    writeFileSync(join(home, 'humans', 'one', 'memory.md'), '# one\n')
    // `two` has no memory file: the export must not invent one.
    const { manifest } = packHumans(home, [human({ id: 'one' }), human({ id: 'two' })], { includeMemory: true })
    expect(manifest.memory).toBe(true)
  })

  it('skips a mounted skill that is not in the library', () => {
    expect(packHumans(home, [human({ skills: ['never-uploaded'] })]).manifest.skills).toEqual([])
  })

  it('skips a mounted name that could not be a directory', () => {
    expect(packHumans(home, [human({ skills: ['../etc'] })]).manifest.skills).toEqual([])
  })

  it('skips a skill directory with nothing in it', () => {
    mkdirSync(join(libraryDir(home), 'empty'), { recursive: true })
    expect(packHumans(home, [human({ skills: ['empty'] })]).manifest.skills).toEqual([])
  })

  it('packs a raw record with no binding at all', () => {
    const bare = { id: 'bare', name: 'Bare' } as unknown as ReturnType<typeof normalizeHuman>
    expect(readBundle(packHumans(home, [bare]).archive).humans[0].im).toEqual({ botId: '', targetId: '' })
  })
})

describe('reading', () => {
  it('refuses an empty, a non-gzip and a foreign archive', () => {
    expect(() => readBundle(Buffer.alloc(0))).toThrow(/empty/)
    expect(() => readBundle(Buffer.from('not gzip'))).toThrow(/not a readable/)
    const foreign = gzipSync(writeTar({
      'manifest.json': Buffer.from('{"format":"other/1"}'),
      'humans/pm.json': Buffer.from('{"id":"pm","name":"x"}'),
    }))
    expect(() => readBundle(foreign)).toThrow(/unsupported bundle format/)
  })

  it('refuses a bundle with no manifest or no record', () => {
    const noManifest = gzipSync(writeTar({ 'humans/pm.json': Buffer.from('{"id":"pm","name":"x"}') }))
    expect(() => readBundle(noManifest)).toThrow(/no manifest/)
    const noRecord = gzipSync(writeTar({ 'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}"}`) }))
    expect(() => readBundle(noRecord)).toThrow(/no digital human record/)
  })

  it('refuses a record with no id, and unreadable JSON', () => {
    const noId = gzipSync(writeTar({
      'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}"}`),
      'humans/pm.json': Buffer.from('{"name":"x"}'),
    }))
    expect(() => readBundle(noId)).toThrow(/no usable digital human record/)
    const broken = gzipSync(writeTar({
      'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}"}`),
      'humans/pm.json': Buffer.from('{ not json'),
    }))
    expect(() => readBundle(broken)).toThrow(/unreadable/)
  })

  it('counts the skills it carries, and ignores anything outside skills/', () => {
    const files = {
      'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}"}`),
      'humans/pm.json': Buffer.from('{"id":"pm","name":"x"}'),
      'skills/a/SKILL.md': Buffer.from('a'),
      'skills/b/SKILL.md': Buffer.from('b'),
      'skills/b/ref.md': Buffer.from('r'),
      'notes.md': Buffer.from('ignored'),
    }
    expect(readBundle(gzipSync(writeTar(files))).skills).toEqual([
      { name: 'a', files: 1, bytes: 1 },
      { name: 'b', files: 2, bytes: 2 },
    ])
  })

  it('reads a directory record with no persona as an id-named record', () => {
    const archive = gzipSync(writeTar({
      'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}"}`),
      'humans/pm/config.json': Buffer.from('{"enabled":true}'),
    }))
    expect(readBundle(archive).humans[0]).toMatchObject({ id: 'pm', name: 'pm', systemPrompt: '' })
  })

  it('refuses a directory record with unreadable or non-object config', () => {
    const manifest = Buffer.from(`{"format":"${BUNDLE_FORMAT}"}`)
    const broken = gzipSync(writeTar({
      'manifest.json': manifest,
      'humans/pm/config.json': Buffer.from('{ nope'),
    }))
    expect(() => readBundle(broken)).toThrow(/unreadable/)
    const notObject = gzipSync(writeTar({
      'manifest.json': manifest,
      'humans/pm/config.json': Buffer.from('[]'),
    }))
    expect(() => readBundle(notObject)).toThrow(/no usable/)
  })

  it('refuses a bundle over the size limit', () => {
    expect(() => readBundle(Buffer.alloc(64 * 1024 * 1024 + 1))).toThrow(/at most/)
  })
})

describe('unpacking', () => {
  it('writes the skills and returns the records to store', async () => {
    await writeSkill(home, 'qs', { 'SKILL.md': skillMd('qs') })
    const { archive } = packHumans(home, [human({ skills: ['qs'] })])
    rmSync(libraryDir(home), { recursive: true, force: true })
    expect(listLibrary(home)).toEqual([])
    const result = await unpackHumans(home, archive)
    expect(result).toMatchObject({ ids: ['pm'], renamed: false, skills: ['qs'], memory: false })
    expect(result.records[0].id).toBe('pm')
    expect(readFileSync(join(libraryDir(home), 'qs', 'SKILL.md'), 'utf8')).toContain('# Body')
  })

  it('writes many records from one bundle', async () => {
    const { archive } = packHumans(home, [human({ id: 'one', name: 'One' }), human({ id: 'two', name: 'Two' })])
    const result = await unpackHumans(home, archive)
    expect(result.ids).toEqual(['one', 'two'])
    expect(result.renamed).toBe(false)
    expect(result.records.map((record) => record.name)).toEqual(['One', 'Two'])
  })

  it('renames a single-record bundle when asked, and refuses an unusable id', async () => {
    const { archive } = packHumans(home, [human()])
    const result = await unpackHumans(home, archive, { id: 'pm-copy' })
    expect(result).toMatchObject({ ids: ['pm-copy'], renamed: true })
    await expect(unpackHumans(home, archive, { id: '../evil' })).rejects.toThrow(/id must match/)
  })

  it('refuses an id for a bundle that holds many records', async () => {
    const { archive } = packHumans(home, [human({ id: 'one' }), human({ id: 'two' })])
    await expect(unpackHumans(home, archive, { id: 'x' })).rejects.toThrow(/exactly one digital human/)
  })

  it('keeps an existing skill when overwrite is off, and mounts only what it wrote', async () => {
    await writeSkill(home, 'qs', { 'SKILL.md': 'MINE\n' })
    const other = mkdtempSync(join(tmpdir(), 'dh-bundle-src-'))
    await writeSkill(other, 'qs', { 'SKILL.md': skillMd('qs') })
    const { archive } = packHumans(other, [human({ skills: ['qs'] })])
    const result = await unpackHumans(home, archive, { overwrite: false })
    expect(result.skills).toEqual([])
    // The record must not name a skill the import skipped.
    expect(result.records[0].skills).toEqual([])
    expect(readFileSync(join(libraryDir(home), 'qs', 'SKILL.md'), 'utf8')).toBe('MINE\n')
    rmSync(other, { recursive: true, force: true })
  })

  it('refuses a skill carrying a binary file rather than mangling it', async () => {
    const archive = gzipSync(writeTar({
      'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}"}`),
      'humans/pm.json': Buffer.from('{"id":"pm","name":"x","skills":["bin"]}'),
      'skills/bin/SKILL.md': Buffer.from('---\nname: bin\n---\n'),
      'skills/bin/logo.png': Buffer.from([0x89, 0x50, 0x00, 0x4e]),
    }))
    await expect(unpackHumans(home, archive)).rejects.toThrow(/binary file/)
  })

  it('carries one memory file per record', async () => {
    for (const id of ['one', 'two']) {
      mkdirSync(join(home, 'humans', id), { recursive: true })
      writeFileSync(join(home, 'humans', id, 'memory.md'), `# now ${id}\n`)
    }
    const { archive } = packHumans(home, [human({ id: 'one' }), human({ id: 'two' })], { includeMemory: true })
    rmSync(join(home, 'humans'), { recursive: true, force: true })
    const result = await unpackHumans(home, archive)
    expect(result.memory).toBe(true)
    expect(readFileSync(join(home, 'humans', 'one', 'memory.md'), 'utf8')).toContain('# now one')
    expect(readFileSync(join(home, 'humans', 'two', 'memory.md'), 'utf8')).toContain('# now two')
  })

  it('reports a bundle whose skill carries no files', async () => {
    const archive = gzipSync(writeTar({
      'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}"}`),
      'humans/pm.json': Buffer.from('{"id":"pm","name":"x","skills":["empty"]}'),
    }))
    const result = await unpackHumans(home, archive)
    expect(result.skills).toEqual([])
    expect(existsSync(join(libraryDir(home), 'empty'))).toBe(false)
  })
})
