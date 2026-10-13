import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HumanStore, defaultHome, normalizeHuman } from '../../src/lib/store'

let home = ''
let store: HumanStore

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dh-store-'))
  store = new HumanStore(home)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

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
      skills: [], peers: [], subscriptions: [], memory: true,
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
    // The real sender id carries uppercase and hyphens.
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
    // A silently ignored field leaves a persona reading a placeholder that never
    // resolves, which is far harder to notice than a refused save.
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
})

describe('HumanStore reads', () => {
  it('reports its file path', () => {
    expect(store.file).toBe(join(home, 'humans.json'))
  })

  it('seeds the file on first read', async () => {
    const seeded = await store.list([record({ id: 'seed' })])
    expect(seeded.map((entry) => entry.id)).toEqual(['seed'])
    expect(await readFile(store.file, 'utf8')).toContain('seed')
  })

  it('resolves by id, then by display name', async () => {
    await store.upsert(record({ id: 'a', name: 'Alpha' }))
    expect((await store.get('a'))?.id).toBe('a')
    expect((await store.get('Alpha'))?.id).toBe('a')
    expect(await store.get('nobody')).toBeUndefined()
  })

  it('lists a copy, so a caller cannot mutate the cache', async () => {
    await store.upsert(record({ id: 'a' }))
    const first = await store.list()
    first.push(normalizeHuman({ id: 'b' }))
    expect((await store.list()).map((entry) => entry.id)).toEqual(['a'])
  })

  it('re-reads after an external edit', async () => {
    await store.upsert(record({ id: 'a' }))
    await writeFile(store.file, JSON.stringify([record({ id: 'hand-edited' })]), 'utf8')
    // The mtime is the cache key, and a same-millisecond write is indistinguishable
    // from the cached read — so the stamp is pushed back to force a re-read.
    const future = new Date(Date.now() + 2000)
    await utimes(store.file, future, future)
    expect((await store.list()).map((entry) => entry.id)).toEqual(['hand-edited'])
  })

  it('does not rewrite updatedAt just because it read the file', async () => {
    await store.upsert(record({ id: 'a' }))
    const written = JSON.parse(await readFile(store.file, 'utf8'))[0].updatedAt
    await store.upsert(record({ id: 'b' }))
    const reloaded = await store.get('a')
    expect(reloaded?.updatedAt).toBe(written)
  })

  it('refuses a file that is not an array', async () => {
    await writeFile(store.file, JSON.stringify({ nope: true }), 'utf8')
    await expect(store.list()).rejects.toThrow(/must hold a JSON array/)
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

  it('keeps createdAt across an update', async () => {
    const first = await store.upsert(record({ id: 'a' }))
    const second = await store.upsert(record({ id: 'a', name: 'A2' }))
    expect(second.createdAt).toBe(first.createdAt)
  })

  it('replaces the whole registry when asked to', async () => {
    await store.upsert(record({ id: 'a' }))
    await store.write([normalizeHuman(record({ id: 'z' }))])
    expect((await store.list()).map((entry) => entry.id)).toEqual(['z'])
  })

  it('never reuses a temp file name, so a rewrite cannot collide', async () => {
    // The temp name is per-process and counted: a fixed name lets two writers in one
    // process rename over each other, and the loser fails with ENOENT.
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
    // A rejected operation must not strand every later one behind it.
    const failing = new HumanStore(join(home, 'missing-dir', 'nested'))
    await failing.upsert(record({ id: 'a' }))
    expect((await failing.list()).map((entry) => entry.id)).toEqual(['a'])
  })
})

describe('HumanStore paths', () => {
  it('keeps one private directory per human', () => {
    expect(store.dir('a')).toBe(join(home, 'humans', 'a'))
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
