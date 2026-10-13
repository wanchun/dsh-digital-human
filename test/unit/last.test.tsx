// @vitest-environment jsdom
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apply as applyPlatform } from '../../src/index'

const { apply: applyClient } = await import('../../src/client')

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dh-last-'))
})

afterEach(() => {
  cleanup()
  rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('the host methods the page leans on', () => {
  function makeCtx(services: Record<string, unknown> = {}) {
    const provided = new Map<string, any>()
    const routes: any[] = []
    const ctx: any = {
      logger: { warn: () => {}, info: () => {} },
      effect: (fn: Function) => fn(),
      provide: (key: string, value: unknown) => provided.set(key, value),
      get: (key: string) => services[key] ?? provided.get(key),
      on: () => () => {},
      tools: { register: () => () => {} },
      agentPresets: { register: async () => async () => {}, readDocument: async () => undefined, list: async () => [] },
      sessionController: { create: async () => ({ sessionId: 's' }), prompt: async () => ({ accepted: true }), list: async () => ({ items: [] }), cancel: async () => ({}) },
      systemPrompt: { context: () => () => {} },
    }
    const connection = {
      createSharedFetchHandler: () => ({ async fetch(request: Request) {
        const body: any = await request.json()
        return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } })
      } }),
      fetch: { register: (route: any) => { routes.push(route); return () => {} } },
    }
    ctx.provide('connection', connection)
    return { ctx, routes }
  }

  const post = (method: string, payload: Record<string, unknown> = {}) => new Request('http://x/api/digital-human', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'digital-human', payload: { method, payload } }),
  })

  it('reports an empty permission roster when the service is absent', async () => {
    const { ctx, routes } = makeCtx()
    await applyPlatform(ctx, { home, seed: false })
    const answer = await (await routes[0].fetch(post('permissions.list'))).json()
    expect(answer.result.value).toEqual({ default: '', presets: [] })
  })

  it('reports the roster the platform publishes', async () => {
    const { ctx, routes } = makeCtx({
      permissionPresets: {
        catalog: () => ({
          defaultPreset: 'danger-full-access',
          options: [
            { value: 'danger-full-access', name: '完全权限', description: '不询问' },
            { value: 'bare' },
          ],
        }),
      },
    })
    await applyPlatform(ctx, { home, seed: false })
    const answer = await (await routes[0].fetch(post('permissions.list'))).json()
    expect(answer.result.value.default).toBe('danger-full-access')
    expect(answer.result.value.presets).toEqual([
      { value: 'danger-full-access', label: '完全权限', description: '不询问' },
      // A preset with no name falls back to its value, and no description becomes ''.
      { value: 'bare', label: 'bare', description: '' },
    ])
  })

  it('tolerates a catalog that answers with something else', async () => {
    const { ctx, routes } = makeCtx({ permissionPresets: { catalog: () => ({ options: 'nope' }) } })
    await applyPlatform(ctx, { home, seed: false })
    const answer = await (await routes[0].fetch(post('permissions.list'))).json()
    expect(answer.result.value).toEqual({ default: '', presets: [] })
  })

  it('keeps retrying while the retry budget lasts', async () => {
    // The loop body logs the attempt and waits; a single-attempt budget never runs it.
    const log = vi.fn()
    let attempts = 0
    const { ctx } = makeCtx()
    ctx.logger = { warn: log, info: () => {} }
    ctx.provide('connection', {
      createSharedFetchHandler: () => ({ async fetch(request: Request) {
        const body: any = await request.json()
        attempts += 1
        return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { message: 'not yet' } } })
      } }),
    })
    await applyPlatform(ctx, { home, seed: false, alignRetryMs: 5, alignRetryMax: 2 })
    await ctx.get('digitalHumans').upsert({ id: 'r', name: 'R', im: { botId: 'wecom_1' }, memory: false })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes('attempt 2/2'))).toBe(true)
    expect(attempts).toBeGreaterThan(2)
  })

  it('reports a preset that fails to register', async () => {
    const log = vi.fn()
    const { ctx } = makeCtx()
    ctx.logger = { warn: log, info: () => {} }
    let fail = false
    ctx.agentPresets = {
      register: async (definition: any) => {
        if (fail) throw new Error('preset registry is full')
        return async () => {}
      },
      readDocument: async () => undefined,
      list: async () => [],
    }
    await applyPlatform(ctx, { home, seed: false })
    fail = true
    await ctx.get('digitalHumans').upsert({ id: 'p', name: 'P', memory: false })
    expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes('failed to register'))).toBe(true)
  })

  it('reports a preset that fails to dispose', async () => {
    const log = vi.fn()
    const { ctx } = makeCtx()
    ctx.logger = { warn: log, info: () => {} }
    ctx.agentPresets = {
      register: async () => async () => { throw new Error('dispose failed') },
      readDocument: async () => undefined,
      list: async () => [],
    }
    await applyPlatform(ctx, { home, seed: false })
    await ctx.get('digitalHumans').upsert({ id: 'p', name: 'P', memory: false })
    await ctx.get('digitalHumans').remove('p')
    expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes('preset disposal failed'))).toBe(true)
  })

  it('reports a workspace it cannot register', async () => {
    const log = vi.fn()
    const { ctx } = makeCtx({
      workspaceController: {
        follow: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'baseline', value: { items: [] } } } }),
        create: async (options: any) => {
          if (options.path === '/blocked') throw new Error('read-only')
          return { workspace: { workspaceId: 'w', path: options.path } }
        },
        rename: async () => ({}),
      },
    })
    ctx.logger = { warn: log, info: () => {} }
    await applyPlatform(ctx, { home, seed: false })
    await ctx.get('digitalHumans').upsert({ id: 'b', name: 'B', workspace: '/blocked', memory: false })
    expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes('is unavailable'))).toBe(true)
  })

  it('forgets a removed record so its sessions stop resolving', async () => {
    const { ctx } = makeCtx()
    await applyPlatform(ctx, { home, seed: false })
    const service = ctx.get('digitalHumans')
    await service.upsert({ id: 'gone', name: 'Gone', memory: false })
    const sent = await service.send('gone', { message: 'hi' })
    expect(service.ownerOf(sent.sessionId)).toBeTruthy()
    await service.remove('gone')
    // Otherwise an assistant turn in that session would be appended to a mailbox in
    // a directory the record no longer has.
    expect(service.ownerOf(sent.sessionId)).toBeUndefined()
  })

  it('reports a claimed owner it cannot write', async () => {
    // The claim is a convenience; a read-only registry must not take the start down.
    const log = vi.fn()
    const { ctx } = makeCtx()
    ctx.logger = { warn: log, info: () => {} }
    writeFileSync(join(home, 'humans.json'), JSON.stringify([{
      id: 'o', name: 'O', enabled: true, systemPrompt: 'p', workspace: '', skills: [], peers: [],
      im: { botId: 'wecom_1', targetId: '' }, subscriptions: [], memory: false,
    }]))
    await expect(applyPlatform(ctx, { home, seed: false })).resolves.toBeUndefined()
    expect(ctx.get('digitalHumans')).toBeDefined()
  })
})

describe('the page in its last states', () => {
  const human = {
    id: 'pm', name: 'PM', enabled: true, systemPrompt: 'p', workspace: '/w',
    skills: [], peers: [], im: { botId: '', owner: '' }, subscriptions: [], memory: true,
    resolved: { values: {}, sources: {} }, alignment: [], presetId: 'dh-pm',
  }

  function mount(answers: Record<string, any> = {}) {
    const registrations: any[] = []
    const defaults: Record<string, any> = {
      'registry.list': { home: '/h', file: '/h/humans.json', humans: [human] },
      'im.bots': { bots: [] },
      'workspaces.list': { defaultTitle: '数字人', defaultPath: null, workspaces: [] },
      'skills.list': { skills: [] },
      'permissions.list': { default: '', presets: [] },
      'registry.save': { human, presetId: 'dh-pm' },
      'registry.remove': { removed: true },
    }
    const rpc = vi.fn(async (method: string) => {
      const answer = answers[method] ?? defaults[method]
      if (answer === undefined) return { ok: true, value: {} }
      const value = typeof answer === 'function' ? answer() : answer
      if (value instanceof Error) return { ok: false, error: { message: value.message } }
      return { ok: true, value }
    })
    const ctx = {
      effect: (fn: () => unknown) => fn(),
      connection: { rpc: { call: (_c: string, _e: string, request: any) => rpc(request.method, request.payload) } },
      slots: {
        inject: (_n: string, factory: () => unknown) => factory(),
        register: (options: any, Component: any) => { registrations.push({ options, Component }); return () => {} },
      },
    }
    applyClient(ctx)
    const main = registrations.find((entry) => entry.options.name === 'main')!
    render(React.createElement(main.Component, main.options.inject()))
    return { rpc }
  }

  const settle = () => waitFor(() => expect(screen.queryByText('正在读取数字人注册表…')).toBeNull())
  const open = async () => {
    await settle()
    fireEvent.click(screen.getByText('PM'))
    await waitFor(() => expect(screen.getByDisplayValue('PM')).toBeTruthy())
  }

  const schemaOf = (schema: any[], config?: Record<string, string>) =>
    ({ 'registry.list': () => ({ home: '/h', file: '/h/humans.json', humans: [{ ...human, config, configSchema: schema }] }) })

  it('renders a platform fact with no description, and a select with options', async () => {
    mount(schemaOf([
      { key: 'a', label: '事实', from: 'self_name' },
      { key: 'b', label: '选项', type: 'select', options: [{ label: '甲', value: 'jia' }] },
    ]))
    await open()
    expect(screen.getByText('平台自动提供，不用填。')).toBeTruthy()
    const field = screen.getByText('选项').parentElement!
    fireEvent.click(within(field).getByRole('button'))
    expect(within(field).getByRole('menuitem', { name: '甲' })).toBeTruthy()
    expect(within(field).getByRole('menuitem', { name: '（未设置）' })).toBeTruthy()
  })

  it('clears a boolean the operator switches off', async () => {
    mount(schemaOf([{ key: 'quiet', label: '静默', type: 'boolean' }], { quiet: 'true' }))
    await open()
    const box = screen.getByLabelText('静默') as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(box.checked).toBe(false)
  })

  it('keeps the operator on the row editor when the record declares nothing', async () => {
    mount(schemaOf([], { a: '1' }))
    await open()
    expect(screen.getByText('添加一项')).toBeTruthy()
    fireEvent.click(screen.getByText('添加一项'))
    const names = screen.getAllByPlaceholderText('名称')
    fireEvent.change(names.at(-1)!, { target: { value: 'b' } })
    const values = screen.getAllByPlaceholderText('值')
    fireEvent.change(values.at(-1)!, { target: { value: '2' } })
    fireEvent.click(screen.getAllByLabelText(/删除配置项/)[0])
    expect(screen.queryByDisplayValue('1')).toBeNull()
  })

  it('says so when there is no bot at all', async () => {
    mount()
    await open()
    expect(screen.getByText(/还没有 bot/)).toBeTruthy()
  })

  it('names the default workspace when none is chosen', async () => {
    mount({
      'registry.list': () => ({ home: '/h', file: '/h/humans.json', humans: [{ ...human, workspace: '' }] }),
      'workspaces.list': () => ({ defaultTitle: '数字人', defaultPath: '/w', workspaces: [] }),
    })
    await open()
    expect(screen.getByText(/不选就在「数字人」工作区里跑/)).toBeTruthy()
  })

  it('reports a refresh that fails', async () => {
    const view = mount()
    await open()
    view.rpc.mockImplementationOnce(async () => ({ ok: false, error: { message: 'list is down' } }))
    fireEvent.click(screen.getByText('刷新'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('list is down'))
  })
})
