// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apply as applyPlatform } from '../../src/index'
import { HumanStore, normalizeHuman } from '../../src/lib/store'
import { listWorkspaces, readBotMeta } from '../../src/lib/workspaces'
import { renderConfigBlock, renderOperatingContext } from '../../src/lib/presets'

const { apply: applyClient } = await import('../../src/client')

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dh-branch2-'))
})

afterEach(() => {
  cleanup()
  rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('the workspace roster read', () => {
  it('gives up on a stream that never emits its baseline', async () => {
    // A hang would hold activation open forever; an empty roster is recoverable.
    const controller = {
      follow: (signal: AbortSignal) => ({
        async *[Symbol.asyncIterator]() {
          await new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            setTimeout(resolve, 5000)
          })
          yield { type: 'baseline', value: { items: [{ workspaceId: 'late' }] } }
        },
      }),
    }
    const started = Date.now()
    expect(await listWorkspaces({ get: () => controller } as any, { timeoutMs: 20 })).toEqual([])
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('still reads a roster that arrives in time', async () => {
    const controller = {
      follow: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'baseline', value: { items: [{ workspaceId: 'w' }] } } } }),
    }
    expect(await listWorkspaces({ get: () => controller } as any, { timeoutMs: 1000 })).toEqual([{ workspaceId: 'w' }])
  })
})

describe('the bot metadata read', () => {
  it('skips an entry that is a file rather than a channel directory', async () => {
    const root = join(home, 'integrations')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'stray.txt'), 'not a directory')
    expect(await readBotMeta(home)).toEqual({ aliases: {}, workspaces: {} })
  })

  it('reads every channel directory it finds', async () => {
    for (const [channel, alias] of [['dsh-wecom', 'PM'], ['dsh-slack', 'SL']]) {
      const dir = join(home, 'integrations', channel)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({ aliases: { [`${channel}_1`]: alias }, workspaces: { [`${channel}_1`]: '/w' } }))
    }
    const meta = await readBotMeta(home)
    expect(Object.keys(meta.aliases).sort()).toEqual(['dsh-slack_1', 'dsh-wecom_1'])
    expect(meta.workspaces.dsh_wecom_1).toBeUndefined()
  })

  it('ignores a non-string alias value', async () => {
    const dir = join(home, 'integrations', 'dsh-wecom')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({ aliases: { a: 7, b: 'B' } }))
    expect((await readBotMeta(home)).aliases).toEqual({ b: 'B' })
  })
})

describe('registry validation branches', () => {
  const base = { id: 'a', name: 'A' }

  it('keeps a declared field that is both hidden and a platform fact', () => {
    const human = normalizeHuman({ ...base, configSchema: [{ key: 'k', hidden: true, from: 'self_id', type: 'text' }] })
    expect(human.configSchema?.[0]).toMatchObject({ key: 'k', hidden: true, from: 'self_id', type: 'text' })
  })

  it('ignores an option list that is not an array', () => {
    const human = normalizeHuman({ ...base, configSchema: [{ key: 'k', options: 'nope' }] })
    expect(human.configSchema?.[0].options).toBeUndefined()
  })

  it('ignores a label or description that is not a string', () => {
    const human = normalizeHuman({ ...base, configSchema: [{ key: 'k', label: 7, description: [] }] })
    expect(human.configSchema?.[0]).toMatchObject({ key: 'k' })
    expect(human.configSchema?.[0].label).toBeUndefined()
    expect(human.configSchema?.[0].description).toBeUndefined()
  })

  it('refuses a key that is not a string', () => {
    expect(() => normalizeHuman({ ...base, configSchema: [{ key: 7 }] })).toThrow(/need a key/)
  })

  it('reads a subscription, keeping the conversation id and the switch', () => {
    const human = normalizeHuman({
      ...base,
      subscriptions: [
        { cron: '0 1 * * *', prompt: 'p', conversationId: 'REQ-1', enabled: false },
        { cron: '0 2 * * *' },
      ],
    })
    expect(human.subscriptions[0]).toEqual({ cron: '0 1 * * *', prompt: 'p', conversationId: 'REQ-1', enabled: false })
    expect(human.subscriptions[1]).toEqual({ cron: '0 2 * * *', prompt: '', enabled: true })
  })

  it('refuses a subscription that is not an object, and drops one with no cron', () => {
    expect(() => normalizeHuman({ ...base, subscriptions: ['nope'] })).toThrow(/entries must be objects/)
    expect(() => normalizeHuman({ ...base, subscriptions: [{}] })).toThrow(/need a cron expression/)
    expect(() => normalizeHuman({ ...base, subscriptions: 'nope' })).toThrow(/subscriptions must be an array/)
  })

  it('refuses a skills or peers list that is not an array', () => {
    expect(() => normalizeHuman({ ...base, skills: 'nope' })).toThrow(/skills must be an array/)
    expect(() => normalizeHuman({ ...base, peers: 7 })).toThrow(/peers must be an array/)
  })

  it('refuses a non-string entry in a list', () => {
    expect(() => normalizeHuman({ ...base, skills: [7] })).toThrow(/non-empty strings/)
    expect(() => normalizeHuman({ ...base, skills: ['  '] })).toThrow(/non-empty strings/)
  })

  it('keeps a name that is not given by falling back to the id', () => {
    expect(normalizeHuman({ id: 'only-id' }).name).toBe('only-id')
  })

  it('falls back to the id when the name is not a string', () => {
    expect(normalizeHuman({ id: 'a', name: 7 }).name).toBe('a')
  })

  it('drops a field nobody can set or read', () => {
    // `escalation` and `model` were stored but never consumed, and no tool or page
    // could set them — dead surface that reads like a feature.
    const human = normalizeHuman({ ...base, escalation: { enabled: true, timeoutHours: 4 }, model: 'x' })
    expect((human as Record<string, unknown>).escalation).toBeUndefined()
    expect((human as Record<string, unknown>).model).toBeUndefined()
  })
})

describe('prompt blocks with nothing to say', () => {
  const store = { file: '/h/humans.json', memoryPath: (id: string) => `/h/${id}/memory.md` }

  it('omits the config block when the record declares and sets nothing', () => {
    expect(renderConfigBlock(normalizeHuman({ id: 'a', name: 'A' }))).toEqual([])
  })

  it('lists only what is declared when nothing resolves', () => {
    const block = renderConfigBlock(normalizeHuman({ id: 'a', name: 'A', configSchema: [{ key: 'missing' }] })).join('\n')
    expect(block).toContain('未配置')
    expect(block).toContain('missing')
  })

  it('omits the wake-up line when there are no subscriptions', () => {
    expect(renderOperatingContext(normalizeHuman({ id: 'a', name: 'A' }), store)).not.toContain('wake-ups')
  })

  it('omits the peer line when there is no peer', () => {
    const text = renderOperatingContext(normalizeHuman({ id: 'a', name: 'A', peers: [] }), store)
    expect(text).toContain('digital_human_list')
    expect(text).not.toContain('Your peers are')
  })
})

describe('a session that announced itself before the presets existed', () => {
  it('is given its permission once the roster is known', async () => {
    const listeners: Array<{ event: string; handler: Function }> = []
    const calls: Array<{ session: unknown; name: string }> = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const platform: any = {
      logger: { warn: () => {}, info: () => {} },
      effect: (fn: Function) => fn(),
      provide: (key: string, value: unknown) => {
        if (key === 'permissionPresets') (value as any) = value
      },
      get: (key: string) => {
        if (key === 'permissionPresets') return { set: (session: unknown, name: string) => calls.push({ session, name }) }
        if (key === 'workspaceController') {
          return {
            // Slow enough that the first refresh is still running when the session
            // announces itself.
            follow: async () => ({ async *[Symbol.asyncIterator]() { await gate; yield { type: 'baseline', value: { items: [] } } } }),
            create: async () => ({ workspace: { workspaceId: 'w', path: '/x' } }),
            rename: async () => ({}),
          }
        }
        return undefined
      },
      on: (event: string, handler: Function) => { listeners.push({ event, handler }); return () => {} },
      tools: { register: () => () => {} },
      agentPresets: { register: async () => async () => {}, readDocument: async () => undefined, list: async () => [] },
      sessionController: { create: async () => ({ sessionId: 's' }), prompt: async () => ({ accepted: true }), list: async () => ({ items: [] }), cancel: async () => ({}) },
      systemPrompt: { context: () => () => {} },
    }
    await new HumanStore(home).write([{
      id: 'early', name: 'Early', enabled: true, systemPrompt: 'p', workspace: '', skills: [], peers: [],
      im: { botId: '', targetId: '' }, subscriptions: [], memory: false,
    }])

    const applying = applyPlatform(platform, { home })
    // Wait until the hooks are subscribed, then announce a session while the first
    // refresh is still blocked on the roster.
    await waitFor(() => expect(listeners.some((entry) => entry.event === 'session/created')).toBe(true))
    const created = listeners.find((entry) => entry.event === 'session/created')!.handler
    created({ id: 's-early', header: { agentPreset: 'dh-early' } })
    release()
    await applying
    // Announced before the roster was known, and resolved once it was.
    expect(calls).toEqual([{ session: { id: 's-early', header: { agentPreset: 'dh-early' } }, name: 'danger-full-access' }])
  })
})

describe('the page in its remaining states', () => {
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
  }

  const settle = () => waitFor(() => expect(screen.queryByText('正在读取数字人注册表…')).toBeNull())
  const open = async () => {
    await settle()
    fireEvent.click(screen.getByText('PM'))
    await waitFor(() => expect(screen.getByDisplayValue('PM')).toBeTruthy())
  }

  it('shows a stored value the option list does not carry', async () => {
    mount({
      'registry.list': () => ({
        home: '/h', file: '/h/humans.json',
        humans: [{ ...human, workspace: '/gone', }],
      }),
    })
    await open()
    expect(screen.getByText('/gone（不在选项中）')).toBeTruthy()
  })

  it('reports a bot load that failed', async () => {
    mount({ 'im.bots': () => new Error('im down') })
    await open()
    expect(screen.getByText(/bot 列表读取失败：im down/)).toBeTruthy()
  })

  it('reports a skill load that failed', async () => {
    mount({ 'skills.list': () => new Error('skills down') })
    await open()
    expect(screen.getByText(/技能目录读取失败：skills down/)).toBeTruthy()
  })

  it('reports a workspace load that failed even when a directory is set', async () => {
    mount({ 'workspaces.list': () => new Error('ws down') })
    await open()
    expect(screen.getByText(/工作区列表读取失败：ws down（这条记录仍在 \/w 里跑）/)).toBeTruthy()
  })

  it('shows a declared number field with its description', async () => {
    mount({
      'registry.list': () => ({
        home: '/h', file: '/h/humans.json',
        humans: [{ ...human, config: undefined, configSchema: [{ key: 'retries', label: '重试次数', type: 'number', description: '最多几次' }] }],
      }),
    })
    await open()
    expect(screen.getByText('最多几次')).toBeTruthy()
  })

  it('disarms the delete when a new record is started', async () => {
    mount()
    await open()
    fireEvent.click(screen.getByText('删除'))
    expect(screen.getByText('确认删除')).toBeTruthy()
    fireEvent.click(screen.getByText('新建'))
    expect(screen.queryByText('确认删除')).toBeNull()
  })

  it('opens the create form when the roster and the workspace list are both empty', async () => {
    mount({
      'registry.list': () => ({ home: '/h', file: '/h/humans.json', humans: [] }),
      'workspaces.list': () => ({ defaultTitle: '', defaultPath: null, workspaces: [] }),
    })
    await settle()
    expect(screen.getByText('新建数字人')).toBeTruthy()
  })

  it('shows a key the declaration does not carry, and lets it be removed', async () => {
    // Such a key is invisible to the declared fields yet the save keeps sending it,
    // so without this block it would round-trip forever with no way to drop it.
    mount({
      'registry.list': () => ({
        home: '/h', file: '/h/humans.json',
        humans: [{
          ...human,
          config: { team_name: 'T', stale: 'S' },
          configSchema: [{ key: 'team_name', label: '团队名称', type: 'text' }],
        }],
      }),
    })
    await open()
    expect(screen.getByText('未声明')).toBeTruthy()
    expect(screen.getByText('stale')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('移除未声明的配置项 stale'))
    expect(screen.queryByText('stale')).toBeNull()
  })

  it('offers no undeclared block when every key is declared', async () => {
    mount({
      'registry.list': () => ({
        home: '/h', file: '/h/humans.json',
        humans: [{ ...human, config: { team_name: 'T' }, configSchema: [{ key: 'team_name', label: '团队名称', type: 'text' }] }],
      }),
    })
    await open()
    expect(screen.queryByText('未声明')).toBeNull()
  })

  it('drops a workspace whose path is not a string', async () => {
    mount({
      'workspaces.list': () => ({ defaultTitle: '数字人', defaultPath: null, workspaces: [{ workspaceId: 'w', title: 'T', path: 7 }] }),
    })
    await settle()
    expect(screen.getByText('PM')).toBeTruthy()
  })
})

describe('the permission roster the page offers', () => {
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
      'permissions.list': { default: 'x', presets: [{ value: 'custom-one', label: '自定义一', description: '说明' }] },
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
  }

  it('lists a preset the page has never heard of', async () => {
    mount()
    await waitFor(() => expect(screen.queryByText('正在读取数字人注册表…')).toBeNull())
    fireEvent.click(screen.getByText('PM'))
    await waitFor(() => expect(screen.getByDisplayValue('PM')).toBeTruthy())
    const field = screen.getByText('权限预设').parentElement!
    fireEvent.click(within(field).getByRole('button'))
    expect(within(field).getByRole('menuitem', { name: '自定义一 —— 说明' })).toBeTruthy()
  })

  it('survives a catalog answer that is not a list', async () => {
    mount({ 'permissions.list': () => ({ presets: 'nope' }) })
    await waitFor(() => expect(screen.queryByText('正在读取数字人注册表…')).toBeNull())
    fireEvent.click(screen.getByText('PM'))
    await waitFor(() => expect(screen.getByDisplayValue('PM')).toBeTruthy())
    const field = screen.getByText('权限预设').parentElement!
    fireEvent.click(within(field).getByRole('button'))
    expect(within(field).getByText(/danger-full-access（不在选项中）/)).toBeTruthy()
  })
})


