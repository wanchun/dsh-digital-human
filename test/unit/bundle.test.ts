import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUNDLE_FORMAT, packHumans, readBundle, readTar, unpackHumans, writeTar } from '../../src/lib/bundle'
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
  it('carries the records and strips the local fields', () => {
    const record = human({ im: { botId: 'wecom_1', targetId: 'group', owner: 'wohR' } })
    const { archive, manifest } = packHumans(home, [record])
    expect(manifest).toEqual({
      format: BUNDLE_FORMAT,
      exportedAt: expect.any(String),
      humans: [{ id: 'pm', name: '研发PM助手' }],
      memory: false,
      stripped: ['im bindings', 'config values', 'subscriptions'],
    })
    const preview = readBundle(archive)
    expect(preview.humans).toHaveLength(1)
    expect(preview.humans[0].systemPrompt).toContain('{{bot}}')
    // A binding is the machine's, not the record's.
    expect(preview.humans[0].im).toEqual({ botId: '', targetId: '' })
    // Deployment values are the machine's too: they travel as blanks the import
    // page fills in, guided by the schema that still rides along.
    expect(preview.humans[0].config ?? {}).toEqual({})
    expect(preview.humans[0].subscriptions ?? []).toEqual([])
  })

  it('writes the persona and the config, never a combined record', async () => {
    const { archive } = packHumans(home, [human({ im: { botId: 'wecom_1', targetId: 'g', owner: 'o' } })])
    const files = readTar(gunzipSync(archive))
    expect(files['humans/pm/persona.md'].toString('utf8')).toContain('name: 研发PM助手')
    expect(JSON.parse(files['humans/pm/config.json'].toString('utf8'))).toMatchObject({ enabled: true, sessionMode: 'thread' })
    expect(files['humans/pm.json']).toBeUndefined()
  })

  it('carries the icon through the bundle', () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo='
    const { archive } = packHumans(home, [human({ icon })])
    expect(readBundle(archive).humans[0].icon).toBe(icon)
    const files = readTar(gunzipSync(archive))
    expect(JSON.parse(files['humans/pm/config.json'].toString('utf8')).icon).toBe(icon)
  })

  it('carries many records in one bundle', () => {
    const { manifest } = packHumans(home, [
      human({ id: 'one', name: 'One' }),
      human({ id: 'two', name: 'Two' }),
    ])
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

  it('ignores a skills/ tree and anything outside humans/ and manifest.json', () => {
    const files = {
      'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}"}`),
      'humans/pm.json': Buffer.from('{"id":"pm","name":"x"}'),
      'skills/a/SKILL.md': Buffer.from('a'),
      'notes.md': Buffer.from('ignored'),
    }
    const preview = readBundle(gzipSync(writeTar(files)))
    expect(preview.humans.map((entry) => entry.id)).toEqual(['pm'])
    expect(preview).not.toHaveProperty('skills')
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
  it('returns the records to store, without a skill tree', async () => {
    const { archive } = packHumans(home, [human({ skills: ['qs'] })])
    const result = await unpackHumans(home, archive)
    expect(result).toMatchObject({ ids: ['pm'], renamed: false, memory: false })
    expect(result.records[0].id).toBe('pm')
    // The name travels with the record; the skill itself is the machine's business.
    expect(result.records[0].skills).toEqual(['qs'])
    expect(existsSync(join(home, 'skills'))).toBe(false)
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

  it('ignores a skills/ tree an older bundle still carries', async () => {
    // Skills are installed by hand in the global root now, so an import must not
    // write one: the older package is read and its tree is dropped.
    const archive = gzipSync(writeTar({
      'manifest.json': Buffer.from(`{"format":"${BUNDLE_FORMAT}"}`),
      'humans/pm.json': Buffer.from('{"id":"pm","name":"x","skills":["qs"]}'),
      'skills/qs/SKILL.md': Buffer.from('---\nname: qs\n---\n'),
      'skills/qs/logo.png': Buffer.from([0x89, 0x50, 0x00, 0x4e]),
    }))
    const result = await unpackHumans(home, archive)
    expect(result.records[0].skills).toEqual(['qs'])
    expect(result.ids).toEqual(['pm'])
    expect(existsSync(join(home, 'skills'))).toBe(false)
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

})

describe('skills travel with a bundle', () => {
  const skillsRoot = () => {
    const root = join(home, 'skills')
    mkdirSync(join(root, 'qs-assistant'), { recursive: true })
    writeFileSync(join(root, 'qs-assistant', 'SKILL.md'), '# qs\\n')
    mkdirSync(join(root, 'qs-assistant', 'scripts'), { recursive: true })
    writeFileSync(join(root, 'qs-assistant', 'scripts', 'run.sh'), 'echo hi\\n')
    return root
  }

  it('carries every skill the records name, with its files', () => {
    const { archive } = packHumans(home, [human({ skills: ['qs-assistant'] })], { skillsRoot: skillsRoot() })
    const files = Object.keys(readTar(gunzipSync(archive)))
    expect(files).toContain('skills/qs-assistant/SKILL.md')
    expect(files).toContain('skills/qs-assistant/scripts/run.sh')
  })

  it('installs a carried skill into the global root on import', async () => {
    const { archive } = packHumans(home, [human({ skills: ['qs-assistant'] })], { skillsRoot: skillsRoot() })
    const target = join(home, 'fresh-skills')
    const result = await unpackHumans(home, archive, { skillsRoot: target })
    expect(result.skills?.installed).toEqual(['qs-assistant'])
    expect(readFileSync(join(target, 'qs-assistant', 'SKILL.md'), 'utf8')).toContain('qs')
    expect(existsSync(join(target, 'qs-assistant', 'scripts', 'run.sh'))).toBe(true)
  })

  it('leaves a skill this machine already has alone', async () => {
    const { archive } = packHumans(home, [human({ skills: ['qs-assistant'] })], { skillsRoot: skillsRoot() })
    const target = join(home, 'local-skills')
    mkdirSync(join(target, 'qs-assistant'), { recursive: true })
    writeFileSync(join(target, 'qs-assistant', 'SKILL.md'), '# local edit\\n')
    const result = await unpackHumans(home, archive, { skillsRoot: target })
    expect(result.skills?.kept).toEqual(['qs-assistant'])
    expect(readFileSync(join(target, 'qs-assistant', 'SKILL.md'), 'utf8')).toContain('local edit')
  })
})
