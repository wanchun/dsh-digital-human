// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { apply } = await import('../../src/client')

/** A record shaped like the Host returns it. */
const human = (patch: Record<string, any> = {}) => ({
  id: 'pm-assistant',
  name: '研发PM助手',
  description: 'PM',
  enabled: true,
  systemPrompt: '你是「{{bot_name}}」。',
  workspace: '/w',
  skills: [],
  peers: ['dev-assistant'],
  im: { botId: 'wecom_1', targetId: '', owner: 'wohR_owner' },
  subscriptions: [],
  memory: true,
  escalation: { enabled: false, timeoutHours: 24 },
  config: { team_name: 'TCTP' },
  configSchema: [
    { key: 'team_name', label: '团队名称', type: 'text' },
    { key: 'bot_name', label: '数字人名称', from: 'self_name' },
    { key: 'default_project', label: '默认项目', type: 'select', options: [{ label: 'A', value: 'a' }] },
    { key: 'quiet', label: '静默', type: 'boolean' },
    { key: 'hidden_one', label: '藏起来', hidden: true },
  ],
  resolved: { values: { team_name: 'TCTP', bot_name: '研发PM助手' }, sources: { team_name: '配置', bot_name: '自动' } },
  alignment: [],
  ...patch,
})

/** The full answer to `registry.list`. */
const listValue = (humans: any[], extra: Record<string, unknown> = {}) => ({
  home: '/home/digital-human',
  file: '/home/digital-human/humans.json',
  humans,
  ...extra,
})

/**
 * Mount the page exactly as the slot system does, and hand back the recorded calls.
 */
function mount(answers: Record<string, (payload: any) => any>) {
  const registrations: Array<{ options: any; Component: any }> = []
  const calls: Array<{ method: string; payload: any }> = []
  const rpc = vi.fn(async (method: string, payload: any) => {
    calls.push({ method, payload })
    const answer = answers[method]
    if (!answer) return { ok: true, value: {} }
    const value = answer(payload)
    if (value instanceof Error) return { ok: false, error: { message: value.message } }
    return { ok: true, value }
  })
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    connection: { rpc: { call: (_channel: string, _endpoint: string, request: any) => rpc(request.method, request.payload) } },
    slots: {
      inject: (_name: string, factory: () => unknown) => factory(),
      register: (options: any, Component: any) => {
        registrations.push({ options, Component })
        return () => {}
      },
    },
  }
  apply(ctx)
  const main = registrations.find((entry) => entry.options.name === 'main')!
  const rendered = render(React.createElement(main.Component, main.options.inject()))
  return { ...rendered, registrations, calls, rpc }
}

const defaultAnswers = () => ({
  'registry.list': () => listValue([human(), human({ id: 'dev-assistant', name: '开发助手', im: { botId: '', targetId: '', owner: '' } })]),
  'im.bots': () => ({ bots: [{ botId: 'wecom_1', channel: 'wecom', alias: 'PM', workspace: '/w' }] }),
  'workspaces.list': () => ({ defaultTitle: '数字人', defaultPath: '/w', workspaces: [{ workspaceId: 'w', title: '数字人', path: '/w' }] }),
  'skills.list': () => ({ skills: [{ name: 'qs', description: 'q' }] }),
  'skills.library': () => ({
    skills: [{ name: 'qs', description: 'q', whenToUse: '', files: ['SKILL.md'], bytes: 10, named: true }],
  }),
  'permissions.list': () => ({
    default: 'danger-full-access',
    presets: [
      { value: 'danger-full-access', label: '完全权限', description: '不限制沙箱' },
      { value: 'read-only', label: '只读', description: '需要批准' },
    ],
  }),
  'registry.save': (payload: any) => ({ human: human(payload.patch), presetId: 'dh-pm-assistant' }),
  'registry.remove': () => ({ removed: true }),
})

let view: ReturnType<typeof mount>

afterEach(() => {
  view?.unmount()
  vi.restoreAllMocks()
})

const settle = () => waitFor(() => expect(screen.queryByText('正在读取数字人注册表…')).toBeNull())

describe('slot registration', () => {
  it('registers the sidebar entry and the main panel', () => {
    view = mount(defaultAnswers())
    const names = view.registrations.map((entry) => entry.options.name)
    expect(names).toContain('sidebar.panellist')
    expect(names).toContain('main')
    // The settings page carries no entry: the sidebar panel is the only way in.
    expect(names).not.toContain('settings.section')
    expect(view.registrations.find((entry) => entry.options.name === 'sidebar.panellist')!.options.order).toBe(20)
  })

  it('hands the panel a caller bound to the shared channel', async () => {
    view = mount(defaultAnswers())
    await settle()
    expect(view.calls[0].method).toBe('registry.list')
  })
})

describe('the list column', () => {
  it('shows every record and marks the selected one', async () => {
    view = mount(defaultAnswers())
    await settle()
    expect(screen.getByText('研发PM助手')).toBeTruthy()
    expect(screen.getByText('开发助手')).toBeTruthy()
  })

  it('selects a record and loads its detail', async () => {
    view = mount(defaultAnswers())
    await settle()
    fireEvent.click(screen.getByText('开发助手'))
    await waitFor(() => expect(screen.getByDisplayValue('开发助手')).toBeTruthy())
  })

  it('creates a new record from the list', async () => {
    view = mount(defaultAnswers())
    await settle()
    fireEvent.click(screen.getByText('新建'))
    await waitFor(() => expect(screen.getByText('新建数字人')).toBeTruthy())
  })

  it('reports a load failure instead of an empty list', async () => {
    view = mount({ ...defaultAnswers(), 'registry.list': () => new Error('boom') })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('boom'))
  })
})

describe('the detail form', () => {
  beforeEach(async () => {
    view = mount(defaultAnswers())
    await settle()
    fireEvent.click(screen.getByText('研发PM助手'))
    await waitFor(() => expect(screen.getByDisplayValue('研发PM助手')).toBeTruthy())
  })

  it('renders the declared fields and hides the rest', () => {
    expect(screen.getByText('团队名称')).toBeTruthy()
    expect(screen.getByText('数字人名称')).toBeTruthy()
    expect(screen.getByText('默认项目')).toBeTruthy()
    expect(screen.getByText('静默')).toBeTruthy()
    expect(screen.queryByText('藏起来')).toBeNull()
  })

  it('shows a platform fact as read-only, without echoing the value', () => {
    const label = screen.getByText('数字人名称')
    const field = label.parentElement!
    expect(within(field).getByText(/平台自动提供/)).toBeTruthy()
    // The operator cannot type a value the platform already knows.
    expect(within(field).queryByRole('textbox')).toBeNull()
  })

  it('shows the owner as read-only', () => {
    const field = screen.getByText('负责人').parentElement!
    expect(within(field).getByText('wohR_owner')).toBeTruthy()
  })

  it('edits a declared text field', () => {
    const input = screen.getByDisplayValue('TCTP')
    fireEvent.change(input, { target: { value: 'NEW' } })
    expect(screen.getByDisplayValue('NEW')).toBeTruthy()
  })

  it('picks a declared select option', () => {
    const field = screen.getByText('默认项目').parentElement!
    fireEvent.click(within(field).getByRole('button'))
    fireEvent.click(within(field).getByRole('menuitem', { name: 'A' }))
    expect(within(field).getByText('A')).toBeTruthy()
  })

  it('toggles a declared boolean field', () => {
    const field = screen.getByText('静默').parentElement!
    const box = within(field).getByRole('checkbox') as HTMLInputElement
    fireEvent.click(box)
    expect(box.checked).toBe(true)
  })

  it('toggles the enable and memory switches', () => {
    const enabled = screen.getByLabelText('启用') as HTMLInputElement
    fireEvent.click(enabled)
    expect(enabled.checked).toBe(false)
    const memory = screen.getByLabelText('持久记忆') as HTMLInputElement
    fireEvent.click(memory)
    expect(memory.checked).toBe(false)
  })

  it('picks a peer', () => {
    // The record already lists this peer, so the click clears the selection.
    const peer = screen.getByLabelText('开发助手（dev-assistant）') as HTMLInputElement
    expect(peer.checked).toBe(true)
    fireEvent.click(peer)
    expect(peer.checked).toBe(false)
  })

  it('picks a skill from the plugin skill space', async () => {
    // Only what is checked is mounted, and only from the plugin's own space: the
    // global catalogue loads for every digital human without being chosen.
    // The exact label, because the skill's own remove button also carries the name.
    const skill = await screen.findByLabelText('qs（1 个文件）') as HTMLInputElement
    fireEvent.click(skill)
    expect(skill.checked).toBe(true)
  })

  it('offers the permission roster the host reports, not a list copied into the page', () => {
    const field = screen.getByText('权限预设').parentElement!
    fireEvent.click(within(field).getByRole('button'))
    expect(within(field).getByRole('menuitem', { name: /完全权限 —— 不限制沙箱/ })).toBeTruthy()
    fireEvent.click(within(field).getByRole('menuitem', { name: /^只读 ——/ }))
    expect(within(field).getByText(/只读 ——/)).toBeTruthy()
  })

  it('shows the stored preset when the roster cannot be read', async () => {
    view.unmount()
    view = mount({ ...defaultAnswers(), 'permissions.list': () => new Error('no catalog') })
    await settle()
    fireEvent.click(screen.getByText('研发PM助手'))
    await waitFor(() => expect(screen.getByDisplayValue('研发PM助手')).toBeTruthy())
    const field = screen.getByText('权限预设').parentElement!
    // A record without a stored preset reads as the creation default, and an empty
    // roster must still show it rather than an empty picker.
    expect(within(field).getByText(/danger-full-access（不在选项中）/)).toBeTruthy()
  })

  it('picks a bound bot and warns about a workspace mismatch', () => {
    const field = screen.getByText('IM bot').parentElement!
    fireEvent.click(within(field).getByRole('button'))
    expect(within(field).getByRole('menuitem', { name: /PM/ })).toBeTruthy()
  })

  it('picks a workspace', () => {
    const field = screen.getByText('工作区').parentElement!
    fireEvent.click(within(field).getByRole('button'))
    fireEvent.click(within(field).getByRole('menuitem', { name: '数字人' }))
    expect(within(field).getByText('数字人')).toBeTruthy()
  })

  it('saves the record and reports the preset', async () => {
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(view.calls.some((entry) => entry.method === 'registry.save')).toBe(true))
    const save = view.calls.find((entry) => entry.method === 'registry.save')!
    expect(save.payload.partial).toBe(true)
    // The page cannot show a target, so it must not erase one.
    expect(save.payload.patch.im.targetId).toBeUndefined()
    await waitFor(() => expect(screen.getByText(/已保存/)).toBeTruthy())
  })

  it('reports a refused save', async () => {
    view.unmount()
    view = mount({ ...defaultAnswers(), 'registry.save': () => new Error('宿主拒绝了这次请求') })
    await settle()
    fireEvent.click(screen.getByText('研发PM助手'))
    await waitFor(() => expect(screen.getByDisplayValue('研发PM助手')).toBeTruthy())
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('宿主拒绝'))
  })

  it('arms the delete on the first click and only deletes on the second', async () => {
    // One click also drops the record's agent preset, and the button sits beside
    // 保存, so the first click must not delete anything.
    fireEvent.click(screen.getByText('删除'))
    expect(screen.getByText('确认删除')).toBeTruthy()
    expect(view.calls.some((entry) => entry.method === 'registry.remove')).toBe(false)
    fireEvent.click(screen.getByText('确认删除'))
    await waitFor(() => expect(view.calls.some((entry) => entry.method === 'registry.remove')).toBe(true))
  })

  it('reports a refused delete', async () => {
    view.unmount()
    view = mount({ ...defaultAnswers(), 'registry.remove': () => new Error('nope') })
    await settle()
    fireEvent.click(screen.getByText('研发PM助手'))
    await waitFor(() => expect(screen.getByDisplayValue('研发PM助手')).toBeTruthy())
    fireEvent.click(screen.getByText('删除'))
    fireEvent.click(screen.getByText('确认删除'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('nope'))
  })

  it('disarms the delete when another record is opened', () => {
    fireEvent.click(screen.getByText('删除'))
    expect(screen.getByText('确认删除')).toBeTruthy()
    fireEvent.click(screen.getByText('开发助手'))
    expect(screen.queryByText('确认删除')).toBeNull()
  })

  it('edits the persona prose', () => {
    const area = screen.getByDisplayValue(/你是「/) as HTMLTextAreaElement
    fireEvent.change(area, { target: { value: 'NEW PROSE' } })
    expect(screen.getByDisplayValue('NEW PROSE')).toBeTruthy()
  })

  it('edits the display name and the id', () => {
    fireEvent.change(screen.getByDisplayValue('研发PM助手'), { target: { value: 'Renamed' } })
    expect(screen.getByDisplayValue('Renamed')).toBeTruthy()
  })
})

describe('a record that declares nothing', () => {
  it('falls back to the name and value rows', async () => {
    view = mount({
      ...defaultAnswers(),
      'registry.list': () => listValue([human({ configSchema: undefined, config: { free: 'value' } })]),
    })
    await settle()
    fireEvent.click(screen.getByText('研发PM助手'))
    await waitFor(() => expect(screen.getByText(/这条记录还没有声明字段/)).toBeTruthy())
    expect(screen.getByDisplayValue('free')).toBeTruthy()
    fireEvent.click(screen.getByText('添加一项'))
    await waitFor(() => expect(screen.getAllByPlaceholderText('名称').length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByText('删除')[0])
  })
})

describe('an empty profile', () => {
  it('opens a new record when nothing is configured yet', async () => {
    // A fresh profile is offered a record to create; the empty-list copy is
    // deliberately suppressed while the create form is open.
    view = mount({ ...defaultAnswers(), 'registry.list': () => listValue([]) })
    await settle()
    expect(screen.getByText('新建数字人')).toBeTruthy()
    expect(screen.queryByText(/还没有数字人/)).toBeNull()
    expect(screen.getByText('创建')).toBeTruthy()
  })

  it('says the list is empty once the last record is gone', async () => {
    view = mount({ ...defaultAnswers(), 'registry.list': () => listValue([human()]) })
    await settle()
    fireEvent.click(screen.getByText('研发PM助手'))
    await waitFor(() => expect(screen.getByDisplayValue('研发PM助手')).toBeTruthy())
    fireEvent.click(screen.getByText('删除'))
    fireEvent.click(screen.getByText('确认删除'))
    await waitFor(() => expect(screen.getByText(/还没有数字人/)).toBeTruthy())
  })

  it('says so when the bot, workspace and skill loads fail', async () => {
    view = mount({
      ...defaultAnswers(),
      'im.bots': () => new Error('no im'),
      'workspaces.list': () => new Error('no ws'),
      'skills.list': () => new Error('no skills'),
    })
    await settle()
    fireEvent.click(screen.getByText('研发PM助手'))
    // A failed load must not read as an empty profile: only one of those is the
    // operator's to fix.
    await waitFor(() => expect(screen.getByText(/bot 列表读取失败：no im/)).toBeTruthy())
    expect(screen.getByText(/技能目录读取失败：no skills/)).toBeTruthy()
    expect(screen.getByText(/工作区列表读取失败：no ws/)).toBeTruthy()
    expect(screen.queryByText(/还没有 bot/)).toBeNull()
    expect(screen.queryByText(/没有可用的技能/)).toBeNull()
  })
})
