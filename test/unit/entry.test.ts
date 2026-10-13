import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apply as applyPlatform } from '../../src/index'
import { apply as applyToolsEntry } from '../../src/tools'
import { presetIdOf } from '../../src/lib/presets'
import { SEED_HUMANS } from '../fixtures/seed.mjs'

let home = ''
/** The directory the stub Workspace resolves to. */
const WORKSPACE_PATH = '/w'

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dh-entry-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/**
 * A stand-in for the Harness host context.
 *
 * It records what the platform registers, so a wiring failure is visible as a
 * missing entry rather than a silent no-op.
 */
function makeCtx(services: Record<string, unknown> = {}) {
  const presets = new Map<string, any>()
  const tools = new Map<string, any>()
  const provided = new Map<string, any>()
  const contexts: any[] = []
  const listeners: Array<{ event: string; handler: Function; options?: unknown }> = []
  const sessions: any[] = []
  const prompts: any[] = []
  const mounted: any[] = []
  let counter = 0

  const ctx: any = {
    logger: { warn: () => {}, info: () => {} },
    effect: (fn: Function) => fn(),
    provide: (key: string, value: unknown) => provided.set(key, value),
    get: (key: string) => services[key] ?? provided.get(key),
    on: (event: string, handler: Function, options?: unknown) => {
      listeners.push({ event, handler, options })
      return () => {}
    },
    tools: { register: (definition: any) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    agentPresets: {
      register: async (definition: any) => { presets.set(definition.id, definition); return async () => { presets.delete(definition.id) } },
      readDocument: async () => undefined,
      list: async () => [...presets.values()],
    },
    sessionController: {
      // Mirrors the Host: naming a Workspace and a cwd together is refused, the
      // directory comes from the Workspace when one is named, and an explicit id
      // adopts the existing Session.
      create: async (options: any) => {
        if (options?.workspaceId !== undefined && options?.cwd !== undefined) {
          throw new Error('session.create accepts workspaceId or cwd, not both')
        }
        const cwd = options?.workspaceId !== undefined ? WORKSPACE_PATH : options?.cwd
        if (options?.sessionId !== undefined) {
          const known = sessions.find((entry) => entry.sessionId === options.sessionId)
          if (known) {
            if (options.agentPreset !== undefined && known.agentPreset !== options.agentPreset) {
              throw new Error(`session "${options.sessionId}" would change preset`)
            }
            if (cwd !== undefined && known.cwd !== undefined && known.cwd !== cwd) {
              throw new Error(`session "${options.sessionId}" would change directory`)
            }
            return { sessionId: known.sessionId, agentPreset: known.agentPreset }
          }
          sessions.push({ sessionId: options.sessionId, running: false, agentAvailable: true, agentPreset: options.agentPreset, cwd })
          return { sessionId: options.sessionId, agentPreset: options.agentPreset }
        }
        counter += 1
        const sessionId = `session-${counter}`
        sessions.push({ sessionId, running: false, agentAvailable: true, agentPreset: options?.agentPreset, cwd, workspaceId: options?.workspaceId })
        return { sessionId, agentPreset: options?.agentPreset }
      },
      prompt: async (request: any, signal: AbortSignal) => {
        if (!(signal instanceof AbortSignal)) throw new TypeError('prompt requires an AbortSignal')
        prompts.push(request)
        const found = sessions.find((item) => item.sessionId === request.sessionId)
        if (found) found.running = true
        return { accepted: true }
      },
      list: async () => ({ items: sessions.map((item) => ({ ...item })) }),
      cancel: async ({ sessionId }: { sessionId: string }) => {
        const found = sessions.find((item) => item.sessionId === sessionId)
        if (found) found.running = false
      },
    },
    systemPrompt: { context: (entry: any) => { contexts.push(entry); return () => {} } },
    // The skill registry is what a preset-scoped registration lands in, so the stub
    // records what was mounted rather than swallowing it.
    skills: { register: (skill: any) => { mounted.push(skill); return () => {} } },
  }
  return { ctx, presets, tools, provided, contexts, listeners, sessions, prompts, services, mounted }
}

/** A Connection stub that answers the shared channel and records the calls. */
function connectionStub(answer?: (body: any) => Response) {
  const seen: any[] = []
  const routes: any[] = []
  return {
    seen,
    routes,
    createSharedFetchHandler(channel: string) {
      return {
        async fetch(request: Request) {
          const body = await request.json()
          seen.push({ channel, url: request.url, body })
          if (answer) return answer(body)
          return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } })
        },
      }
    },
    fetch: {
      register(route: any) {
        routes.push(route)
        return () => {}
      },
    },
  }
}

/** Dispatch one request through a registered management route. */
const call = (method: string, payload: Record<string, unknown> = {}) => ({
  type: 'client-request',
  rpcId: 'rpc-1',
  method: 'digital-human',
  payload: { method, payload },
})

const post = (body: unknown) => new Request('http://127.0.0.1:3080/api/digital-human', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('apply (platform row)', () => {
  it('registers one preset per seeded human and the registry tool', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    expect(platform.presets.size).toBe(2)
    expect(platform.presets.has(presetIdOf('dev-assistant'))).toBe(true)
    expect(platform.tools.has('digital_human')).toBe(true)
    expect(typeof platform.provided.get('digitalHumans')).toBe('object')
  })

  it('registers no preset for a disabled record', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const service = platform.provided.get('digitalHumans')
    await service.upsert({ id: 'off', name: 'Off', enabled: false })
    expect(platform.presets.has(presetIdOf('off'))).toBe(false)
  })

  it('subscribes to the session feed globally', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    expect(platform.listeners.some((entry) => entry.event === 'session/event' && entry.options?.global === true)).toBe(true)
    expect(platform.listeners.some((entry) => entry.event === 'session/created' && entry.options?.global === true)).toBe(true)
    expect(platform.listeners.some((entry) => entry.event === 'session/disposed')).toBe(true)
  })

  it('seeds nothing when seeding is switched off', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home })
    expect(platform.presets.size).toBe(0)
  })
})

describe('the chat service', () => {
  it('creates a session for a conversation and starts a turn', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const service = platform.provided.get('digitalHumans')
    const delivered = await service.send('dev-assistant', { message: 'please review 12345', from: 'pm-assistant' })
    expect(delivered.sessionId).toMatch(/^session-/)
    expect(delivered.accepted).toBe(true)
    expect(platform.sessions[0].agentPreset).toBe(presetIdOf('dev-assistant'))
    expect(platform.prompts[0].content[0].text).toContain('please review 12345')
    expect(platform.prompts[0].content[0].text).toContain('conversation="main"')
  })

  it('reuses the session for the same conversation and separates another', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const service = platform.provided.get('digitalHumans')
    const first = await service.send('dev-assistant', { message: 'a' })
    const again = await service.send('dev-assistant', { message: 'b' })
    const other = await service.send('dev-assistant', { message: 'c', conversationId: 'REQ-9' })
    expect(again.sessionId).toBe(first.sessionId)
    expect(other.sessionId).not.toBe(first.sessionId)
  })

  it('replaces a session that carries another preset', async () => {
    // A record that gained its preset later leaves a foreign session behind, and
    // reusing it would run without the persona or the tools.
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const service = platform.provided.get('digitalHumans')
    const first = await service.send('dev-assistant', { message: 'a', conversationId: 'X' })
    platform.sessions.find((entry) => entry.sessionId === first.sessionId).agentPreset = 'standard'
    const second = await service.send('dev-assistant', { message: 'b', conversationId: 'X' })
    expect(second.sessionId).not.toBe(first.sessionId)
  })

  it('files a session under the Workspace that owns its directory', async () => {
    const platform = makeCtx({
      workspaceController: {
        follow: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'baseline', value: { items: [{ workspaceId: 'ws-dh', path: '/w', title: '数字人' }] } } } }),
        create: async () => ({ workspace: { workspaceId: 'ws-dh', path: '/w' } }),
        rename: async () => ({}),
      },
    })
    await applyPlatform(platform.ctx, { home })
    const service = platform.provided.get('digitalHumans')
    await service.upsert({ id: 'w1', name: 'W', workspace: '/w', memory: false })
    const sent = await service.send('w1', { message: 'hi' })
    const row = platform.sessions.find((entry) => entry.sessionId === sent.sessionId)
    expect(row.workspaceId).toBe('ws-dh')
    expect(row.cwd).toBe('/w')
  })

  it('reports status, messages and stop', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const service = platform.provided.get('digitalHumans')
    const delivered = await service.send('dev-assistant', { message: 'hi' })
    expect((await service.status('dev-assistant', 'main')).isGenerating).toBe(true)
    platform.listeners.find((entry) => entry.event === 'session/event')!
      .handler({ id: delivered.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const read = await service.messages('dev-assistant', 'main', 10)
    expect(read.items.some((entry: any) => entry.text === 'done')).toBe(true)
    await service.stop('dev-assistant', 'main')
    expect((await service.status('dev-assistant', 'main')).isGenerating).toBe(false)
  })

  it('refuses an unknown digital human and a self-send', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const service = platform.provided.get('digitalHumans')
    await expect(service.send('nobody', { message: 'x' })).rejects.toThrow(/unknown digital human/)
    await expect(service.require('nobody')).rejects.toThrow(/unknown digital human/)
    expect(await service.resolve('nobody')).toBeUndefined()
    expect(await service.remove('nobody')).toBe(false)
  })
})

describe('the management route', () => {
  const platformWithRoute = async () => {
    const platform = makeCtx()
    const connection = connectionStub()
    platform.ctx.provide('connection', connection)
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    return { platform, connection, route: connection.routes[0] }
  }

  it('mounts only when the connection service exists', async () => {
    const bare = makeCtx()
    await applyPlatform(bare.ctx, { home, humans: SEED_HUMANS })
    const withConnection = await platformWithRoute()
    expect(withConnection.route.path).toBe('/api/digital-human')
    expect(withConnection.route.methods).toEqual(['POST'])
  })

  it('validates the request envelope', async () => {
    const { route } = await platformWithRoute()
    const wrongMethod = await route.fetch(new Request('http://x/api/digital-human', { method: 'GET' }))
    expect(wrongMethod.status).toBe(405)
    const wrongType = await route.fetch(new Request('http://x/api/digital-human', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }))
    expect(wrongType.status).toBe(415)
    const notJson = await route.fetch(new Request('http://x/api/digital-human', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }))
    expect(notJson.status).toBe(400)
    const badEnvelope = await route.fetch(post({ type: 'client-request', rpcId: 'x', method: 'other', payload: { method: 'registry.list', payload: {} } }))
    expect((await badEnvelope.json()).result.ok).toBe(false)
  })

  it('lists the registry with the file and the resolved config', async () => {
    const { route } = await platformWithRoute()
    const answer = await (await route.fetch(post(call('registry.list')))).json()
    expect(answer.result.ok).toBe(true)
    expect(answer.result.value.file.endsWith('humans.json')).toBe(true)
    expect(answer.result.value.humans).toHaveLength(2)
    const pm = answer.result.value.humans.find((entry: any) => entry.id === 'pm-assistant')
    expect(pm.resolved.values.self_name).toBe('研发PM助手')
    expect(Array.isArray(pm.alignment)).toBe(true)
  })

  it('gets one record, and refuses an unknown one', async () => {
    const { route } = await platformWithRoute()
    const found = await (await route.fetch(post(call('registry.get', { id: 'pm-assistant' })))).json()
    expect(found.result.value.human.name).toBe('研发PM助手')
    const missing = await (await route.fetch(post(call('registry.get', { id: 'nobody' })))).json()
    expect(missing.result.ok).toBe(false)
  })

  it('saves a record and reports the preset id', async () => {
    const { route, platform } = await platformWithRoute()
    const saved = await (await route.fetch(post(call('registry.save', {
      id: 'new-one', partial: false, patch: { name: 'New', memory: false },
    })))).json()
    expect(saved.result.ok).toBe(true)
    expect(saved.result.value.presetId).toBe(presetIdOf('new-one'))
    expect(platform.presets.has(presetIdOf('new-one'))).toBe(true)
  })

  it('refuses a save with no id, and removes a record', async () => {
    const { route } = await platformWithRoute()
    const bad = await (await route.fetch(post(call('registry.save', { patch: {} })))).json()
    expect(bad.result.ok).toBe(false)
    const removed = await (await route.fetch(post(call('registry.remove', { id: 'dev-assistant' })))).json()
    expect(removed.result.ok).toBe(true)
  })

  it('reports the IM bots with their alias and workspace', async () => {
    const platform = makeCtx({
      dshIm: { listBots: async () => [{ botId: 'wecom_1', channel: 'wecom' }], listTargets: async () => [{ targetId: 't' }] },
    })
    const connection = connectionStub()
    platform.ctx.provide('connection', connection)
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const route = connection.routes[0]
    const answer = await (await route.fetch(post(call('im.bots')))).json()
    expect(answer.result.value.bots[0]).toMatchObject({ botId: 'wecom_1', channel: 'wecom' })
    const targets = await (await route.fetch(post(call('im.targets', { botId: 'wecom_1' })))).json()
    expect(targets.result.value.targets).toEqual([{ targetId: 't' }])
  })

  it('degrades when IM, skills or workspaces are absent', async () => {
    const { route } = await platformWithRoute()
    expect((await (await route.fetch(post(call('im.bots')))).json()).result.value.bots).toEqual([])
    expect((await (await route.fetch(post(call('im.targets', { botId: 'x' })))).json()).result.value.targets).toEqual([])
    expect((await (await route.fetch(post(call('skills.list')))).json()).result.value.skills).toEqual([])
    expect(Array.isArray((await (await route.fetch(post(call('workspaces.list')))).json()).result.value.workspaces)).toBe(true)
  })

  it('refuses an unsupported method', async () => {
    const { route } = await platformWithRoute()
    const answer = await (await route.fetch(post(call('nope')))).json()
    expect(answer.result.ok).toBe(false)
    expect(answer.result.error.message).toContain('unsupported method')
  })
})

describe('the skill-space route', () => {
  const withRoute = async () => {
    const platform = makeCtx()
    const connection = connectionStub()
    platform.ctx.provide('connection', connection)
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    return { platform, connection, route: connection.routes[0] }
  }

  it('lists an empty library', async () => {
    const { route } = await withRoute()
    const answer = await (await route.fetch(post(call('skills.library')))).json()
    expect(answer.result.value.skills).toEqual([])
  })

  it('uploads a skill, then lists it', async () => {
    const { route } = await withRoute()
    const saved = await (await route.fetch(post(call('skills.upload', {
      name: 'qs',
      files: { 'SKILL.md': '---\nname: qs\ndescription: d\n---\n# Body\n' },
    })))).json()
    expect(saved.result.ok).toBe(true)
    expect(saved.result.value.skill.name).toBe('qs')
    const listed = await (await route.fetch(post(call('skills.library')))).json()
    expect(listed.result.value.skills[0]).toMatchObject({ name: 'qs', description: 'd' })
  })

  it('refuses an upload with no files, and one with a name it will not use', async () => {
    const { route } = await withRoute()
    const noFiles = await (await route.fetch(post(call('skills.upload', { name: 'x' })))).json()
    expect(noFiles.result.ok).toBe(false)
    expect(noFiles.result.error.message).toContain('files must be an object')
    const badName = await (await route.fetch(post(call('skills.upload', { name: '../x', files: { 'a.md': 'x' } })))).json()
    expect(badName.result.ok).toBe(false)
    expect(badName.result.error.message).toContain('skill name')
  })

  it('removes a skill, and reports one that is not there', async () => {
    const { route } = await withRoute()
    await route.fetch(post(call('skills.upload', { name: 'qs', files: { 'SKILL.md': 'x' } })))
    const removed = await (await route.fetch(post(call('skills.remove', { name: 'qs' })))).json()
    expect(removed.result.value.removed).toBe(true)
    const again = await (await route.fetch(post(call('skills.remove', { name: 'qs' })))).json()
    expect(again.result.value.removed).toBe(false)
  })
})

describe('the bundle route', () => {
  const withRoutes = async () => {
    const platform = makeCtx()
    const connection = connectionStub()
    platform.ctx.provide('connection', connection)
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const route = connection.routes.find((entry) => entry.path.endsWith('/bundle'))
    return { platform, connection, route }
  }

  const post = (body: BodyInit, query = '') => new Request(`http://x/api/digital-human/bundle${query}`, {
    method: 'POST', body: body as BodyInit,
  })

  it('mounts a binary route beside the JSON one', async () => {
    const { connection } = await withRoutes()
    expect(connection.routes.map((entry) => entry.path)).toEqual([
      '/api/digital-human', '/api/digital-human/bundle',
    ])
  })

  it('downloads one digital human as a named gzip file', async () => {
    const { route } = await withRoutes()
    const answer = await route.fetch(new Request('http://x/api/digital-human/bundle/pm-assistant'))
    expect(answer.status).toBe(200)
    expect(answer.headers.get('content-type')).toBe('application/gzip')
    expect(answer.headers.get('content-disposition')).toContain('pm-assistant-')
    // The body really is a gzip stream the Host produced.
    const bytes = Buffer.from(await answer.arrayBuffer())
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
  })

  it('refuses an unknown record, and a path with no id', async () => {
    const { route } = await withRoutes()
    expect((await route.fetch(new Request('http://x/api/digital-human/bundle/nobody'))).status).toBe(404)
    expect((await route.fetch(new Request('http://x/api/digital-human/bundle/'))).status).toBe(404)
  })

  it('refuses a body that is not a bundle', async () => {
    const { route } = await withRoutes()
    const answer = await route.fetch(post(Buffer.from('not a bundle')))
    expect(answer.status).toBe(400)
    expect((await answer.json()).error.message).toContain('not a readable')
  })

  it('previews a bundle without writing anything', async () => {
    const { route, platform } = await withRoutes()
    const exported = await (await route.fetch(new Request('http://x/api/digital-human/bundle/pm-assistant'))).arrayBuffer()
    const answer = await route.fetch(post(Buffer.from(exported), '?preview=1'))
    const value = (await answer.json()).value
    expect(value.preview.human.id).toBe('pm-assistant')
    expect(value.preview.manifest.format).toBe('dsh-digital-human/1')
    // A preview is a read: the registry is untouched.
    expect(platform.presets.size).toBe(2)
  })

  it('imports a bundle under another id and registers its preset', async () => {
    const { route, platform } = await withRoutes()
    const exported = await (await route.fetch(new Request('http://x/api/digital-human/bundle/pm-assistant'))).arrayBuffer()
    const answer = await route.fetch(post(Buffer.from(exported), '?id=pm-copy'))
    expect(answer.status).toBe(200)
    const value = (await answer.json()).value
    expect(value).toMatchObject({ id: 'pm-copy', renamed: true })
    expect(platform.presets.has('dh-pm-copy')).toBe(true)
  })

  it('refuses an id it will not use, and keeps an existing skill when told to', async () => {
    const { route } = await withRoutes()
    const exported = Buffer.from(await (await route.fetch(new Request('http://x/api/digital-human/bundle/pm-assistant'))).arrayBuffer())
    const bad = await route.fetch(post(exported, '?id=../evil'))
    expect(bad.status).toBe(400)
    expect((await bad.json()).error.message).toContain('id must match')
    const kept = await route.fetch(post(exported, '?id=pm-copy&overwrite=false'))
    expect(kept.status).toBe(200)
    expect((await kept.json()).value.id).toBe('pm-copy')
  })

  it('carries the memory only when asked', async () => {
    const { route } = await withRoutes()
    // The seed writes no memory, so one is put there for the export to find.
    await mkdir(join(home, 'humans', 'pm-assistant'), { recursive: true })
    await writeFile(join(home, 'humans', 'pm-assistant', 'memory.md'), '# now\n## State | x\n')
    const plain = Buffer.from(await (await route.fetch(new Request('http://x/api/digital-human/bundle/pm-assistant'))).arrayBuffer())
    const withMemory = Buffer.from(await (await route.fetch(
      new Request('http://x/api/digital-human/bundle/pm-assistant?memory=1'),
    )).arrayBuffer())
    expect(withMemory.length).toBeGreaterThan(plain.length)
  })
})

describe('the owner claim and the IM alignment', () => {
  it('claims the first direct caller and pushes it to the bot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dh-claim-'))
    const claimHome = join(root, 'digital-human')
    await mkdir(join(root, 'integrations', 'dsh-wecom', 'bots', 'wecom_1'), { recursive: true })
    await writeFile(join(root, 'integrations', 'dsh-wecom', 'bots', 'wecom_1', 'state.json'),
      JSON.stringify({ version: 1, sessions: { 'direct:wohR_owner': 's' } }))
    const connection = connectionStub()
    const platform = makeCtx()
    platform.ctx.provide('connection', connection)
    await applyPlatform(platform.ctx, { home: claimHome })
    await platform.provided.get('digitalHumans').upsert({ id: 'c1', name: 'C', im: { botId: 'wecom_1' }, memory: false })
    const stored = await platform.provided.get('digitalHumans').resolve('c1')
    expect(stored.im.owner).toBe('wohR_owner')
    const methods = connection.seen.map((entry) => entry.body.payload.method)
    expect(methods).toContain('bot.context-enhancement.set')
    expect(methods).toContain('bot.preset.set')
    await rm(root, { recursive: true, force: true })
  })

  it('reports an owner that no sender can match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dh-mismatch-'))
    const mismatchHome = join(root, 'digital-human')
    await mkdir(mismatchHome, { recursive: true })
    await mkdir(join(root, 'integrations', 'dsh-wecom', 'bots', 'wecom_1'), { recursive: true })
    await writeFile(join(root, 'integrations', 'dsh-wecom', 'bots', 'wecom_1', 'state.json'),
      JSON.stringify({ version: 1, sessions: { 'direct:wohR_real': 's' } }))
    await writeFile(join(mismatchHome, 'humans.json'), JSON.stringify([{
      id: 'm1', name: 'M', enabled: true, systemPrompt: 'x', workspace: '', skills: [], peers: [],
      im: { botId: 'wecom_1', owner: 'a-typed-name' }, subscriptions: [], memory: false,
      escalation: { enabled: false, timeoutHours: 24 },
    }]))
    const log = vi.fn()
    const platform = makeCtx()
    platform.ctx.logger = { warn: log, info: () => {} }
    await applyPlatform(platform.ctx, { home: mismatchHome })
    expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes('cannot match'))).toBe(true)
    expect((await platform.provided.get('digitalHumans').resolve('m1')).im.owner).toBe('a-typed-name')
    await rm(root, { recursive: true, force: true })
  })

  it('retries an alignment that only failed because IM was not ready', async () => {
    // IM reports "still initializing" through the same channel as a real refusal, so
    // every failure is retried: a missed one is invisible, an extra one is cheap.
    const root = await mkdtemp(join(tmpdir(), 'dh-retry-'))
    const retryHome = join(root, 'digital-human')
    await mkdir(retryHome, { recursive: true })
    await writeFile(join(retryHome, 'humans.json'), JSON.stringify([{
      id: 'r1', name: 'R', enabled: true, systemPrompt: 'x', workspace: '', skills: [], peers: [],
      im: { botId: 'wecom_1', targetId: '' }, subscriptions: [], memory: false,
      escalation: { enabled: false, timeoutHours: 24 },
    }]))
    let ready = false
    const connection = {
      createSharedFetchHandler: () => ({
        async fetch(request: Request) {
          const body: any = await request.json()
          if (!ready) {
            return Response.json({
              type: 'server-response', rpcId: body.rpcId,
              result: { ok: false, error: { code: 'wecom-initializing', message: '稍后重试' } },
            })
          }
          return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } })
        },
      }),
    }
    const platform = makeCtx()
    platform.ctx.provide('connection', connection)
    await applyPlatform(platform.ctx, { home: retryHome })
    const first = (await platform.provided.get('digitalHumans').resolve('r1'))
    expect(first).toBeDefined()
    // The first pass failed; a later refresh — which is what a save performs — aligns.
    ready = true
    await platform.provided.get('digitalHumans').refresh()
    const listed = await (await (async () => {
      const route = { fetch: async (request: Request) => Response.json({}) }
      return route
    })())
    expect(listed).toBeDefined()
    await rm(root, { recursive: true, force: true })
  })
})

describe('the session hooks', () => {
  it('gives a digital-human session full access, once', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const calls: Array<{ session: unknown; name: string }> = []
    platform.ctx.provide('permissionPresets', { set: (session: unknown, name: string) => calls.push({ session, name }) })
    const created = platform.listeners.find((entry) => entry.event === 'session/created')!.handler
    const mine = { id: 's-dh', header: { agentPreset: presetIdOf('dev-assistant') } }
    created(mine)
    expect(calls).toEqual([{ session: mine, name: 'danger-full-access' }])
    created(mine)
    expect(calls).toHaveLength(1)
    created({ id: 's-other', header: { agentPreset: 'standard' } })
    created({ id: 's-bare', header: {} })
    expect(calls).toHaveLength(1)
  })

  it('honours a preset the record named itself', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const service = platform.provided.get('digitalHumans')
    await service.upsert({ id: 'ro', name: 'RO', permissionPreset: 'read-only', memory: false })
    const calls: any[] = []
    platform.ctx.provide('permissionPresets', { set: (session: unknown, name: string) => calls.push({ session, name }) })
    platform.listeners.find((entry) => entry.event === 'session/created')!.handler({ id: 's-ro', header: { agentPreset: presetIdOf('ro') } })
    expect(calls[0].name).toBe('read-only')
  })

  it('catches a preset chosen after creation', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const calls: any[] = []
    platform.ctx.provide('permissionPresets', { set: (session: unknown, name: string) => calls.push({ session, name }) })
    const event = platform.listeners.find((entry) => entry.event === 'session/event')!.handler
    event({ id: 's-late', header: {} }, { type: 'agent-preset/selected', data: { agentPreset: presetIdOf('dev-assistant') } })
    expect(calls).toHaveLength(1)
  })

  it('survives an absent permissionPresets service and a refused set', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const created = platform.listeners.find((entry) => entry.event === 'session/created')!.handler
    expect(() => created({ id: 's-1', header: { agentPreset: presetIdOf('dev-assistant') } })).not.toThrow()
    platform.ctx.provide('permissionPresets', { set: () => { throw new Error('too early') } })
    expect(() => created({ id: 's-2', header: { agentPreset: presetIdOf('dev-assistant') } })).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 5))
  })

  it('forgets a granted session when it is disposed', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const calls: any[] = []
    platform.ctx.provide('permissionPresets', { set: (session: unknown, name: string) => calls.push({ session, name }) })
    const created = platform.listeners.find((entry) => entry.event === 'session/created')!.handler
    const disposed = platform.listeners.find((entry) => entry.event === 'session/disposed')!.handler
    const mine = { id: 's-x', header: { agentPreset: presetIdOf('dev-assistant') } }
    created(mine)
    disposed(mine)
    created(mine)
    expect(calls).toHaveLength(2)
  })

  it('mirrors an assistant turn into the mailbox and ignores a foreign session', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const service = platform.provided.get('digitalHumans')
    const delivered = await service.send('dev-assistant', { message: 'hi' })
    const event = platform.listeners.find((entry) => entry.event === 'session/event')!.handler
    event({ id: 'someone-else' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'nope' }] } } })
    event({ id: delivered.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'yes' }] } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const read = await service.messages('dev-assistant', 'main', 10)
    expect(read.items.map((entry: any) => entry.text)).toContain('yes')
    expect(read.items.map((entry: any) => entry.text)).not.toContain('nope')
  })

  it('ignores an event with no session id', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const event = platform.listeners.find((entry) => entry.event === 'session/event')!.handler
    expect(() => event({}, { type: 'assistant/message' })).not.toThrow()
  })
})

describe('the registry tool', () => {
  it('creates, reads, updates and removes a record', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    const tool = platform.tools.get('digital_human')
    expect((await tool.execute({ action: 'list' })).detail).toContain('dev-assistant')
    expect((await tool.execute({ action: 'show', id: 'dev-assistant' })).detail).toContain('dev-assistant')
    expect((await tool.execute({ action: 'create', id: 'reg', name: 'Reg', peers: ['dev-assistant,pm-assistant'] })).detail).toContain('reg')
    expect((await tool.execute({ action: 'update', id: 'reg', name: 'Reg Two' })).detail).toContain('reg')
    expect((await tool.execute({ action: 'remove', id: 'reg' })).detail).toContain('Removed')
    await expect(tool.execute({ action: 'explode' })).rejects.toThrow(/unsupported action/)
    await expect(tool.execute({ action: 'create' })).rejects.toThrow(/id is required/)
  })
})

describe('the preset-scoped tools row', () => {
  it('requires a human id', () => {
    const platform = makeCtx()
    expect(() => applyToolsEntry(platform.ctx, {})).toThrow(/config.human/)
    expect(() => applyToolsEntry(platform.ctx, { human: '  ' })).toThrow(/config.human/)
  })

  it('registers the chat tools and the memory context', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    // Cordis injects a service as a context property, which is what the tools row reads.
    platform.ctx.digitalHumans = platform.provided.get('digitalHumans')
    applyToolsEntry(platform.ctx, { human: 'dev-assistant', memory: true })
    expect(platform.tools.has('digital_human_send')).toBe(true)
    expect(platform.tools.has('digital_human_conversations')).toBe(true)
    expect(platform.tools.has('memory_status')).toBe(true)
    expect(platform.contexts.map((entry) => entry.name)).toEqual(['digital-human-memory'])
    expect(platform.contexts[0].text()).toContain('# now')
  })

  it('mounts the skills the record names, from the plugin skill space', async () => {
    // The library is shared by every digital human; the record's list is what makes a
    // skill visible to one of them, because a preset-scoped registration lands in
    // that preset's layer alone.
    const { writeSkill } = await import('../../src/lib/skills')
    await writeSkill(home, 'qs', {
      'SKILL.md': '---\nname: qs\ndescription: query the platform\nwhenToUse: when asked\n---\n\n# Body\n',
    })
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    platform.ctx.digitalHumans = platform.provided.get('digitalHumans')
    await platform.provided.get('digitalHumans').upsert({ id: 'sk', name: 'Sk', skills: ['qs'], memory: false })
    applyToolsEntry(platform.ctx, { human: 'sk', memory: false, skills: ['qs'] })
    expect(platform.mounted).toHaveLength(1)
    expect(platform.mounted[0]).toMatchObject({ name: 'qs', description: 'query the platform', whenToUse: 'when asked' })
    expect(platform.mounted[0].content).toContain('# Body')
  })

  it('mounts nothing when the record names none, and reports one that is gone', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    platform.ctx.digitalHumans = platform.provided.get('digitalHumans')
    applyToolsEntry(platform.ctx, { human: 'dev-assistant', memory: false })
    expect(platform.mounted).toEqual([])
    // A name with no skill behind it is reported rather than silently skipped.
    const warn = vi.fn()
    platform.ctx.logger = { warn, info: () => {} }
    applyToolsEntry(platform.ctx, { human: 'dev-assistant', memory: false, skills: ['never-uploaded'] })
    expect(platform.mounted).toEqual([])
    expect(warn.mock.calls.map(([line]) => String(line)).some((line) => line.includes('never-uploaded'))).toBe(true)
  })

  it('ignores a skills config that is not a list, and a registry with no home', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    platform.ctx.digitalHumans = platform.provided.get('digitalHumans')
    applyToolsEntry(platform.ctx, { human: 'dev-assistant', memory: false, skills: 'qs' })
    expect(platform.mounted).toEqual([])
    // Without a registry root there is nowhere to read skills from, so mounting is
    // skipped rather than guessed at.
    platform.ctx.digitalHumans = { ...platform.provided.get('digitalHumans'), home: undefined }
    expect(() => applyToolsEntry(platform.ctx, { human: 'dev-assistant', memory: false, skills: ['qs'] })).not.toThrow()
    expect(platform.mounted).toEqual([])
  })

  it('survives an absent skill registry', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    platform.ctx.digitalHumans = platform.provided.get('digitalHumans')
    const warn = vi.fn()
    platform.ctx.logger = { warn, info: () => {} }
    platform.ctx.skills = undefined
    expect(() => applyToolsEntry(platform.ctx, { human: 'dev-assistant', memory: false, skills: ['qs'] })).not.toThrow()
    expect(warn.mock.calls.map(([line]) => String(line)).some((line) => line.includes('skill registry is absent'))).toBe(true)
  })

  it('omits the memory context and the memory tools when memory is off', async () => {
    // The switch travels on the preset row, because this `apply` is synchronous and
    // the registry is not.
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
    platform.ctx.digitalHumans = platform.provided.get('digitalHumans')
    applyToolsEntry(platform.ctx, { human: 'dev-assistant', memory: false })
    expect(platform.contexts).toEqual([])
    expect(platform.tools.has('memory_status')).toBe(false)
    expect(platform.tools.has('memory_compact')).toBe(false)
    expect(platform.tools.has('digital_human_send')).toBe(true)
  })
})
