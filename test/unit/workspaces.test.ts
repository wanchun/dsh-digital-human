import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_WORKSPACE_TITLE,
  defaultWorkspacePath,
  ensureDefaultWorkspace,
  listWorkspaces,
  readBotMeta,
} from '../../src/lib/workspaces'

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dh-ws-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** A context whose `get` answers from a fixed map. */
const ctxWith = (services: Record<string, unknown>) => ({ get: (name: string) => services[name] })

/** A workspace controller stub whose `follow` emits one baseline frame. */
function controllerStub(items: unknown[], overrides: Record<string, unknown> = {}) {
  const created: unknown[] = []
  return {
    created,
    follow: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'baseline', value: { items } }
        yield { type: 'update', value: { items: [] } }
      },
    }),
    create: async (options: unknown) => {
      created.push(options)
      return { workspace: { workspaceId: 'ws-new', path: (options as { path: string }).path, title: '' } }
    },
    rename: async (options: unknown) => ({ workspace: { workspaceId: 'ws-new', title: DEFAULT_WORKSPACE_TITLE, ...(options as object) } }),
    ...overrides,
  }
}

describe('defaultWorkspacePath', () => {
  it('nests the working directory under the registry root', () => {
    expect(defaultWorkspacePath('/home/dh')).toBe('/home/dh/workspace')
  })
})

describe('listWorkspaces', () => {
  it('reads the baseline frame and stops', async () => {
    const items = [{ workspaceId: 'a', path: '/a', title: 'A' }]
    expect(await listWorkspaces(ctxWith({ workspaceController: controllerStub(items) }))).toEqual(items)
  })

  it('is empty without a controller, or without `follow`', async () => {
    expect(await listWorkspaces(ctxWith({}))).toEqual([])
    expect(await listWorkspaces(ctxWith({ workspaceController: {} }))).toEqual([])
    expect(await listWorkspaces({ get: () => undefined })).toEqual([])
  })

  it('is empty when the baseline carries no items', async () => {
    const controller = {
      follow: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'baseline', value: {} } } }),
    }
    expect(await listWorkspaces(ctxWith({ workspaceController: controller }))).toEqual([])
  })

  it('is empty when the stream ends without a baseline', async () => {
    const controller = {
      follow: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'update', value: { items: [1] } } } }),
    }
    expect(await listWorkspaces(ctxWith({ workspaceController: controller }))).toEqual([])
  })

  it('survives a stream that throws', async () => {
    const controller = {
      follow: () => ({ async *[Symbol.asyncIterator]() { throw new Error('gone') } }),
    }
    expect(await listWorkspaces(ctxWith({ workspaceController: controller }))).toEqual([])
  })
})

describe('ensureDefaultWorkspace', () => {
  it('returns the existing one rather than creating a second', async () => {
    const controller = controllerStub([{ workspaceId: 'ws-1', path: '/x', title: DEFAULT_WORKSPACE_TITLE }])
    const found = await ensureDefaultWorkspace(ctxWith({ workspaceController: controller }), { home })
    expect(found?.workspaceId).toBe('ws-1')
    expect(controller.created).toEqual([])
  })

  it('creates and renames it on first use', async () => {
    const controller = controllerStub([])
    const workspace = await ensureDefaultWorkspace(ctxWith({ workspaceController: controller }), { home })
    expect(controller.created).toEqual([{ path: defaultWorkspacePath(home) }])
    expect(workspace?.title).toBe(DEFAULT_WORKSPACE_TITLE)
  })

  it('keeps a title the controller already chose', async () => {
    const controller = controllerStub([], {
      create: async () => ({ workspace: { workspaceId: 'w', path: '/x', title: DEFAULT_WORKSPACE_TITLE } }),
    })
    expect((await ensureDefaultWorkspace(ctxWith({ workspaceController: controller }), { home }))?.workspaceId).toBe('w')
  })

  it('accepts a controller that cannot rename', async () => {
    const controller = controllerStub([], {
      create: async () => ({ workspace: { workspaceId: 'w', path: '/x', title: 'other' } }),
      rename: undefined,
    })
    expect((await ensureDefaultWorkspace(ctxWith({ workspaceController: controller }), { home }))?.workspaceId).toBe('w')
  })

  it('reports an absent controller and a refused create without throwing', async () => {
    expect(await ensureDefaultWorkspace(ctxWith({}), { home })).toBeUndefined()
    const log = vi.fn()
    const refusing = controllerStub([], { create: async () => { throw new Error('read-only') } })
    expect(await ensureDefaultWorkspace(ctxWith({ workspaceController: refusing }), { home, log })).toBeUndefined()
    expect(String(log.mock.calls[0][0])).toContain('unavailable')
  })

  it('reports a create that returns nothing usable', async () => {
    const empty = controllerStub([], { create: async () => ({}) })
    expect(await ensureDefaultWorkspace(ctxWith({ workspaceController: empty }), { home })).toBeUndefined()
  })
})

describe('readBotMeta', () => {
  it('reads the aliases and the workspaces', async () => {
    const dir = join(home, 'integrations', 'dsh-wecom')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({
      version: 2, aliases: { wecom_1: '研发PM' }, workspaces: { wecom_1: '/w' },
    }))
    expect(await readBotMeta(home)).toEqual({ aliases: { wecom_1: '研发PM' }, workspaces: { wecom_1: '/w' } })
  })

  it('is empty when the integration has not written its file', async () => {
    expect(await readBotMeta(home)).toEqual({ aliases: {}, workspaces: {} })
  })

  it('is empty when the file is malformed', async () => {
    const dir = join(home, 'integrations', 'dsh-wecom')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'workspaces.json'), '{ not json')
    expect(await readBotMeta(home)).toEqual({ aliases: {}, workspaces: {} })
  })

  it('ignores a field that is not a map', async () => {
    const dir = join(home, 'integrations', 'dsh-wecom')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({ aliases: 'nope', workspaces: [] }))
    expect(await readBotMeta(home)).toEqual({ aliases: {}, workspaces: {} })
  })
})
