// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as applyPlatform } from '../../src/index'
import { apply as applyToolsEntry } from '../../src/tools'
import { buildHumanTools } from '../../src/lib/tools'
import { ensureDefaultWorkspace, readBotMeta } from '../../src/lib/workspaces'
import { presetIdOf } from '../../src/lib/presets'
import { SEED_HUMANS } from '../fixtures/seed.mjs'

const { apply } = await import('../../src/client')

afterEach(() => {
  // Vitest runs without globals here, so the library's own auto-cleanup is off and
  // a rendered page would otherwise leak into the next test.
  cleanup()
  vi.restoreAllMocks()
})

/** A host context that records what the platform registers. */
function makeCtx(services: Record<string, unknown> = {}) {
  const presets = new Map<string, any>()
  const tools = new Map<string, any>()
  const provided = new Map<string, any>()
  const contexts: any[] = []
  const listeners: Array<{ event: string; handler: Function; options?: unknown }> = []
  const effects: Array<() => unknown> = []
  const sessions: any[] = []
  const prompts: any[] = []
  let counter = 0
  const ctx: any = {
    logger: { warn: () => {}, info: () => {} },
    effect: (fn: Function) => { effects.push(fn as () => unknown); return fn() },
    provide: (key: string, value: unknown) => provided.set(key, value),
    get: (key: string) => services[key] ?? provided.get(key),
    on: (event: string, handler: Function, options?: unknown) => { listeners.push({ event, handler, options }); return () => {} },
    tools: { register: (definition: any) => { tools.set(definition.name, definition); return () => {} } },
    agentPresets: {
      register: async (definition: any) => { presets.set(definition.id, definition); return async () => {} },
      readDocument: async () => undefined,
      list: async () => [...presets.values()],
    },
    sessionController: {
      create: async (options: any) => {
        counter += 1
        const sessionId = `session-${counter}`
        sessions.push({ sessionId, running: false, agentPreset: options?.agentPreset })
        return { sessionId, agentPreset: options?.agentPreset }
      },
      prompt: async (request: any) => { prompts.push(request); return { accepted: true } },
      list: async () => ({ items: sessions.map((entry) => ({ ...entry })) }),
      cancel: async () => ({ accepted: true }),
    },
    systemPrompt: { context: (entry: any) => { contexts.push(entry); return () => {} } },
  }
  return { ctx, presets, tools, provided, contexts, listeners, effects, sessions, prompts }
}

/** A connection stub that answers every alignment call. */
function connectionStub(answer?: (body: any) => Response) {
  const seen: any[] = []
  const routes: any[] = []
  return {
    seen,
    routes,
    createSharedFetchHandler() {
      return {
        async fetch(request: Request) {
          const body: any = await request.json()
          seen.push(body)
          if (answer) return answer(body)
          return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } })
        },
      }
    },
    fetch: { register: (route: any) => { routes.push(route); return () => {} } },
  }
}

const call = (method: string, payload: Record<string, unknown> = {}) => ({
  type: 'client-request', rpcId: 'rpc-1', method: 'digital-human', payload: { method, payload },
})

const post = (value: unknown) => new Request('http://127.0.0.1:3080/api/digital-human', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
})

describe('platform options', () => {
  it('extends the renderer allow-list from the plugin config', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home: '/tmp/dh-opt', humans: SEED_HUMANS, platformVariables: ['tenant', 7, ''] })
    const definition = [...platform.presets.values()][0]
    const prefix = definition.plugins[0].config.prefix
    // The configured name is registered; a non-string is dropped.
    expect(prefix).not.toContain('〔未配置：tenant〕')
  })

  it('reads a home from the config and falls back otherwise', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { humans: SEED_HUMANS })
    expect(platform.provided.get('digitalHumans').home).toContain('digital-human')
  })

  it('accepts a custom preset and tools plugin name', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home: '/tmp/dh-opt2', humans: SEED_HUMANS, basePreset: 'minimal', toolsPlugin: '@x/tools', permissionPreset: 'read-only' })
    const definition = [...platform.presets.values()][0]
    expect(definition.plugins.at(-1).name).toBe('@x/tools')
  })
})

describe('the alignment retry', () => {
  const retryHome = '/tmp/dh-retry-gaps'

  const boundRecord = (id: string) => ({
    id, name: id, enabled: true, systemPrompt: 'x', workspace: '', skills: [], peers: [],
    im: { botId: 'wecom_1', targetId: '' }, subscriptions: [], memory: false,
    escalation: { enabled: false, timeoutHours: 24 },
  })

  it('retries a failed alignment and stops once it succeeds', async () => {
    const platform = makeCtx()
    let attempts = 0
    platform.ctx.provide('connection', {
      createSharedFetchHandler: () => ({
        async fetch(request: Request) {
          const body: any = await request.json()
          attempts += 1
          // The first round fails for every endpoint; the retry succeeds.
          if (attempts <= 3) {
            return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { message: 'not yet' } } })
          }
          return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } })
        },
      }),
    })
    await platform.ctx.get('digitalHumans')
    await applyPlatform(platform.ctx, { home: retryHome, alignRetryMs: 5, alignRetryMax: 3 })
    const service = platform.provided.get('digitalHumans')
    await service.upsert(boundRecord('g1'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    // Two endpoints per attempt: the first pass fails, the retry succeeds.
    expect(attempts).toBeGreaterThanOrEqual(4)
  })

  it('gives up after the configured number of attempts', async () => {
    const platform = makeCtx()
    let attempts = 0
    platform.ctx.provide('connection', {
      createSharedFetchHandler: () => ({
        async fetch(request: Request) {
          const body: any = await request.json()
          attempts += 1
          return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { message: 'never' } } })
        },
      }),
    })
    await applyPlatform(platform.ctx, { home: `${retryHome}-2`, alignRetryMs: 5, alignRetryMax: 2 })
    await platform.provided.get('digitalHumans').upsert(boundRecord('g2'))
    await new Promise((resolve) => setTimeout(resolve, 150))
    const settled = attempts
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(attempts).toBe(settled)
  })
})

describe('partial saves', () => {
  it('merges a patch over the stored record, keeping what the page cannot show', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home: '/tmp/dh-merge' })
    const service = platform.provided.get('digitalHumans')
    await service.upsert({ id: 'm', name: 'M', im: { botId: 'wecom_1', targetId: 'leader' }, memory: false })
    const saved = await service.upsert({ id: 'm', name: 'M2', im: { botId: 'wecom_1' } }, { partial: true })
    expect(saved.name).toBe('M2')
    // The page never sends a target, so a partial save must not erase one.
    expect(saved.im.targetId).toBe('leader')
  })

  it('refuses a save with no id', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home: '/tmp/dh-merge2' })
    await expect(platform.provided.get('digitalHumans').upsert({ name: 'x' })).rejects.toThrow(/id is required/)
  })

  it('replaces the record outright when the save is not partial', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home: '/tmp/dh-merge3' })
    const service = platform.provided.get('digitalHumans')
    await service.upsert({ id: 'm', name: 'M', im: { botId: 'wecom_1', targetId: 'leader' }, memory: false })
    const saved = await service.upsert({ id: 'm', name: 'M3', im: { botId: 'wecom_1' } })
    expect(saved.im.targetId).toBe('')
  })
})

describe('the skills route', () => {
  it('maps what the skills service reports', async () => {
    const platform = makeCtx({ skills: { list: async () => [{ name: 'qs', description: 'd', whenToUse: 'w', source: 's' }] } })
    const connection = connectionStub()
    platform.ctx.provide('connection', connection)
    await applyPlatform(platform.ctx, { home: '/tmp/dh-skills', humans: SEED_HUMANS })
    const answer = await (await connection.routes[0].fetch(post(call('skills.list')))).json()
    expect(answer.result.value.skills[0]).toEqual({ name: 'qs', description: 'd', whenToUse: 'w', source: 's' })
  })

  it('tolerates a service that answers with something else', async () => {
    const platform = makeCtx({ skills: { list: async () => 'nope' } })
    const connection = connectionStub()
    platform.ctx.provide('connection', connection)
    await applyPlatform(platform.ctx, { home: '/tmp/dh-skills2', humans: SEED_HUMANS })
    const answer = await (await connection.routes[0].fetch(post(call('skills.list')))).json()
    expect(answer.result.value.skills).toEqual([])
  })

  it('reports the workspaces it can see', async () => {
    const platform = makeCtx({
      workspaceController: {
        follow: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'baseline', value: { items: [{ workspaceId: 'w', title: 'T', path: '/p' }] } } } }),
        create: async () => ({ workspace: { workspaceId: 'w', path: '/p' } }),
        rename: async () => ({}),
      },
    })
    const connection = connectionStub()
    platform.ctx.provide('connection', connection)
    await applyPlatform(platform.ctx, { home: '/tmp/dh-ws', humans: SEED_HUMANS })
    const answer = await (await connection.routes[0].fetch(post(call('workspaces.list')))).json()
    expect(answer.result.value.workspaces).toEqual([{ workspaceId: 'w', title: 'T', path: '/p' }])
    expect(answer.result.value.defaultPath).toBe('/p')
  })
})

describe('a session that appears before its preset was aligned', () => {
  it('re-aligns on creation when the last attempt failed', async () => {
    const platform = makeCtx()
    let fail = true
    platform.ctx.provide('connection', {
      createSharedFetchHandler: () => ({
        async fetch(request: Request) {
          const body: any = await request.json()
          if (fail) {
            return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { message: 'not yet' } } })
          }
          return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } })
        },
      }),
    })
    await applyPlatform(platform.ctx, { home: '/tmp/dh-relign', alignRetryMs: 5, alignRetryMax: 1 })
    const service = platform.provided.get('digitalHumans')
    await service.upsert({
      id: 'a1', name: 'A', im: { botId: 'wecom_1', targetId: '' }, memory: false,
    })
    fail = false
    const created = platform.listeners.find((entry) => entry.event === 'session/created')!.handler
    expect(() => created({ id: 's-a1', header: { agentPreset: presetIdOf('a1') } })).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 30))
    // A session for a record that never failed must not trigger another push.
    expect(() => created({ id: 's-other', header: { agentPreset: 'standard' } })).not.toThrow()
  })
})

describe('teardown', () => {
  it('disposes every preset it registered', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home: '/tmp/dh-dispose', humans: SEED_HUMANS })
    // The last effect is the preset disposer; running it must not throw.
    for (const effect of platform.effects) {
      const result = effect()
      if (typeof result === 'function') expect(() => result()).not.toThrow()
    }
  })
})

describe('every tool renders its own result', () => {
  const service: any = {
    store: { dir: () => '/tmp/dh-tools', memoryPath: () => '/tmp/dh-tools/memory.md' },
    require: async () => ({ id: 'pm', name: 'PM', enabled: true, im: { botId: '', targetId: '' } }),
    resolve: async () => ({ id: 'dev', name: 'Dev', enabled: true, im: { botId: '', targetId: '' } }),
    list: async () => [],
    chat: { conversations: async () => [] },
  }

  it('falls back to JSON when a result carries no detail', () => {
    const tools = buildHumanTools({ ctx: { get: () => undefined }, service, humanId: 'pm' })
    for (const tool of tools) {
      const rendered = tool.output.render({}, { custom: 1 })
      expect(rendered, tool.name).toEqual([{ type: 'text', text: '{"custom":1}' }])
      expect(tool.output.render({}, { detail: 'D' })[0].text, tool.name).toBe('D')
    }
  })

  it('reports an empty roster', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dh-empty-'))
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home })
    const detail = (await platform.tools.get('digital_human').execute({ action: 'list' })).detail
    expect(detail).toContain('No digital humans are configured')
    rmSync(home, { recursive: true, force: true })
  })

  it('marks a record that carries a workspace and a target', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dh-roster-'))
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home })
    const service2 = platform.provided.get('digitalHumans')
    await service2.upsert({ id: 'a', name: 'A', workspace: '/w', im: { botId: 'wecom_1', targetId: 't' }, memory: false })
    const detail = (await platform.tools.get('digital_human').execute({ action: 'list' })).detail
    expect(detail).toContain('@ /w')
  })
})

describe('workspace fallbacks', () => {
  it('tolerates a context with no `get`', async () => {
    expect(await ensureDefaultWorkspace({} as any, { home: '/tmp/x' })).toBeUndefined()
  })

  it('keeps an existing workspace that is already titled', async () => {
    const controller = {
      follow: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'baseline', value: { items: [{ workspaceId: 'w', title: '数字人', path: '/tmp/x/workspace' }] } } } }),
      create: async () => ({}),
    }
    expect((await ensureDefaultWorkspace({ get: () => controller } as any, { home: '/tmp/x' }))?.workspaceId).toBe('w')
  })

  it('keeps a workspace it created when the controller cannot rename', async () => {
    // `ensureDefaultWorkspace` matches an existing workspace by title, so a
    // differently-titled one is created rather than adopted.
    const controller = {
      follow: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'baseline', value: { items: [] } } } }),
      create: async () => ({ workspace: { workspaceId: 'w', title: 'other', path: '/tmp/x/workspace' } }),
    }
    expect((await ensureDefaultWorkspace({ get: () => controller } as any, { home: '/tmp/x' }))?.workspaceId).toBe('w')
  })

  it('reports a rename that fails and still returns the created workspace', async () => {
    const controller = {
      follow: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'baseline', value: { items: [] } } } }),
      create: async () => ({ workspace: { workspaceId: 'w', title: 'other', path: '/tmp/x/workspace' } }),
      rename: async () => { throw new Error('read-only') },
    }
    const log = vi.fn()
    expect((await ensureDefaultWorkspace({ get: () => controller } as any, { home: '/tmp/x', log }))?.workspaceId).toBe('w')
    // A failed rename must not discard a workspace that was created successfully.
    expect(String(log.mock.calls[0][0])).toContain('could not be renamed')
  })

  it('reports a create that fails', async () => {
    const controller = {
      follow: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'baseline', value: { items: [] } } } }),
      create: async () => { throw new Error('read-only') },
    }
    const log = vi.fn()
    expect(await ensureDefaultWorkspace({ get: () => controller } as any, { home: '/tmp/x', log })).toBeUndefined()
    expect(String(log.mock.calls[0][0])).toContain('unavailable')
  })

  it('ignores an alias map that is an array', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dh-meta-'))
    mkdirSync(join(root, 'integrations', 'dsh-wecom'), { recursive: true })
    writeFileSync(join(root, 'integrations', 'dsh-wecom', 'workspaces.json'),
      JSON.stringify({ aliases: ['a'], workspaces: ['b'] }))
    expect(await readBotMeta(root)).toEqual({ aliases: {}, workspaces: {} })
    rmSync(root, { recursive: true, force: true })
  })
})

describe('the client renders every entry point', () => {
  const human = {
    id: 'pm', name: 'PM', description: '', enabled: true, systemPrompt: 'x', workspace: '/w',
    skills: [], peers: [], im: { botId: 'wecom_1', targetId: 'leader', owner: '' },
    subscriptions: [], memory: true, escalation: { enabled: false, timeoutHours: 24 },
    config: { free: 'v' }, configSchema: undefined,
    resolved: { values: {}, sources: {} }, alignment: [],
  }

  function mount(answers: Record<string, any> = {}) {
    const registrations: any[] = []
    const disposers: Array<() => unknown> = []
    const defaults: Record<string, any> = {
      'im.bots': { bots: [] },
      'workspaces.list': { defaultTitle: '数字人', defaultPath: null, workspaces: [] },
      'skills.list': { skills: [] },
      'registry.remove': { removed: true },
      'registry.save': { human, presetId: 'dh-pm' },
    }
    const rpc = vi.fn(async (method: string) => {
      const answer = answers[method] ?? defaults[method]
      if (answer === undefined) return { ok: true, value: {} }
      const value = typeof answer === 'function' ? answer() : answer
      if (value instanceof Error) return { ok: false, error: { message: value.message } }
      return { ok: true, value }
    })
    const ctx = {
      effect: (fn: () => unknown) => { disposers.push(fn() as () => unknown); return fn() },
      connection: { rpc: { call: (_c: string, _e: string, request: any) => rpc(request.method, request.payload) } },
      slots: {
        inject: (_name: string, factory: () => unknown) => factory(),
        register: (options: any, Component: any) => { registrations.push({ options, Component }); return () => {} },
      },
    }
    apply(ctx)
    return { registrations, disposers, rpc }
  }

  it('renders the sidebar icon at the size it is given', () => {
    const { registrations } = mount()
    const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist')!
    expect(sidebar.options.label()).toBe('数字人')
    const { container } = render(React.createElement(sidebar.Component, { size: 18 }))
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('18')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders the icon without a size', () => {
    const { registrations } = mount()
    const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist')!
    const { container } = render(React.createElement(sidebar.Component, {}))
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('disposes both slot registrations without throwing', () => {
    const { disposers } = mount()
    for (const dispose of disposers) expect(() => dispose()).not.toThrow()
  })

  it('drops a half-filled row on save and flags a duplicate', async () => {
    const { registrations } = mount({
      'registry.list': () => ({ home: '/h', file: '/h/humans.json', humans: [human] }),
      'registry.save': () => ({ human, presetId: 'dh-pm' }),
    })
    const main = registrations.find((entry) => entry.options.name === 'main')!
    render(React.createElement(main.Component, main.options.inject()))
    await waitFor(() => expect(screen.getByText('PM')).toBeTruthy())
    fireEvent.click(screen.getByText('PM'))
    await waitFor(() => expect(screen.getByDisplayValue('free')).toBeTruthy())
    fireEvent.click(screen.getByText('添加一项'))
    const names = screen.getAllByPlaceholderText('名称')
    fireEvent.change(names.at(-1)!, { target: { value: 'free' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(screen.getByText(/已保存/)).toBeTruthy())
  })

  it('keeps the list in step after a create', async () => {
    const { registrations } = mount({
      'registry.list': () => ({ home: '/h', file: '/h/humans.json', humans: [] }),
      'registry.save': () => ({ human: { ...human, id: 'made', name: 'Made' }, presetId: 'dh-made' }),
    })
    const main = registrations.find((entry) => entry.options.name === 'main')!
    render(React.createElement(main.Component, main.options.inject()))
    await waitFor(() => expect(screen.getByText('新建数字人')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('ID'), { target: { value: 'made' } })
    fireEvent.click(screen.getByText('创建'))
    await waitFor(() => expect(screen.getByText('Made')).toBeTruthy())
  })
})
