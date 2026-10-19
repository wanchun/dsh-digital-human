// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apply as applyPlatform } from '../../src/index'
import { buildPresetDefinition, renderConfigBlock, renderOperatingContext } from '../../src/lib/presets'
import { HumanStore, normalizeHuman } from '../../src/lib/store'

const { apply: applyClient } = await import('../../src/client')

let root = ''
let home = ''

beforeEach(() => {
  // The registry root is a subdirectory of the profile, so the IM integration data
  // sits one level up exactly as it does in a real install.
  root = mkdtempSync(join(tmpdir(), 'dh-harden-'))
  home = join(root, 'digital-human')
  mkdirSync(home, { recursive: true })
})

afterEach(() => {
  cleanup()
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** A host context that records what the platform registers. */
function makeCtx(services: Record<string, unknown> = {}) {
  const presets = new Map<string, any>()
  const tools = new Map<string, any>()
  const provided = new Map<string, any>()
  const listeners: Array<{ event: string; handler: Function }> = []
  const sessions: any[] = []
  const ctx: any = {
    logger: { warn: () => {}, info: () => {} },
    effect: (fn: Function) => fn(),
    provide: (key: string, value: unknown) => provided.set(key, value),
    get: (key: string) => services[key] ?? provided.get(key),
    on: (event: string, handler: Function) => { listeners.push({ event, handler }); return () => {} },
    tools: { register: (definition: any) => { tools.set(definition.name, definition); return () => {} } },
    agentPresets: {
      register: async (definition: any) => { presets.set(definition.id, definition); return async () => {} },
      readDocument: async () => undefined,
      list: async () => [...presets.values()],
    },
    sessionController: {
      // The real contract: no Workspace plus cwd together, the directory resolved
      // from the Workspace, and an explicit id adopted.
      create: async (options: any) => {
        if (options?.workspaceId !== undefined && options?.cwd !== undefined) {
          throw new Error('session.create accepts workspaceId or cwd, not both')
        }
        if (options?.sessionId !== undefined) {
          const known = sessions.find((entry) => entry.sessionId === options.sessionId)
          if (known && options.agentPreset !== undefined && known.agentPreset !== options.agentPreset) {
            throw new Error(`session "${options.sessionId}" would change preset`)
          }
          return { sessionId: options.sessionId, agentPreset: options?.agentPreset }
        }
        const sessionId = `session-${sessions.length + 1}`
        sessions.push({ sessionId, agentPreset: options?.agentPreset, cwd: options?.cwd, workspaceId: options?.workspaceId })
        return { sessionId, agentPreset: options?.agentPreset }
      },
      prompt: async () => ({ accepted: true }),
      list: async () => ({ items: sessions.map((entry) => ({ ...entry })) }),
      cancel: async () => ({ accepted: true }),
    },
    systemPrompt: { context: () => () => {} },
  }
  return { ctx, presets, tools, provided, listeners, sessions }
}

/** A workspace controller whose roster the test sets, and which records creations. */
function workspaceController(items: any[] = []) {
  const created: any[] = []
  return {
    created,
    follow: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'baseline', value: { items } } } }),
    create: async (options: any) => {
      created.push(options)
      return { workspace: { workspaceId: `ws-${created.length}`, path: options.path, title: '' } }
    },
    rename: async (options: any) => ({ workspace: { workspaceId: 'ws-1', ...options } }),
  }
}

describe('a record whose directory is not a known Workspace', () => {
  it('registers the directory and files the session under it', async () => {
    // Without the id the session carries a cwd but no workspaceId, and the UI
    // groups by the id — so it shows up as ungrouped though it runs in the right
    // place.
    const controller = workspaceController([])
    const platform = makeCtx({ workspaceController: controller })
    await applyPlatform(platform.ctx, { home })
    const service = platform.provided.get('digitalHumans')
    await service.upsert({ id: 'own', name: 'Own', workspace: '/somewhere/else', memory: false })
    const created = controller.created.find((entry) => entry.path === '/somewhere/else')
    expect(created).toBeTruthy()
    const sent = await service.send('own', { message: 'hi' })
    const row = platform.sessions.find((entry) => entry.sessionId === sent.sessionId)
    // The session is filed under whatever id the controller returned for it. The
    // directory is not sent alongside it: naming a Workspace and a cwd together is
    // refused by the Host, and it resolves the directory from the Workspace.
    expect(row.workspaceId).toBe(`ws-${controller.created.indexOf(created!) + 1}`)
    expect(row.cwd).toBeUndefined()
  })

  it('reuses a directory it already registered', async () => {
    const controller = workspaceController([{ workspaceId: 'ws-known', path: '/known', title: 'K' }])
    const platform = makeCtx({ workspaceController: controller })
    await applyPlatform(platform.ctx, { home })
    await platform.provided.get('digitalHumans').upsert({ id: 'k', name: 'K', workspace: '/known', memory: false })
    // The default workspace is still created; the record's own directory is not.
    expect(controller.created.map((entry) => entry.path)).not.toContain('/known')
  })

  it('reports a directory the controller refuses', async () => {
    const controller = {
      follow: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'baseline', value: { items: [] } } } }),
      create: async () => { throw new Error('read-only') },
      rename: async () => ({}),
    }
    const log = vi.fn()
    const platform = makeCtx({ workspaceController: controller })
    platform.ctx.logger = { warn: log, info: () => {} }
    await applyPlatform(platform.ctx, { home })
    await platform.provided.get('digitalHumans').upsert({ id: 'r', name: 'R', workspace: '/nope', memory: false })
    expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes('is unavailable'))).toBe(true)
  })

  it('skips a disabled record, which creates no session', async () => {
    const controller = workspaceController([])
    const platform = makeCtx({ workspaceController: controller })
    await applyPlatform(platform.ctx, { home })
    await platform.provided.get('digitalHumans').upsert({ id: 'off', name: 'Off', workspace: '/x', enabled: false, memory: false })
    expect(controller.created.map((entry) => entry.path)).not.toContain('/x')
  })
})

describe('the working directory in the prompt', () => {
  const store = { file: '/h/humans.json', memoryPath: (id: string) => `/h/${id}/memory.md` }
  const human = normalizeHuman({ id: 'a', name: 'A', systemPrompt: 'p' })

  it('is not announced by a suffix, because the loop registers no cwd', () => {
    // The loop registers `provider` and `model` only. The working-directory service
    // states the directory as literal context, so a suffix naming `{{cwd}}` would
    // fail prompt assembly for every turn before any model request.
    const config = buildPresetDefinition(human, { store, toolsPluginName: '@x/tools', order: 1 }).plugins[0].config
    expect(config.suffix).toBeUndefined()
  })

  it('neutralises a cwd the persona writes itself', () => {
    const config = buildPresetDefinition(normalizeHuman({ id: 'a', name: 'A', systemPrompt: 'dir {{cwd}}' }), {
      store, toolsPluginName: '@x/tools', order: 1,
    }).plugins[0].config
    expect(config.prefix).toContain('〔未配置：cwd〕')
  })
})

describe('a permission preset that changes', () => {
  it('is re-applied when the session switches to another digital human', async () => {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home })
    const service = platform.provided.get('digitalHumans')
    await service.upsert({ id: 'full', name: 'F', memory: false })
    await service.upsert({ id: 'readonly', name: 'R', permissionPreset: 'read-only', memory: false })
    const calls: Array<{ session: unknown; name: string }> = []
    platform.ctx.provide('permissionPresets', { set: (session: unknown, name: string) => calls.push({ session, name }) })
    const created = platform.listeners.find((entry) => entry.event === 'session/created')!.handler
    const event = platform.listeners.find((entry) => entry.event === 'session/event')!.handler
    const session = { id: 's1', header: { agentPreset: 'dh-full' } }
    created(session)
    expect(calls.map((entry) => entry.name)).toEqual(['danger-full-access'])
    // The same session, now running the read-only record.
    event(session, { type: 'agent-preset/selected', data: { agentPreset: 'dh-readonly' } })
    expect(calls.map((entry) => entry.name)).toEqual(['danger-full-access', 'read-only'])
    // Selecting the same preset again appends nothing.
    event(session, { type: 'agent-preset/selected', data: { agentPreset: 'dh-readonly' } })
    expect(calls).toHaveLength(2)
  })
})

describe('a session whose caller is not the owner', () => {
  /** Write one bot's session state, the file the IM plugin owns. */
  const stateFor = (botId: string, sessions: Record<string, unknown>) => {
    const dir = join(dirname(home), 'integrations', `dsh-${botId.split('_', 1)[0]}`, 'bots', botId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, sessions }))
  }

  /**
   * One bound, owned record, the channel state the test names, and the services the
   * grant path reads.
   */
  async function ownedBot(sessions: Record<string, unknown>) {
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home })
    await platform.provided.get('digitalHumans').upsert({
      id: 'host', name: 'H', memory: false, im: { botId: 'wecom_1', owner: 'wohR_owner' },
    })
    stateFor('wecom_1', sessions)
    const calls: Array<{ session: unknown; name: string }> = []
    platform.ctx.provide('permissionPresets', { set: (session: unknown, name: string) => calls.push({ session, name }) })
    const log = vi.fn()
    platform.ctx.logger = { warn: log, info: () => {} }
    return {
      calls,
      log,
      created: platform.listeners.find((entry) => entry.event === 'session/created')!.handler,
    }
  }

  const lines = (log: any) => log.mock.calls.map(([line]: [unknown]) => String(line))

  it('is confined, and no preset is named for it', async () => {
    // The record's preset is for the owner. A stranger who reached the bot gets the
    // sandbox and the approval policy directly, because naming a preset would make
    // every deployment define the one that means "confined".
    const { created, calls, log } = await ownedBot({ 'direct:wohR_stranger': 'session-s1' })
    const append = vi.fn()
    created({ id: 'session-s1', header: { agentPreset: 'dh-host' }, append })
    expect(append.mock.calls).toEqual([
      ['sandbox/mode', { mode: 'workspace-write' }],
      ['approval/policy', { policy: 'never' }],
    ])
    expect(calls).toEqual([])
    expect(lines(log).some((line) => line.includes('wohR_stranger'))).toBe(true)
  })

  it('keeps the owner on the record preset', async () => {
    const { created, calls } = await ownedBot({ 'direct:wohR_owner': 'session-s1' })
    const append = vi.fn()
    created({ id: 'session-s1', header: { agentPreset: 'dh-host' }, append })
    expect(calls.map((entry) => entry.name)).toEqual(['danger-full-access'])
    expect(append).not.toHaveBeenCalled()
  })

  it('leaves a group alone, because no single person is talking', async () => {
    const { created, calls } = await ownedBot({ 'group:wrGROUP': 'session-s1' })
    created({ id: 'session-s1', header: { agentPreset: 'dh-host' }, append: vi.fn() })
    expect(calls.map((entry) => entry.name)).toEqual(['danger-full-access'])
  })

  it('confines a session once, however often it announces itself', async () => {
    const { created, calls } = await ownedBot({ 'direct:wohR_stranger': 'session-s1' })
    const append = vi.fn()
    const session = { id: 'session-s1', header: { agentPreset: 'dh-host' }, append }
    created(session)
    created(session)
    expect(append).toHaveBeenCalledTimes(2)
    expect(calls).toEqual([])
  })

  it('reports a session that cannot record the confinement', async () => {
    // A session without `append` is not the real contract, but the grant must say so
    // rather than silently leaving the stranger unconfined.
    const { created, log } = await ownedBot({ 'direct:wohR_stranger': 'session-s1' })
    created({ id: 'session-s1', header: { agentPreset: 'dh-host' } })
    expect(lines(log).some((line) => line.includes('cannot record it'))).toBe(true)
  })

  it('applies the record preset when the bot has no claimed owner', async () => {
    // Nobody is the owner yet, so there is no stranger to confine.
    const platform = makeCtx()
    await applyPlatform(platform.ctx, { home })
    await platform.provided.get('digitalHumans').upsert({
      id: 'open', name: 'O', memory: false, im: { botId: 'wecom_2' },
    })
    const calls: Array<{ session: unknown; name: string }> = []
    platform.ctx.provide('permissionPresets', { set: (session: unknown, name: string) => calls.push({ session, name }) })
    const created = platform.listeners.find((entry) => entry.event === 'session/created')!.handler
    created({ id: 'session-s9', header: { agentPreset: 'dh-open' }, append: vi.fn() })
    expect(calls.map((entry) => entry.name)).toEqual(['danger-full-access'])
  })
})

describe('a registry that cannot be read', () => {
  it('degrades instead of failing activation', async () => {
    // The file is documented as hand-editable, and the settings page is how it gets
    // fixed — so a bad file must not take the whole platform down.
    writeFileSync(join(home, 'humans.json'), '{ not json', 'utf8')
    const log = vi.fn()
    const platform = makeCtx()
    platform.ctx.logger = { warn: log, info: () => {} }
    await expect(applyPlatform(platform.ctx, { home })).resolves.toBeUndefined()
    expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes('could not be read'))).toBe(true)
    // The registry tool still exists, so the operator has a way back.
    expect(platform.tools.has('digital_human')).toBe(true)
  })
})

describe('the IM target grammar', () => {
  it('accepts the shapes the IM platform itself sends to', () => {
    // `direct:…` and `@user:host` are real targets, and the plugin's own notify tool
    // sends to them; a slug-shaped rule would refuse to store them.
    for (const targetId of ['direct:wohR_1', '@user:host', 'a@b.c', 'plain-target', 'x'.repeat(128)]) {
      expect(normalizeHuman({ id: 'a', im: { targetId } }).im.targetId, targetId).toBe(targetId)
    }
  })

  it('still refuses a target that is empty, too long, or carries a space', () => {
    expect(() => normalizeHuman({ id: 'a', im: { targetId: 'a b' } })).toThrow(/im.targetId/)
    expect(() => normalizeHuman({ id: 'a', im: { targetId: 'x'.repeat(129) } })).toThrow(/im.targetId/)
    expect(() => normalizeHuman({ id: 'a', im: { targetId: 'a/b' } })).toThrow(/im.targetId/)
  })

  it('round-trips a target through the store', async () => {
    const store = new HumanStore(home)
    await store.upsert(normalizeHuman({ id: 'a', name: 'A', im: { botId: 'wecom_1', targetId: 'direct:x' } }))
    expect((await store.get('a'))?.im.targetId).toBe('direct:x')
  })
})

describe('the text the plugin ships', () => {
  const store = { file: '/h/humans.json', memoryPath: (id: string) => `/h/${id}/memory.md` }
  const human = normalizeHuman({
    id: 'a', name: 'A', systemPrompt: 'p', peers: ['b'],
    subscriptions: [{ cron: '0 1 * * *', prompt: 'x', enabled: true }],
  })

  it('states mechanism only, never a workflow rule', () => {
    // A rule here would fit exactly one deployment; the persona owns its own rules.
    const text = `${renderOperatingContext(human, store)}\n${renderConfigBlock(human).join('\n')}`
    expect(text).not.toMatch(/Treat a peer's message as a task|before you report|以角色称呼指代|并提示用户补全|数字人间通讯/)
    // What it must still teach: the tools, and how to use them.
    expect(text).toContain('digital_human_send')
    // With no declared peer the text points at the roster tool instead.
    expect(renderOperatingContext(normalizeHuman({ id: 'a', name: 'A' }), store)).toContain('digital_human_list')
  })

  it('names no business feature in the config vocabulary', () => {
    const config = buildPresetDefinition(human, { store, toolsPluginName: '@x/tools', order: 1 }).plugins[0].config
    expect(config.prefix).not.toMatch(/数字人间通讯|成员登记表|新成员流程|维护者|最高权限/)
  })
})

describe('the page reports what the host told it', () => {
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
      'skills.library': () => ({
            skills: [{ name: 'qs', description: 'q', whenToUse: '', files: ['SKILL.md'], bytes: 10, named: true }],
      }),
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

  it('shows the preset id the host registered', async () => {
    mount()
    await settle()
    fireEvent.click(screen.getByText('PM'))
    await waitFor(() => expect(screen.getByDisplayValue('PM')).toBeTruthy())
    expect(screen.getByText('preset：dh-pm')).toBeTruthy()
  })

  it('says the preset is unregistered when the host reports none', async () => {
    mount({ 'registry.list': () => ({ home: '/h', file: '/h/humans.json', humans: [{ ...human, presetId: undefined }] }) })
    await settle()
    fireEvent.click(screen.getByText('PM'))
    await waitFor(() => expect(screen.getByDisplayValue('PM')).toBeTruthy())
    expect(screen.getByText('preset：未注册')).toBeTruthy()
  })

  it('reports an alignment that did not reach the bot', async () => {
    mount({
      'registry.list': () => ({
        home: '/h', file: '/h/humans.json',
        humans: [{ ...human, alignment: [{ endpoint: 'bot.preset.set', ok: false, reason: '稍后重试' }] }],
      }),
    })
    await settle()
    fireEvent.click(screen.getByText('PM'))
    await waitFor(() => expect(screen.getByDisplayValue('PM')).toBeTruthy())
    const warn = screen.getByRole('status')
    expect(warn.textContent).toContain('bot.preset.set')
    expect(warn.textContent).toContain('稍后重试')
  })

  it('says nothing when every endpoint reached the bot', async () => {
    mount({
      'registry.list': () => ({
        home: '/h', file: '/h/humans.json',
        humans: [{ ...human, alignment: [{ endpoint: 'bot.preset.set', ok: true }] }],
      }),
    })
    await settle()
    fireEvent.click(screen.getByText('PM'))
    await waitFor(() => expect(screen.getByDisplayValue('PM')).toBeTruthy())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders a declared number field as a number input', async () => {
    mount({
      'registry.list': () => ({
        home: '/h', file: '/h/humans.json',
        humans: [{ ...human, config: undefined, configSchema: [{ key: 'retries', label: '重试次数', type: 'number' }] }],
      }),
    })
    await settle()
    fireEvent.click(screen.getByText('PM'))
    await waitFor(() => expect(screen.getByDisplayValue('PM')).toBeTruthy())
    const field = screen.getByText('重试次数').parentElement!
    const input = field.querySelector('input') as HTMLInputElement
    expect(input.type).toBe('number')
    fireEvent.change(input, { target: { value: '3' } })
    expect(input.value).toBe('3')
  })
})
