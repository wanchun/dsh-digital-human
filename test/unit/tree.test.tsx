// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

beforeEach(() => {
  localStorage.setItem('dh.sidebar.view', 'tree')
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

/**
 * Mount the sidebar column exactly as the slot system does.
 *
 * The catalog stub is what the tree filters against; `workspace: false` models a
 * host that has not registered the service yet.
 */
function mountTree({ ids = ['s-live', 's-group', 's-req', 's-legacy'], phase = 'ready', workspace = true } = {}) {
  const registrations: Array<{ options: any; Component: any }> = []
  const openSession = vi.fn()
  const list = {
    getSnapshot: () => snapshot(ids, phase),
    subscribe: () => () => {},
  }
  const uiWorkspace = workspace
    ? {
        openSession,
        selection: { getSnapshot: () => ({ sessionId: 's-live' }), subscribe: () => () => {} },
        sessions: { list },
      }
    : undefined
  const rpc = vi.fn(async (method: string) => ({ ok: true, value: method === 'tree.read' ? treeValue : {} }))
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    get: (name: string) => (name === 'uiWorkspace' ? uiWorkspace : undefined),
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
  return { ...rendered, openSession, reg }
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
})
