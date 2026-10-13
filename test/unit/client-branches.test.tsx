// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { apply } = await import('../../src/client')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** A record with every optional part absent, so the page's fallbacks run. */
const bare = {
  id: 'bare', name: 'Bare', enabled: true, systemPrompt: 'p', workspace: '',
  skills: [], peers: [], subscriptions: [], memory: true,
}

/**
 * Mount the page as the slot system does, with one answer per Host method.
 *
 * The list and the three side loads always answer, because the page reads each of
 * them unconditionally on mount.
 */
function mount(answers: Record<string, any> = {}) {
  const registrations: any[] = []
  const calls: Array<{ method: string; payload: any }> = []
  const defaults: Record<string, any> = {
    'registry.list': { home: '/h', file: '/h/humans.json', humans: [] },
    'im.bots': { bots: [] },
    'workspaces.list': { defaultTitle: '数字人', defaultPath: null, workspaces: [] },
    'skills.list': { skills: [] },
    'skills.library': {
      skills: [{ name: 'qs', description: 'q', whenToUse: '', files: ['SKILL.md'], bytes: 10, named: true }],
    },
    'registry.save': { human: bare, presetId: 'dh-bare' },
    'registry.remove': { removed: true },
  }
  const rpc = vi.fn(async (method: string, payload: any) => {
    calls.push({ method, payload })
    const answer = answers[method] ?? defaults[method]
    if (answer === undefined) return { ok: true, value: {} }
    const value = typeof answer === 'function' ? answer(payload) : answer
    if (value instanceof Error) return { ok: false, error: { message: value.message } }
    return { ok: true, value }
  })
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    connection: { rpc: { call: (_c: string, _e: string, request: any) => rpc(request.method, request.payload) } },
    slots: {
      inject: (_name: string, factory: () => unknown) => factory(),
      register: (options: any, Component: any) => { registrations.push({ options, Component }); return () => {} },
    },
  }
  apply(ctx)
  const main = registrations.find((entry) => entry.options.name === 'main')!
  const rendered = render(React.createElement(main.Component, main.options.inject()))
  return { ...rendered, registrations, calls }
}

/** Wait for the first read to finish. */
const settle = () => waitFor(() => expect(screen.queryByText('正在读取数字人注册表…')).toBeNull())

const listOf = (humans: any[]) => ({ home: '/h', file: '/h/humans.json', humans })

describe('a record with nothing optional set', () => {
  it('opens in create mode and keeps every fallback empty', async () => {
    mount({ 'registry.list': () => listOf([{ id: 'bare', name: 'Bare', enabled: true, systemPrompt: 'p' }]) })
    await settle()
    expect(screen.getByText('Bare')).toBeTruthy()
    fireEvent.click(screen.getByText('Bare'))
    await waitFor(() => expect(screen.getByDisplayValue('Bare')).toBeTruthy())
    // No peers, no bot, no owner: each section says so instead of failing. The skill
    // space has an entry, so it offers the checkbox and the upload control.
    expect(screen.getByText('还没有别的数字人可以联系。')).toBeTruthy()
    expect(screen.getByText('上传技能')).toBeTruthy()
    expect(screen.getByLabelText('qs（1 个文件）')).toBeTruthy()
    expect(screen.getByText(/还没有 bot/)).toBeTruthy()
  })

  it('sends no optional field it was never given', async () => {
    const view = mount({ 'registry.list': () => listOf([{ id: 'bare', name: 'Bare', enabled: true, systemPrompt: 'p' }]) })
    await settle()
    fireEvent.click(screen.getByText('Bare'))
    await waitFor(() => expect(screen.getByDisplayValue('Bare')).toBeTruthy())
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(view.calls.some((entry) => entry.method === 'registry.save')).toBe(true))
    const patch = view.calls.find((entry) => entry.method === 'registry.save')!.payload.patch
    expect(patch.peers).toEqual([])
    expect(patch.skills).toEqual([])
    expect(patch.im).toEqual({ botId: '', owner: '' })
  })
})

describe('how a bound bot relates to the digital human workspace', () => {
  const withBot = (bot: any) => ({
    'registry.list': () => listOf([{ ...bare, id: 'w', name: 'W', workspace: '/w', im: { botId: 'wecom_1', owner: '' } }]),
    'im.bots': () => ({ bots: [bot] }),
  })

  const openAndPick = async () => {
    await settle()
    fireEvent.click(screen.getByText('W'))
    await waitFor(() => expect(screen.getByDisplayValue('W')).toBeTruthy())
    const field = screen.getByText('IM bot').parentElement!
    fireEvent.click(within(field).getByRole('button'))
    fireEvent.click(within(field).getByRole('menuitem', { name: /PM/ }))
  }

  it('says the bot has no workspace yet', async () => {
    mount(withBot({ botId: 'wecom_1', channel: 'wecom', alias: 'PM', workspace: '' }))
    await openAndPick()
    expect(screen.getByText(/这个 bot 还没有工作区/)).toBeTruthy()
  })

  it('reports a workspace that differs from the digital human', async () => {
    mount(withBot({ botId: 'wecom_1', channel: 'wecom', alias: 'PM', workspace: '/other' }))
    await openAndPick()
    expect(screen.getByText(/bot 的工作区是 \/other/)).toBeTruthy()
  })

  it('confirms an aligned workspace', async () => {
    mount(withBot({ botId: 'wecom_1', channel: 'wecom', alias: 'PM', workspace: '/w' }))
    await openAndPick()
    expect(screen.getByText(/已对齐/)).toBeTruthy()
  })

  it('explains where an alias comes from when the bound bot is not in the list', async () => {
    mount({
      'registry.list': () => listOf([{ ...bare, id: 'w', name: 'W', im: { botId: 'wecom_gone', owner: '' } }]),
      'im.bots': () => ({ bots: [{ botId: 'wecom_other', channel: 'wecom', alias: 'Other', workspace: '/w' }] }),
    })
    await settle()
    fireEvent.click(screen.getByText('W'))
    await waitFor(() => expect(screen.getByDisplayValue('W')).toBeTruthy())
    expect(screen.getByText(/别名在「设置 → IM机器人」里设置/)).toBeTruthy()
  })
})

describe('declared fields with nothing filled in', () => {
  const schemaRecord = (schema: any[]) => ({
    ...bare, id: 's', name: 'S', config: undefined, configSchema: schema,
  })

  it('renders a select with no options as only the empty choice', async () => {
    mount({ 'registry.list': () => listOf([schemaRecord([{ key: 'pick', label: '选择', type: 'select' }])]) })
    await settle()
    fireEvent.click(screen.getByText('S'))
    await waitFor(() => expect(screen.getByDisplayValue('S')).toBeTruthy())
    const field = screen.getByText('选择').parentElement!
    fireEvent.click(within(field).getByRole('button'))
    expect(within(field).getByRole('menuitem', { name: '（未设置）' })).toBeTruthy()
  })

  it('adds a row the first time a boolean is switched on, and drops it when off', async () => {
    const view = mount({ 'registry.list': () => listOf([schemaRecord([{ key: 'quiet', label: '静默', type: 'boolean' }])]) })
    await settle()
    fireEvent.click(screen.getByText('S'))
    await waitFor(() => expect(screen.getByDisplayValue('S')).toBeTruthy())
    const box = screen.getByLabelText('静默') as HTMLInputElement
    fireEvent.click(box)
    expect(box.checked).toBe(true)
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(view.calls.some((entry) => entry.method === 'registry.save')).toBe(true))
    const save = view.calls.find((entry) => entry.method === 'registry.save')!
    expect(save.payload.patch.config).toEqual({ quiet: 'true' })
  })

  it('shows a platform fact with and without a description', async () => {
    mount({
      'registry.list': () => listOf([schemaRecord([
        { key: 'a', label: '无说明', from: 'self_name' },
        { key: 'b', label: '有说明', from: 'self_name', description: '说明文字' },
      ])]),
    })
    await settle()
    fireEvent.click(screen.getByText('S'))
    await waitFor(() => expect(screen.getByDisplayValue('S')).toBeTruthy())
    expect(screen.getByText('平台自动提供，不用填。')).toBeTruthy()
    expect(screen.getByText(/说明文字/)).toBeTruthy()
  })

  it('falls back to the key when a field declares no label', async () => {
    mount({ 'registry.list': () => listOf([schemaRecord([{ key: 'no_label', type: 'text' }])]) })
    await settle()
    fireEvent.click(screen.getByText('S'))
    await waitFor(() => expect(screen.getByDisplayValue('S')).toBeTruthy())
    expect(screen.getByText('no_label')).toBeTruthy()
  })
})

describe('side loads that answer oddly', () => {
  it('survives a workspace answer with nothing in it', async () => {
    mount({
      'registry.list': () => listOf([bare]),
      'workspaces.list': () => ({}),
    })
    await settle()
    fireEvent.click(screen.getByText('Bare'))
    await waitFor(() => expect(screen.getByDisplayValue('Bare')).toBeTruthy())
    expect(screen.getByText('工作区')).toBeTruthy()
  })

  it('survives a workspace answer that is not a list', async () => {
    mount({
      'registry.list': () => listOf([bare]),
      'workspaces.list': () => ({ workspaces: 'nope', defaultTitle: 'x', defaultPath: 7 }),
    })
    await settle()
    fireEvent.click(screen.getByText('Bare'))
    await waitFor(() => expect(screen.getByDisplayValue('Bare')).toBeTruthy())
    expect(screen.getByText('工作区')).toBeTruthy()
  })

  it('survives a bot answer with nothing in it', async () => {
    mount({ 'registry.list': () => listOf([bare]), 'im.bots': () => ({}) })
    await settle()
    fireEvent.click(screen.getByText('Bare'))
    await waitFor(() => expect(screen.getByDisplayValue('Bare')).toBeTruthy())
    expect(screen.getByText(/还没有 bot/)).toBeTruthy()
  })

  it('survives a global skill catalogue that is not a list', async () => {
    mount({ 'registry.list': () => listOf([bare]), 'skills.list': () => ({ skills: 'nope' }) })
    await settle()
    fireEvent.click(screen.getByText('Bare'))
    await waitFor(() => expect(screen.getByDisplayValue('Bare')).toBeTruthy())
    // The global catalogue is a convenience; the plugin's own space is what the
    // checkboxes act on, so a broken catalogue does not take the section down.
    expect(screen.getByLabelText('qs（1 个文件）')).toBeTruthy()
  })

  it('keeps a configured skill that the catalogue does not list', async () => {
    mount({
      'registry.list': () => listOf([{ ...bare, skills: ['private-skill'] }]),
      'skills.list': () => ({ skills: [{ name: 'qs', description: 'q' }] }),
    })
    await settle()
    fireEvent.click(screen.getByText('Bare'))
    await waitFor(() => expect(screen.getByDisplayValue('Bare')).toBeTruthy())
    // A configured skill the library does not carry is called out by name, so the
    // operator can see the record mounting something nobody uploaded.
    expect(screen.getByText(/已勾选但技能空间里没有的：private-skill/)).toBeTruthy()
  })
})

describe('a record that omits the optional parts', () => {
  it('renders with nothing to fall back on, and adds a row when a switch is turned on', async () => {
    // No systemPrompt, no skills, no config: every optional field is absent, which is
    // what a hand-written registry entry looks like before the page has saved it.
    mount({
      'registry.list': () => listOf([{
        id: 'sparse', name: 'Sparse', enabled: true,
        configSchema: [{ key: 'quiet', label: '静默', type: 'boolean' }],
      }]),
    })
    await settle()
    fireEvent.click(screen.getByText('Sparse'))
    await waitFor(() => expect(screen.getByDisplayValue('Sparse')).toBeTruthy())
    const box = screen.getByLabelText('静默') as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    expect(box.checked).toBe(true)
    // The prose field is empty rather than undefined, and the skill list is empty
    // rather than missing.
    expect(screen.getByText('人设')).toBeTruthy()
    expect(screen.getByText('上传技能')).toBeTruthy()
  })

  it('tells the operator to pick a workspace when the bound bot has none', async () => {
    mount({
      'registry.list': () => listOf([{
        ...bare, id: 'w', name: 'W', workspace: '',
        im: { botId: 'wecom_1', owner: '' },
      }]),
      'im.bots': () => ({ bots: [{ botId: 'wecom_1', channel: 'wecom', alias: 'PM', workspace: '/w' }] }),
    })
    await settle()
    fireEvent.click(screen.getByText('W'))
    await waitFor(() => expect(screen.getByDisplayValue('W')).toBeTruthy())
    const field = screen.getByText('IM bot').parentElement!
    fireEvent.click(within(field).getByRole('button'))
    fireEvent.click(within(field).getByRole('menuitem', { name: /PM/ }))
    expect(screen.getByText(/数字人还没选工作区/)).toBeTruthy()
  })
})

describe('export and import', () => {
  const openBare = async () => {
    await settle()
    fireEvent.click(screen.getByText('Bare'))
    await waitFor(() => expect(screen.getByDisplayValue('Bare')).toBeTruthy())
  }

  it('downloads the selected record as a bundle', async () => {
    const opened: string[] = []
    vi.spyOn(window, 'open').mockImplementation(((url: string) => { opened.push(String(url)); return null }) as never)
    mount({ 'registry.list': () => listOf([bare]) })
    await openBare()
    fireEvent.click(screen.getByText('导出'))
    // A plain navigation, so the browser saves the file itself rather than the page
    // routing megabytes through the JSON channel.
    expect(opened).toEqual(['/api/digital-human/bundle/bare?memory=1'])
  })

  it('leaves the memory out of the bundle when the record has none', async () => {
    const opened: string[] = []
    vi.spyOn(window, 'open').mockImplementation(((url: string) => { opened.push(String(url)); return null }) as never)
    mount({ 'registry.list': () => listOf([{ ...bare, memory: false }]) })
    await openBare()
    fireEvent.click(screen.getByText('导出'))
    expect(opened).toEqual(['/api/digital-human/bundle/bare'])
  })

  it('uploads a bundle and reports what it wrote', async () => {
    const posted: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string, init: any) => {
      posted.push(String(url))
      void init
      return { json: async () => ({ ok: true, value: { id: 'imported', skills: ['qs'], memory: true } }) }
    }) as never
    try {
      mount({ 'registry.list': () => listOf([bare]) })
      await settle()
      const input = document.querySelector('input[accept*=".gz"]') as HTMLInputElement
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.dh.tar.gz')] } })
      await waitFor(() => expect(screen.getByText(/已导入 imported/)).toBeTruthy())
      expect(posted).toEqual(['/api/digital-human/bundle'])
      expect(screen.getByText(/技能 1 个，含记忆/)).toBeTruthy()
    } finally {
      globalThis.fetch = original
    }
  })

  it('reports a host that answered with something unreadable', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => ({ json: async () => { throw new Error('not json') } })) as never
    try {
      mount({ 'registry.list': () => listOf([bare]) })
      await settle()
      const input = document.querySelector('input[accept*=".gz"]') as HTMLInputElement
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.dh.tar.gz')] } })
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('宿主没有返回可读的结果'))
    } finally {
      globalThis.fetch = original
    }
  })

  it('ignores an empty import pick', async () => {
    mount({ 'registry.list': () => listOf([bare]) })
    await settle()
    const input = document.querySelector('input[accept*=".gz"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [] } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a bundle the host refused', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => ({ json: async () => ({ ok: false, error: { message: 'not a readable .tar.gz' } }) })) as never
    try {
      mount({ 'registry.list': () => listOf([bare]) })
      await settle()
      const input = document.querySelector('input[accept*=".gz"]') as HTMLInputElement
      fireEvent.change(input, { target: { files: [new File(['x'], 'a.dh.tar.gz')] } })
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not a readable'))
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('the plugin skill space', () => {
  const openBare = async () => {
    await settle()
    fireEvent.click(screen.getByText('Bare'))
    await waitFor(() => expect(screen.getByDisplayValue('Bare')).toBeTruthy())
  }

  const pick = (name: string, path: string, body: string) => {
    const file = new File([body], name, { type: 'text/markdown' })
    // jsdom does not set this, and a directory pick is what carries a skill's
    // relative paths.
    Object.defineProperty(file, 'webkitRelativePath', { value: path })
    return file
  }

  it('uploads a picked directory as one skill, named from its frontmatter', async () => {
    const calls: Array<{ method: string; payload: any }> = []
    const view = mount({
      'registry.list': () => listOf([bare]),
      'skills.upload': (payload: any) => { calls.push({ method: 'skills.upload', payload }); return { skill: { name: 'declared' } } },
    })
    void view
    await openBare()
    const input = screen.getByLabelText('选择技能文件') as HTMLInputElement
    fireEvent.change(input, {
      target: {
        files: [
          pick('SKILL.md', 'folder/SKILL.md', '---\nname: declared\ndescription: d\n---\n# Body\n'),
          pick('cli.md', 'folder/references/cli.md', 'ref'),
        ],
      },
    })
    await waitFor(() => expect(calls.length).toBe(1))
    // The chosen folder is not part of the skill; the frontmatter names it.
    expect(calls[0].payload).toEqual({
      name: 'declared',
      files: { 'SKILL.md': '---\nname: declared\ndescription: d\n---\n# Body\n', 'references/cli.md': 'ref' },
    })
    await waitFor(() => expect(screen.getByText(/已上传技能 declared/)).toBeTruthy())
  })

  it('falls back to the folder name when the frontmatter names nothing', async () => {
    const calls: any[] = []
    mount({
      'registry.list': () => listOf([bare]),
      'skills.upload': (payload: any) => { calls.push(payload); return { skill: { name: 'x' } } },
    })
    await openBare()
    const input = screen.getByLabelText('选择技能文件') as HTMLInputElement
    fireEvent.change(input, { target: { files: [pick('SKILL.md', 'my-skill/SKILL.md', '# no frontmatter\n')] } })
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0].name).toBe('my-skill')
  })

  it('ignores an empty pick', async () => {
    const calls: any[] = []
    mount({
      'registry.list': () => listOf([bare]),
      'skills.upload': (payload: any) => { calls.push(payload); return { skill: { name: 'x' } } },
    })
    await openBare()
    const input = screen.getByLabelText('选择技能文件') as HTMLInputElement
    fireEvent.change(input, { target: { files: [] } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toEqual([])
  })

  it('reports an upload the host refused', async () => {
    mount({
      'registry.list': () => listOf([bare]),
      'skills.upload': () => new Error('a skill may hold at most 2000 files'),
    })
    await openBare()
    const input = screen.getByLabelText('选择技能文件') as HTMLInputElement
    fireEvent.change(input, { target: { files: [pick('SKILL.md', 'qs/SKILL.md', 'x')] } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('at most 2000 files'))
  })

  it('removes a skill, and unchecks it on the record that mounted it', async () => {
    const removed: any[] = []
    let inLibrary = true
    mount({
      'registry.list': () => listOf([{ ...bare, skills: ['qs'] }]),
      // The space is stateful, because the page reloads it after a removal.
      'skills.library': () => ({ skills: inLibrary ? [{ name: 'qs', files: ['SKILL.md'] }] : [] }),
      'skills.remove': (payload: any) => { removed.push(payload); inLibrary = false; return { removed: true } },
    })
    await settle()
    fireEvent.click(screen.getByText('Bare'))
    await waitFor(() => expect(screen.getByDisplayValue('Bare')).toBeTruthy())
    const box = screen.getByLabelText('qs（1 个文件）') as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(screen.getByLabelText('移除技能 qs'))
    await waitFor(() => expect(removed).toEqual([{ name: 'qs' }]))
    // A record that kept naming a removed skill would carry the warning for ever.
    await waitFor(() => expect(screen.getByText(/已勾选但技能空间里没有的：qs/)).toBeTruthy())
  })

  it('uploads a single file, which carries no folder name', async () => {
    const calls: any[] = []
    mount({
      'registry.list': () => listOf([bare]),
      'skills.upload': (payload: any) => { calls.push(payload); return { skill: { name: 'x' } } },
    })
    await openBare()
    const input = screen.getByLabelText('选择技能文件') as HTMLInputElement
    fireEvent.change(input, { target: { files: [pick('SKILL.md', '', '---\nname: "quoted"\n---\n')] } })
    await waitFor(() => expect(calls.length).toBe(1))
    // A quoted frontmatter name is unwrapped, and the file's own name is the last
    // resort when nothing declares one.
    expect(calls[0].name).toBe('quoted')
  })

  it('names a lone file after itself when nothing declares a name', async () => {
    const calls: any[] = []
    mount({
      'registry.list': () => listOf([bare]),
      'skills.upload': (payload: any) => { calls.push(payload); return { skill: { name: 'x' } } },
    })
    await openBare()
    const input = screen.getByLabelText('选择技能文件') as HTMLInputElement
    fireEvent.change(input, { target: { files: [pick('SKILL.md', '', '# no frontmatter\n')] } })
    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls[0].name).toBe('SKILL')
  })

  it('leaves the mounted list alone when the removed skill was not checked', async () => {
    mount({
      'registry.list': () => listOf([{ ...bare, skills: [] }]),
      'skills.library': () => ({ skills: [{ name: 'qs', files: ['SKILL.md'] }] }),
      'skills.remove': () => ({ removed: true }),
    })
    await settle()
    fireEvent.click(screen.getByText('Bare'))
    await waitFor(() => expect(screen.getByDisplayValue('Bare')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('移除技能 qs'))
    await waitFor(() => expect(screen.getByText(/已删除技能 qs/)).toBeTruthy())
    // Nothing was checked, so there is no missing-skill warning to show.
    expect(screen.queryByText(/已勾选但技能空间里没有的/)).toBeNull()
  })

  it('says the space is empty when nothing was uploaded', async () => {
    mount({
      'registry.list': () => listOf([bare]),
      'skills.library': () => ({ skills: [] }),
    })
    await openBare()
    expect(screen.getByText(/技能空间是空的/)).toBeTruthy()
  })

  it('reports a skill space that could not be read, without claiming anything is missing', async () => {
    // A failed read is not an absence: saying "these will not load" about skills
    // that load from the deployment's own roots would be a false alarm.
    mount({
      'registry.list': () => listOf([{ ...bare, skills: ['qs'] }]),
      'skills.library': () => new Error('library is unreadable'),
    })
    await openBare()
    await waitFor(() => expect(screen.getByText(/技能空间读取失败：library is unreadable/)).toBeTruthy())
    expect(screen.queryByText(/已勾选但技能空间里没有的/)).toBeNull()
  })
})

describe('the list column states', () => {
  it('marks the open record as active', async () => {
    mount({ 'registry.list': () => listOf([{ ...bare, id: 'a', name: 'A' }, { ...bare, id: 'b', name: 'B' }]) })
    await settle()
    fireEvent.click(screen.getByText('B'))
    await waitFor(() => expect(screen.getByDisplayValue('B')).toBeTruthy())
    const active = document.querySelectorAll('.dh-item[data-active="true"]')
    expect(active).toHaveLength(1)
    expect(active[0].textContent).toContain('B')
  })

  it('shows a disabled record as disabled', async () => {
    mount({ 'registry.list': () => listOf([{ ...bare, id: 'd', name: 'D', enabled: false }]) })
    await settle()
    fireEvent.click(screen.getByText('D（已停用）'))
    await waitFor(() => expect(screen.getByDisplayValue('D')).toBeTruthy())
    const enabled = screen.getByLabelText('启用') as HTMLInputElement
    expect(enabled.checked).toBe(false)
  })
})

describe('the action row', () => {
  it('refuses to save without an id', async () => {
    mount({ 'registry.list': () => listOf([bare]) })
    await settle()
    fireEvent.click(screen.getByText('Bare'))
    await waitFor(() => expect(screen.getByDisplayValue('Bare')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('ID'), { target: { value: '   ' } })
    const save = screen.getByText('保存') as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it('reports a save that returns nothing usable', async () => {
    const view = mount({
      'registry.list': () => listOf([bare]),
      'registry.save': () => ({ human: bare, presetId: 'dh-bare' }),
    })
    await settle()
    fireEvent.click(screen.getByText('Bare'))
    await waitFor(() => expect(screen.getByDisplayValue('Bare')).toBeTruthy())
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(screen.getByText(/preset：dh-bare/)).toBeTruthy())
    expect(view.calls.some((entry) => entry.method === 'registry.save')).toBe(true)
  })
})
