// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { apply } = await import('../../src/client')

/** One catalog snapshot as the Workspace service holds it. */
const snapshot = (ids: string[], phase = 'ready') => ({ phase, ids, byId: {} })

/** The tree the Host reports: a chat-keyed PM and a requirement-keyed developer. */
const treeValue = {
  humans: [
    {
      humanId: 'pm-assistant',
      name: 'PM',
      order: 0,
      sessionKey: 'chat',
      requirements: [
        { conversation: 'direct:leader', sessions: [{ sessionId: 's-live' }] },
        { conversation: 'group:team', sessions: [{ sessionId: 's-group' }] },
        { conversation: 'direct:gone', sessions: [{ sessionId: 's-stale' }] },
      ],
    },
    {
      humanId: 'dev-assistant',
      name: '开发',
      order: 20,
      sessionKey: 'requirement',
      requirements: [
        // A directory with meta.json: the menu shows the requirement's name.
        { conversation: 'REQ-1', dir: '组织基线验证-20261102', name: '组织基线验证', sessions: [{ sessionId: 's-req' }] },
        // A legacy directory without meta.json: the thread name is the title.
        { conversation: 'REQ-LEGACY', sessions: [{ sessionId: 's-legacy' }] },
        { conversation: 'REQ-OLD', sessions: [{ sessionId: 's-req-stale' }] },
      ],
    },
  ],
}

/** The tree a four-role requirement reports: one thread, one Session per role. */
const fourRoleTree = {
  humans: [
    {
      humanId: 'lead-assistant',
      name: '负责人',
      order: 10,
      sessionKey: 'requirement',
      requirements: [{ conversation: 'REQ-7', dir: 'cas文档同步-20261103', name: 'cas文档同步', sessions: [{ sessionId: 's-lead' }] }],
    },
    {
      humanId: 'dev-assistant',
      name: '开发',
      order: 20,
      sessionKey: 'requirement',
      requirements: [{ conversation: 'REQ-7', dir: 'cas文档同步-20261103', name: 'cas文档同步', sessions: [{ sessionId: 's-dev' }] }],
    },
    {
      humanId: 'qa-assistant',
      name: '自测',
      order: 30,
      sessionKey: 'requirement',
      requirements: [{ conversation: 'REQ-7', dir: 'cas文档同步-20261103', name: 'cas文档同步', sessions: [{ sessionId: 's-qa' }] }],
    },
    {
      humanId: 'deploy-assistant',
      name: '部署',
      order: 40,
      sessionKey: 'requirement',
      requirements: [{ conversation: 'REQ-7', dir: 'cas文档同步-20261103', name: 'cas文档同步', sessions: [{ sessionId: 's-deploy' }] }],
    },
  ],
}

/** The tree after another role's Session is created: one more requirement row. */
const grownTree = {
  humans: [
    ...treeValue.humans,
    {
      humanId: 'qa-assistant',
      name: '自测',
      order: 30,
      sessionKey: 'requirement',
      requirements: [{ conversation: 'REQ-NEW', dir: '新需求-20261103', name: '新需求', sessions: [{ sessionId: 's-new' }] }],
    },
  ],
}

/**
 * A store shaped like `uiSession.sessionStatus`: a snapshot plus subscribers.
 *
 * `set` publishes a new snapshot, which is what the runtime does when a turn
 * starts or ends.
 */
function statusStore(initial: Record<string, { running?: boolean }>) {
  let snapshot = new Map(Object.entries(initial))
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next: Record<string, { running?: boolean }>) => {
      snapshot = new Map(Object.entries(next))
      for (const listener of listeners) listener()
    },
  }
}

beforeEach(() => {
  localStorage.setItem('dh.sidebar.view', 'tree')
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * Mount the sidebar column exactly as the slot system does.
 *
 * The catalog stub is what the tree filters against; `workspace: false` models a
 * host that has not registered the service yet.
 */
function mountTree({
  ids = ['s-live', 's-group', 's-req', 's-legacy'],
  phase = 'ready',
  workspace = true,
  tree = treeValue,
  sessionStatus,
  rows = {},
  listStore,
} = {}) {
  const registrations: Array<{ options: any; Component: any }> = []
  const openSession = vi.fn()
  // The catalog is either the fixed one, or a store the test drives itself.
  const list = listStore ?? {
    getSnapshot: () => ({ ...snapshot(ids, phase), byId: rows }),
    subscribe: () => () => {},
  }
  const uiWorkspace = workspace
    ? {
        openSession,
        selection: { getSnapshot: () => ({ sessionId: 's-live' }), subscribe: () => () => {} },
        sessions: { list },
      }
    : undefined
  const uiSession = sessionStatus ? { sessionStatus } : undefined
  // `tree` may be a function of the read's number, so a test can answer the
  // second read differently from the first.
  let reads = 0
  const rpc = vi.fn(async (method: string) => {
    if (method !== 'tree.read') return { ok: true, value: {} }
    const call = reads++
    return { ok: true, value: typeof tree === 'function' ? await tree(call) : tree }
  })
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    get: (name: string) => {
      if (name === 'uiWorkspace') return uiWorkspace
      if (name === 'uiSession') return uiSession
      return undefined
    },
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
  const reg = registrations.find((entry) => entry.options.name === 'sidebar.workspaces')!
  const rendered = render(React.createElement(reg.Component, reg.options.inject()))
  return { ...rendered, openSession, reg, rpc, reads: () => reads }
}

/**
 * A store shaped like `uiWorkspace.sessions.list`: a snapshot plus subscribers.
 *
 * `set` publishes a new catalog, which is what the Workspace does when a Session
 * is created or removed elsewhere.
 */
function catalogStore(initialIds: string[], phase = 'ready') {
  let current = { phase, ids: [...initialIds] }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => ({ ...snapshot(current.ids, current.phase), byId: {} }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (nextIds: string[], nextPhase = 'ready') => {
      current = { phase: nextPhase, ids: [...nextIds] }
      for (const listener of listeners) listener()
    },
    listeners: () => listeners.size,
  }
}

describe('the requirement tree', () => {
  it('lists a chat role flat, without personal or group headings', async () => {
    mountTree()
    await waitFor(() => expect(screen.getByText('PM')).toBeTruthy())
    expect(screen.queryByText('个人')).toBeNull()
    expect(screen.queryByText('群聊')).toBeNull()
    // A requirement's menu is titled by meta.json, not by the thread name.
    expect(screen.getByText('组织基线验证')).toBeTruthy()
    expect(screen.queryByText('REQ-1')).toBeNull()
    // Without meta.json the thread name is the fallback.
    expect(screen.getByText('REQ-LEGACY')).toBeTruthy()
    // The prefix is not part of the name the operator reads.
    expect(screen.getByText('leader')).toBeTruthy()
    expect(screen.getByText('team')).toBeTruthy()
  })

  it('drops a Session the Workspace catalog no longer lists', async () => {
    mountTree()
    await waitFor(() => expect(screen.getByText('leader')).toBeTruthy())
    expect(document.querySelector('[title="s-stale"]')).toBeNull()
    expect(document.querySelector('[title="s-req-stale"]')).toBeNull()
    // A live row stays, including the one under a requirement.
    expect(document.querySelector('[title="s-live"]')).toBeTruthy()
    expect(document.querySelector('[title="s-req"]')).toBeTruthy()
    expect(screen.queryByText('REQ-OLD')).toBeNull()
  })

  it('shows every row until the catalog is authoritative', async () => {
    mountTree({ phase: 'pending' })
    await waitFor(() => expect(screen.getByText('leader')).toBeTruthy())
    expect(document.querySelector('[title="s-stale"]')).toBeTruthy()
  })

  it('keeps every row when the Workspace service is absent', async () => {
    mountTree({ workspace: false })
    await waitFor(() => expect(screen.getByText('leader')).toBeTruthy())
    expect(document.querySelector('[title="s-stale"]')).toBeTruthy()
  })

  it('opens the Session behind a row', async () => {
    const view = mountTree()
    await waitFor(() => expect(screen.getByText('team')).toBeTruthy())
    fireEvent.click(screen.getByText('team'))
    expect(view.openSession).toHaveBeenCalledWith('s-group')
  })

  it('files every role of one requirement under one node', async () => {
    // One requirement is one thread, and every role is reached in it: four Sessions,
    // one folder. A role-suffixed conversation would make four folders instead.
    mountTree({
      tree: fourRoleTree,
      ids: ['s-lead', 's-dev', 's-qa', 's-deploy'],
    })
    await waitFor(() => expect(screen.getByText('cas文档同步')).toBeTruthy())
    expect(screen.getAllByText('cas文档同步')).toHaveLength(1)
    expect(document.querySelectorAll('.dh-tree-row')).toHaveLength(4)
    for (const id of ['s-lead', 's-dev', 's-qa', 's-deploy']) {
      expect(document.querySelector(`[title="${id}"]`)).toBeTruthy()
    }
  })

  it('marks a running Session with the native 16px spinner, and clears it when the turn ends', async () => {
    const status = statusStore({ 's-req': { running: true }, 's-live': { running: false } })
    mountTree({ sessionStatus: status })
    await waitFor(() => expect(screen.getByText('REQ-LEGACY')).toBeTruthy())
    const row = document.querySelector('[title="s-req"]')!
    const mark = row.querySelector('.dh-tree-running')
    expect(mark).toBeTruthy()
    expect(mark!.getAttribute('aria-label')).toBe('运行中')
    // The primitive's own ongoing spinner, at the native size.
    expect(row.querySelector('[data-state="ongoing"]')!.getAttribute('data-size')).toBe('16')
    // An idle Session carries no mark.
    expect(document.querySelector('[title="s-live"] [data-state="ongoing"]')).toBeNull()
    // The turn ends: the mark goes away without a reload.
    await act(async () => { status.set({ 's-req': { running: false } }) })
    expect(document.querySelector('[title="s-req"] [data-state="ongoing"]')).toBeNull()
  })

  it('reads the running mark from the Workspace catalog when no status store exists', async () => {
    mountTree({ rows: { 's-req': { running: true } } })
    await waitFor(() => expect(screen.getByText('REQ-LEGACY')).toBeTruthy())
    expect(document.querySelector('[title="s-req"] [data-state="ongoing"]')).toBeTruthy()
    expect(document.querySelector('[title="s-legacy"] [data-state="ongoing"]')).toBeNull()
  })
})

/**
 * The column is Host state, so a Session created or removed elsewhere only shows
 * after another whole read. Three things drive that read: the mount, a change in
 * the Workspace catalog, and a 30-second fallback timer.
 */
describe('the live refresh', () => {
  it('reads the tree again when the catalog gains a Session', async () => {
    const catalog = catalogStore(['s-live', 's-group', 's-req', 's-legacy'])
    const view = mountTree({ listStore: catalog, tree: (call: number) => (call === 0 ? treeValue : grownTree) })
    await waitFor(() => expect(screen.getByText('REQ-LEGACY')).toBeTruthy())
    expect(screen.queryByText('新需求')).toBeNull()
    await act(async () => { catalog.set(['s-live', 's-group', 's-req', 's-legacy', 's-new']) })
    await waitFor(() => expect(screen.getByText('新需求')).toBeTruthy())
    expect(view.reads()).toBe(2)
    expect(document.querySelector('[title="s-new"]')).toBeTruthy()
  })

  it('reads the tree again when the catalog loses a Session', async () => {
    const catalog = catalogStore(['s-live', 's-group', 's-req', 's-legacy'])
    const view = mountTree({ listStore: catalog })
    await waitFor(() => expect(screen.getByText('REQ-LEGACY')).toBeTruthy())
    expect(view.reads()).toBe(1)
    await act(async () => { catalog.set(['s-live', 's-group', 's-legacy']) })
    await waitFor(() => expect(view.reads()).toBe(2))
    expect(document.querySelector('[title="s-req"]')).toBeNull()
  })

  it('reads the tree again on the 30-second fallback timer', async () => {
    vi.useFakeTimers()
    // The new Session is already in the catalog: only the timer can bring its row.
    const view = mountTree({
      listStore: catalogStore(['s-live', 's-group', 's-req', 's-legacy', 's-new']),
      tree: (call: number) => (call === 0 ? treeValue : grownTree),
    })
    await act(async () => {})
    expect(view.reads()).toBe(1)
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(view.reads()).toBe(2)
    // The second answer lands a turn after the timer fires.
    await act(async () => {})
    expect(screen.getByText('新需求')).toBeTruthy()
  })

  it('does not read the tree when a publish carries the same ids', async () => {
    // A running mark is also a catalog publish. It redraws the rows; it is not a
    // reason to walk every mailbox.
    const catalog = catalogStore(['s-live', 's-group', 's-req', 's-legacy'])
    const view = mountTree({ listStore: catalog })
    await waitFor(() => expect(screen.getByText('REQ-LEGACY')).toBeTruthy())
    await act(async () => { catalog.set(['s-live', 's-group', 's-req', 's-legacy']) })
    expect(view.reads()).toBe(1)
  })

  it('stops reading after the column unmounts', async () => {
    vi.useFakeTimers()
    const catalog = catalogStore(['s-live', 's-group', 's-req', 's-legacy'])
    const view = mountTree({ listStore: catalog })
    await act(async () => {})
    expect(view.reads()).toBe(1)
    expect(catalog.listeners()).toBeGreaterThan(0)
    view.unmount()
    expect(catalog.listeners()).toBe(0)
    await act(async () => { vi.advanceTimersByTime(90_000) })
    expect(view.reads()).toBe(1)
  })

  it('keeps the rows on screen while a re-read is in flight', async () => {
    const catalog = catalogStore(['s-live', 's-group', 's-req', 's-legacy'])
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const view = mountTree({
      listStore: catalog,
      tree: async (call: number) => {
        if (call === 0) return treeValue
        await gate
        return grownTree
      },
    })
    await waitFor(() => expect(screen.getByText('REQ-LEGACY')).toBeTruthy())
    await act(async () => { catalog.set(['s-live', 's-group', 's-req', 's-legacy', 's-new']) })
    // The second read has not answered: the last tree stays, and no loading hint
    // takes its place.
    expect(screen.getByText('REQ-LEGACY')).toBeTruthy()
    expect(screen.queryByText('加载中…')).toBeNull()
    await act(async () => { release() })
    await waitFor(() => expect(screen.getByText('新需求')).toBeTruthy())
    expect(view.reads()).toBe(2)
  })

  it('keeps the last tree when a background re-read fails', async () => {
    const catalog = catalogStore(['s-live', 's-group', 's-req', 's-legacy'])
    let broken = false
    const mount = mountTree({
      listStore: catalog,
      tree: () => {
        if (broken) throw new Error('断线')
        return treeValue
      },
    })
    await waitFor(() => expect(screen.getByText('REQ-LEGACY')).toBeTruthy())
    broken = true
    await act(async () => { catalog.set(['s-live', 's-group', 's-req', 's-legacy', 's-new']) })
    await waitFor(() => expect(mount.reads()).toBe(2))
    expect(screen.getByText('REQ-LEGACY')).toBeTruthy()
    expect(screen.getByText('组织基线验证')).toBeTruthy()
    expect(screen.queryByText(/读取需求失败/)).toBeNull()
  })
})
