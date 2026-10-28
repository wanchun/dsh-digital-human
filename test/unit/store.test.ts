import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HumanStore, defaultHome, normalizeHuman, parsePersona, personaText } from '../../src/lib/store'

let home = ''
let store: HumanStore

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dh-store-'))
  store = new HumanStore(home)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const PNG_ICON = 'data:image/png;base64,iVBORw0KGgo='

const record = (patch: Record<string, unknown> = {}) => ({
  id: 'one',
  name: 'One',
  description: '',
  enabled: true,
  systemPrompt: 'x',
  workspace: '',
  skills: [],
  peers: [],
  im: { botId: '', targetId: '' },
  subscriptions: [],
  memory: false,
  ...patch,
})

describe('defaultHome', () => {
  it('sits under the harness home', () => {
    expect(defaultHome()).toContain('digital-human')
  })
})

describe('normalizeHuman', () => {
  it('defaults every field of a minimal record', () => {
    const human = normalizeHuman({ id: 'a' })
    expect(human).toMatchObject({
      id: 'a', name: 'a', description: '', enabled: true, systemPrompt: '', workspace: '',
      skills: [], peers: [], subscriptions: [], memory: true, sessionMode: 'thread',
    })
    expect(human.createdAt).toBeTypeOf('string')
  })

  it('drops a field it does not know', () => {
    expect((normalizeHuman({ id: 'a', surprise: 1 }) as Record<string, unknown>).surprise).toBeUndefined()
  })

  it('refuses a record that is not an object', () => {
    expect(() => normalizeHuman(null)).toThrow(/must be an object/)
    expect(() => normalizeHuman('x')).toThrow(/must be an object/)
  })

  it('refuses a bad id', () => {
    expect(() => normalizeHuman({ id: 'Not A Slug' })).toThrow()
    expect(() => normalizeHuman({})).toThrow()
  })

  it('keeps an owner that a slug rule would reject', () => {
    const human = normalizeHuman({ id: 'a', im: { owner: ' wohR_KCgAANNc-oBb9Z8h20IdfWja3lA ' } })
    expect(human.im.owner).toBe('wohR_KCgAANNc-oBb9Z8h20IdfWja3lA')
  })

  it('drops an empty owner rather than storing it', () => {
    expect(normalizeHuman({ id: 'a', im: { owner: '   ' } }).im.owner).toBeUndefined()
  })

  it('reads the config bag, trimming and dropping empties', () => {
    const human = normalizeHuman({ id: 'a', config: { a: ' v ', b: '', c: '   ', '': 'orphan' } })
    expect(human.config).toEqual({ a: 'v' })
  })

  it('drops a config that ends up empty', () => {
    expect(normalizeHuman({ id: 'a', config: { a: '' } }).config).toBeUndefined()
    expect(normalizeHuman({ id: 'a' }).config).toBeUndefined()
  })

  it('refuses a config that is not an object', () => {
    expect(() => normalizeHuman({ id: 'a', config: 'nope' })).toThrow(/config must be an object/)
    expect(() => normalizeHuman({ id: 'a', config: [] })).toThrow(/config must be an object/)
  })

  it('reads a declared field, keeping only the parts it understands', () => {
    const human = normalizeHuman({
      id: 'a',
      configSchema: [{
        key: ' k ', label: ' L ', type: 'select', description: ' D ', default: ' d ',
        required: true, hidden: true, options: [{ label: ' A ', value: ' a ' }], from: 'owner_chat', junk: 1,
      }],
    })
    expect(human.configSchema).toEqual([{
      key: 'k', label: 'L', type: 'select', description: 'D', default: 'd',
      required: true, hidden: true, options: [{ label: 'A', value: 'a' }], from: 'owner_chat',
    }])
  })

  it('refuses a malformed declaration instead of dropping it', () => {
    const bad = (schema: unknown) => () => normalizeHuman({ id: 'a', configSchema: schema })
    expect(bad('nope')).toThrow(/must be an array/)
    expect(bad([{ label: 'x' }])).toThrow(/need a key/)
    expect(bad([{ key: 'a', type: 'color' }])).toThrow(/unknown type/)
    expect(bad([{ key: 'a', from: 'owner_email' }])).toThrow(/unknown source/)
    expect(bad([{ key: 'a', options: [{ label: 'x' }] }])).toThrow(/no label or value/)
    expect(bad([{ key: 'a', options: ['x'] }])).toThrow(/malformed option/)
  })

  it('drops a declaration list that ends up empty', () => {
    expect(normalizeHuman({ id: 'a', configSchema: [] }).configSchema).toBeUndefined()
  })

  it('keeps a valid icon and refuses a bad one', () => {
    expect(normalizeHuman({ id: 'a', icon: PNG_ICON }).icon).toBe(PNG_ICON)
    expect(normalizeHuman({ id: 'a', icon: '  ' }).icon).toBeUndefined()
    expect(() => normalizeHuman({ id: 'a', icon: 'https://example.com/a.png' })).toThrow(/data URI/)
    expect(() => normalizeHuman({ id: 'a', icon: 'data:image/gif;base64,AAAA' })).toThrow(/data URI/)
    expect(() => normalizeHuman({ id: 'a', icon: 'data:image/png;base64,' + 'A'.repeat(70 * 1024) })).toThrow(/exceeds/)
  })

  it('treats a null config as unset', () => {
    expect(normalizeHuman({ id: 'a', config: null }).config).toBeUndefined()
  })

  it('drops a config entry that is not a string', () => {
    expect(normalizeHuman({ id: 'a', config: { a: 1 } }).config).toBeUndefined()
  })

  it('refuses an option whose label is not a string', () => {
    expect(() => normalizeHuman({ id: 'a', configSchema: [{ key: 'k', options: [{ label: 1, value: 'x' }] }] }))
      .toThrow(/no label or value/)
  })

  it('refuses a list entry that is empty or not a string', () => {
    expect(() => normalizeHuman({ id: 'a', skills: [''] })).toThrow(/non-empty strings/)
    expect(() => normalizeHuman({ id: 'a', peers: [1] })).toThrow(/non-empty strings/)
  })

  it('refuses an option with an empty label or value', () => {
    expect(() => normalizeHuman({ id: 'a', configSchema: [{ key: 'k', options: [{ label: '', value: 'x' }] }] }))
      .toThrow(/no label or value/)
  })
})

describe('the persona file', () => {
  it('round-trips the body byte for byte', () => {
    const body = '# 角色\n\n你是 PM。\n\n---\n\n保留这段分隔线。'
    const text = personaText(normalizeHuman({ id: 'pm', name: 'PM', description: 'd', systemPrompt: body }))
    const parsed = parsePersona(text, 'pm')
    expect(parsed.name).toBe('PM')
    expect(parsed.description).toBe('d')
    expect(parsed.body).toBe(body)
  })

  it('refuses a file without a frontmatter block', () => {
    expect(() => parsePersona('no frontmatter', 'a')).toThrow(/frontmatter/)
  })

  it('refuses a block that never closes', () => {
    expect(() => parsePersona('---\nname: A\n', 'a')).toThrow(/closing/)
  })
})

describe('HumanStore reads', () => {
  it('reports the registry directory', () => {
    expect(store.file).toBe(join(home, 'humans'))
  })

  it('seeds one directory per record on first read', async () => {
    const seeded = await store.list([record({ id: 'seed' })])
    expect(seeded.map((entry) => entry.id)).toEqual(['seed'])
    expect(existsSync(store.personaPath('seed'))).toBe(true)
    expect(existsSync(store.configPath('seed'))).toBe(true)
    expect(await readFile(store.personaPath('seed'), 'utf8')).toContain('name: One')
    expect(JSON.parse(await readFile(store.configPath('seed'), 'utf8')).enabled).toBe(true)
  })

  it('resolves by id, then by display name', async () => {
    await store.upsert(record({ id: 'a', name: 'Alpha' }))
    expect((await store.get('a'))?.id).toBe('a')
    expect((await store.get('Alpha'))?.id).toBe('a')
    expect(await store.get('nobody')).toBeUndefined()
  })

  it('lists a copy, so a caller cannot mutate the registry', async () => {
    await store.upsert(record({ id: 'a' }))
    const first = await store.list()
    first.push(normalizeHuman({ id: 'b' }))
    expect((await store.list()).map((entry) => entry.id)).toEqual(['a'])
  })

  it('re-reads after an external edit', async () => {
    await store.upsert(record({ id: 'a' }))
    const current = await store.get('a')
    await writeFile(store.personaPath('a'), personaText({ ...current, name: 'Hand Edited' }), 'utf8')
    expect((await store.list()).map((entry) => entry.name)).toEqual(['Hand Edited'])
  })

  it('does not rewrite updatedAt just because it read the files', async () => {
    await store.upsert(record({ id: 'a' }))
    const written = JSON.parse(await readFile(store.configPath('a'), 'utf8')).updatedAt
    await store.upsert(record({ id: 'b' }))
    const reloaded = await store.get('a')
    expect(reloaded?.updatedAt).toBe(written)
  })

  it('refuses a config that is not a JSON object', async () => {
    await store.upsert(record({ id: 'a' }))
    await writeFile(store.configPath('a'), JSON.stringify([]), 'utf8')
    await expect(store.list()).rejects.toThrow(/must hold a JSON object/)
  })

  it('refuses to run while a legacy combined file is unmigrated', async () => {
    await writeFile(join(home, 'humans.json'), JSON.stringify([record({ id: 'legacy' })]), 'utf8')
    await expect(store.list()).rejects.toThrow(/migrate/)
  })

  it('refuses a record whose persona has no config file', async () => {
    await store.upsert(record({ id: 'a' }))
    await rm(store.configPath('a'))
    await expect(store.list()).rejects.toThrow(/has no config.json/)
  })

  it('reads a record from its config alone when no persona exists yet', async () => {
    await store.upsert(record({ id: 'a', name: 'A' }))
    await rm(store.personaPath('a'))
    expect(await store.get('a')).toMatchObject({ id: 'a', name: 'a', systemPrompt: '' })
  })

  it('ignores a plain file and a non-record directory under the registry root', async () => {
    await store.upsert(record({ id: 'a' }))
    await writeFile(join(home, 'humans', 'stray.txt'), 'x', 'utf8')
    await mkdir(join(home, 'humans', 'not a slug'), { recursive: true })
    expect((await store.list()).map((entry) => entry.id)).toEqual(['a'])
  })

  it('refuses a malformed persona line and a config that is not JSON', async () => {
    await store.upsert(record({ id: 'a' }))
    await writeFile(store.personaPath('a'), '---\nnot a key line\n---\n', 'utf8')
    await expect(store.list()).rejects.toThrow(/malformed line/)
    await writeFile(store.personaPath('a'), personaText(normalizeHuman(record({ id: 'a' }))), 'utf8')
    await writeFile(store.configPath('a'), '{ not json', 'utf8')
    await expect(store.list()).rejects.toThrow(/not valid JSON/)
  })

  it('falls back to the id when the persona names none', async () => {
    await store.upsert(record({ id: 'a', name: 'A' }))
    await writeFile(store.personaPath('a'), '---\nname:\ndescription:\n---\nbody', 'utf8')
    expect((await store.get('a'))?.name).toBe('a')
  })

  it('reads a persona with no description and no body', async () => {
    await store.upsert(record({ id: 'a' }))
    await writeFile(store.personaPath('a'), '---\nname: A\n---', 'utf8')
    expect(await store.get('a')).toMatchObject({ name: 'A', description: '', systemPrompt: '' })
  })

  it('ignores a directory link that points nowhere', async () => {
    await store.upsert(record({ id: 'a' }))
    symlinkSync(join(home, 'no-such-target'), join(home, 'humans', 'link'))
    expect((await store.list()).map((entry) => entry.id)).toEqual(['a'])
  })

  it('round-trips the config bag, the declared schema and the owner', async () => {
    await store.upsert(record({
      id: 'a',
      im: { botId: 'wecom_1', targetId: 'direct:x', owner: 'wohR' },
      config: { k: 'v' },
      configSchema: [{ key: 'k' }],
    }))
    const found = await store.get('a')
    expect(found?.config).toEqual({ k: 'v' })
    expect(found?.configSchema).toEqual([{ key: 'k' }])
    expect(found?.im).toMatchObject({ botId: 'wecom_1', targetId: 'direct:x', owner: 'wohR' })
  })

  it('does not seed over an existing empty registry root', async () => {
    await store.ensureDir(join(home, 'humans'))
    expect(await store.list([record({ id: 'seed' })])).toEqual([])
  })

  it('reads a config with no timestamps as a fresh record', async () => {
    await store.ensureDir(store.dir('a'))
    await writeFile(store.configPath('a'), JSON.stringify({ enabled: true }), 'utf8')
    const found = await store.get('a')
    expect(found?.createdAt).toBeTypeOf('string')
    expect(found?.updatedAt).toBeTypeOf('string')
  })
})

describe('HumanStore writes', () => {
  it('creates, updates and removes', async () => {
    await store.upsert(record({ id: 'a', name: 'A' }))
    const updated = await store.upsert(record({ id: 'a', name: 'A2', enabled: false }))
    expect(updated.name).toBe('A2')
    expect((await store.list()).length).toBe(1)
    expect(await store.remove('a')).toBe(true)
    expect(await store.remove('a')).toBe(false)
    expect(await store.list()).toEqual([])
  })

  it('keeps memory and conversation state on removal', async () => {
    await store.upsert(record({ id: 'a' }))
    await writeFile(store.memoryPath('a'), 'remember this', 'utf8')
    await store.remove('a')
    expect(existsSync(store.personaPath('a'))).toBe(false)
    expect(existsSync(store.configPath('a'))).toBe(false)
    expect(existsSync(store.memoryPath('a'))).toBe(true)
  })

  it('reports a removal failure that is not a missing file', async () => {
    await store.upsert(record({ id: 'a' }))
    await rm(store.personaPath('a'))
    await mkdir(store.personaPath('a'), { recursive: true })
    await expect(store.remove('a')).rejects.toThrow()
  })

  it('persists the escalation window and drops one no window can use', async () => {
    await store.upsert(record({ id: 'a', escalationDeadlineMinutes: 5 }))
    expect((await store.get('a'))?.escalationDeadlineMinutes).toBe(5)
    expect(JSON.parse(await readFile(store.configPath('a'), 'utf8')).escalationDeadlineMinutes).toBe(5)
    await store.upsert(record({ id: 'b', escalationDeadlineMinutes: 0 }))
    expect((await store.get('b'))?.escalationDeadlineMinutes).toBeUndefined()
    await store.upsert(record({ id: 'c', escalationDeadlineMinutes: 'soon' as unknown as number }))
    expect((await store.get('c'))?.escalationDeadlineMinutes).toBeUndefined()
  })

  it('persists the session mode in the config file', async () => {
    await store.upsert(record({ id: 'qa', sessionMode: 'single' }))
    expect((await store.get('qa'))?.sessionMode).toBe('single')
    expect(JSON.parse(await readFile(store.configPath('qa'), 'utf8')).sessionMode).toBe('single')
  })

  it('round-trips the icon and clears it when saved empty', async () => {
    await store.upsert(record({ id: 'a', icon: PNG_ICON }))
    expect((await store.get('a'))?.icon).toBe(PNG_ICON)
    expect(JSON.parse(await readFile(store.configPath('a'), 'utf8')).icon).toBe(PNG_ICON)
    await store.upsert(record({ id: 'a', icon: '' }))
    expect((await store.get('a'))?.icon).toBeUndefined()
    expect(JSON.parse(await readFile(store.configPath('a'), 'utf8')).icon).toBeUndefined()
  })

  it('keeps createdAt across an update', async () => {
    const first = await store.upsert(record({ id: 'a' }))
    const second = await store.upsert(record({ id: 'a', name: 'A2' }))
    expect(second.createdAt).toBe(first.createdAt)
  })

  it('replaces the whole registry when asked to', async () => {
    await store.upsert(record({ id: 'a' }))
    await store.write([normalizeHuman(record({ id: 'z' }))])
    expect((await store.list()).map((entry) => entry.id)).toEqual(['z'])
    expect(existsSync(store.personaPath('a'))).toBe(false)
  })

  it('leaves a directory whose name is not a record alone when replacing', async () => {
    await store.upsert(record({ id: 'a' }))
    await mkdir(join(home, 'humans', 'not a slug'), { recursive: true })
    await store.write([normalizeHuman(record({ id: 'z' }))])
    expect(existsSync(join(home, 'humans', 'not a slug'))).toBe(true)
  })

  it('removes a record whose persona file already disappeared', async () => {
    await store.upsert(record({ id: 'a' }))
    await rm(store.personaPath('a'))
    expect(await store.remove('a')).toBe(true)
    expect(existsSync(store.configPath('a'))).toBe(false)
  })

  it('never reuses a temp file name, so a rewrite cannot collide', async () => {
    await Promise.all([
      store.upsert(record({ id: 'a' })),
      store.upsert(record({ id: 'b' })),
      store.upsert(record({ id: 'c' })),
    ])
    expect((await store.list()).map((entry) => entry.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('serialises a read-modify-write, so no update is lost', async () => {
    await Promise.all(Array.from({ length: 8 }, (_value, at) => store.upsert(record({ id: `n${at}` }))))
    const ids = (await store.list()).map((entry) => entry.id)
    expect(ids.length).toBe(8)
    expect(new Set(ids).size).toBe(8)
  })

  it('keeps the chain alive after a failed write', async () => {
    const failing = new HumanStore(join(home, 'missing-dir', 'nested'))
    await failing.upsert(record({ id: 'a' }))
    expect((await failing.list()).map((entry) => entry.id)).toEqual(['a'])
  })
})

describe('legacy migration', () => {
  const legacyRecord = (patch: Record<string, unknown> = {}) => ({
    id: 'one', name: 'One', enabled: true, systemPrompt: 'prompt', ...patch,
  })
  const writeLegacy = (records: unknown[]) => writeFile(join(home, 'humans.json'), JSON.stringify(records), 'utf8')

  it('previews without writing, backing up or deleting', async () => {
    await writeLegacy([legacyRecord({ id: 'a' }), legacyRecord({ id: 'b' })])
    const result = await store.migrateLegacy({ dryRun: true })
    expect(result.records.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(result.backup).toBeUndefined()
    expect(existsSync(join(home, 'humans'))).toBe(false)
    expect(existsSync(join(home, 'humans.json'))).toBe(true)
  })

  it('migrates, backs up and removes the legacy file', async () => {
    await writeLegacy([legacyRecord({ id: 'a', systemPrompt: 'line1\nline2' })])
    const result = await store.migrateLegacy()
    expect(result.records.map((entry) => entry.id)).toEqual(['a'])
    expect(existsSync(store.personaPath('a'))).toBe(true)
    expect(existsSync(join(home, 'humans.json'))).toBe(false)
    expect(result.backup !== undefined && existsSync(result.backup)).toBe(true)
    expect((await store.get('a'))?.systemPrompt).toBe('line1\nline2')
  })

  it('is a no-op when there is no legacy file', async () => {
    expect(await store.migrateLegacy()).toMatchObject({ records: [], reason: 'no legacy registry' })
  })

  it('refuses a target directory that already holds a record', async () => {
    await store.upsert(record({ id: 'a' }))
    await writeLegacy([legacyRecord({ id: 'a' })])
    await expect(store.migrateLegacy()).rejects.toThrow(/already has a record directory/)
    expect(existsSync(join(home, 'humans.json'))).toBe(true)
  })

  it('refuses a legacy file that is not an array', async () => {
    await writeFile(join(home, 'humans.json'), JSON.stringify({ nope: true }), 'utf8')
    await expect(store.migrateLegacy()).rejects.toThrow(/JSON array/)
  })

  it('collapses whitespace in a frontmatter field when comparing', async () => {
    await writeLegacy([legacyRecord({ id: 'a', name: 'A  B', description: 'x\n y' })])
    await store.migrateLegacy()
    expect((await store.get('a'))?.name).toBe('A B')
  })

  it('is idempotent', async () => {
    await writeLegacy([legacyRecord({ id: 'a' })])
    await store.migrateLegacy()
    expect(await store.migrateLegacy()).toMatchObject({ records: [], reason: 'no legacy registry' })
  })
})

describe('HumanStore paths', () => {
  it('keeps one private directory per human', () => {
    expect(store.dir('a')).toBe(join(home, 'humans', 'a'))
    expect(store.personaPath('a')).toBe(join(home, 'humans', 'a', 'persona.md'))
    expect(store.configPath('a')).toBe(join(home, 'humans', 'a', 'config.json'))
    expect(store.memoryPath('a')).toBe(join(home, 'humans', 'a', 'memory.md'))
    expect(store.sessionIndexPath('a')).toBe(join(home, 'humans', 'a', 'sessions.json'))
  })

  it('encodes a colon in a conversation id, because a filename cannot carry one', () => {
    const path = store.conversationPath('a', 'app-chat:dev:http:direct:slug')
    expect(path.endsWith('.jsonl')).toBe(true)
    expect(path.split('/').pop()).not.toContain(':')
    expect(path).toContain('app-chat%3Adev')
  })

  it('leaves a plain conversation id alone', () => {
    expect(store.conversationPath('a', 'main').endsWith('/main.jsonl')).toBe(true)
  })

  it('creates a directory on request', async () => {
    await store.ensureDir(store.dir('a'))
    expect((await store.list()).length).toBe(0)
  })
})
