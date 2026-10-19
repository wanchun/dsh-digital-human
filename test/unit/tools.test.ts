import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildHumanTools, buildRegistryTool } from '../../src/lib/tools'

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dh-tools-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** The two records the tool surface talks about. */
const people: Record<string, any> = {
  pm: { id: 'pm', name: '研发PM助手', enabled: true, im: { botId: 'wecom_1', targetId: 'leader' } },
  dev: { id: 'dev', name: '开发助手', enabled: true, im: { botId: '', targetId: '' } },
  off: { id: 'off', name: '停用', enabled: false, im: { botId: '', targetId: '' } },
}

/**
 * The `digitalHumans` service surface the tools read, with every call recorded so a
 * tool's own argument handling is what the assertions measure.
 */
function serviceStub(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: any[] }> = []
  const record = (method: string, ...args: any[]) => { calls.push({ method, args }) }
  const service: any = {
    calls,
    store: { dir: (id: string) => join(home, 'humans', id) },
    require: async (id: string) => {
      record('require', id)
      if (!people[id]) throw new Error(`unknown digital human: ${JSON.stringify(id)}`)
      return people[id]
    },
    resolve: async (ref: string) => {
      record('resolve', ref)
      return people[ref] ?? Object.values(people).find((entry) => entry.name === ref)
    },
    list: async () => { record('list'); return Object.values(people) },
    send: async (id: string, options: any) => {
      record('send', id, options)
      return { sessionId: 'session-1', conversationId: options.conversationId ?? 'main', accepted: true }
    },
    status: async (id: string, conversationId: string) => {
      record('status', id, conversationId)
      return { exists: true, isGenerating: false }
    },
    messages: async (id: string, conversationId: string, limit: number) => {
      record('messages', id, conversationId, limit)
      return {
        conversationId: conversationId ?? 'main',
        items: [{ at: '2026-01-01T00:00:00Z', kind: 'inbound', from: 'pm', text: 'please review' }],
      }
    },
    stop: async (id: string, conversationId: string) => {
      record('stop', id, conversationId)
      return { stopped: true }
    },
    chat: {
      conversations: async (id: string) => { record('conversations', id); return ['main', 'REQ-1'] },
      addresses: async (id: string) => {
        record('addresses', id)
        return [
          { conversationId: 'main', sessionId: 'session-aaaa' },
          { conversationId: null, sessionId: 'session-bbbb' },
        ]
      },
    },
    ...overrides,
  }
  return service
}

/** The context the tools read, with an optional IM service. */
const ctxWith = (dshIm?: unknown) => ({ get: (name: string) => (name === 'dshIm' ? dshIm : undefined) })

const toolOf = (tools: any[], name: string) => tools.find((tool) => tool.name === name)

describe('the chat tools', () => {
  const build = (service: any, dshIm?: unknown) => buildHumanTools({ ctx: ctxWith(dshIm), service, humanId: 'pm' })

  it('offers the whole surface', () => {
    const names = build(serviceStub()).map((tool) => tool.name)
    expect(names).toEqual([
      'digital_human_send', 'digital_human_status', 'digital_human_stop', 'digital_human_messages',
      'digital_human_conversations', 'digital_human_list', 'notify_bot', 'list_bot_targets',
      'memory_status', 'memory_compact',
    ])
  })

  it('leaves the memory tools out when the record keeps no memory', () => {
    const names = buildHumanTools({ ctx: ctxWith(), service: serviceStub(), humanId: 'pm', memory: false })
      .map((tool) => tool.name)
    expect(names).not.toContain('memory_status')
    expect(names).not.toContain('memory_compact')
    expect(names).toContain('digital_human_send')
  })

  it('sends to a peer by name or id, and reports the conversation it used', async () => {
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    const result = await send.execute({ to: 'dev', message: 'do it', conversation_id: 'main' })
    expect(result).toMatchObject({ to: 'dev', conversationId: 'main', accepted: true, finished: false })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1]).toMatchObject({
      conversationId: 'main', message: 'do it', from: 'pm',
    })
    const byName = await send.execute({ to: '开发助手', message: 'x', conversation_id: 'main' })
    expect(byName.to).toBe('dev')
  })

  it('waits for a reply when asked, and reports the outcome', async () => {
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    const result = await send.execute({ to: 'dev', message: 'x', conversation_id: 'main', wait_seconds: 1 })
    expect(result.finished).toBe(true)
    expect(result.detail).toContain('turn finished')
  })

  it('reports a reply that is still running', async () => {
    const service = serviceStub({ status: async () => ({ exists: true, isGenerating: true }) })
    const send = toolOf(build(service), 'digital_human_send')
    const result = await send.execute({ to: 'dev', message: 'x', conversation_id: 'main', wait_seconds: 1 })
    expect(result.finished).toBe(false)
    expect(result.detail).toContain('not ready')
  })

  it('carries the caller Session when the Host supplies one', async () => {
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    await send.execute({ to: 'dev', message: 'x', conversation_id: 'main' }, { agent: { session: { header: { id: 'session-me-1' } } } })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1].fromSession).toBe('session-me-1')
  })

  it('omits the caller Session when the call carries none', async () => {
    // The Agent is optional on an execution, and a call from a nested dispatcher may
    // not have one — an absent id must not become the string "undefined".
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    for (const exec of [undefined, {}, { agent: {} }, { agent: { session: { header: {} } } }, { agent: { session: { header: { id: 7 } } } }]) {
      await send.execute({ to: 'dev', message: 'x', conversation_id: 'main' }, exec)
    }
    expect(service.calls.filter((entry) => entry.method === 'send')
      .every((entry) => entry.args[1].fromSession === undefined)).toBe(true)
  })

  it('passes a Session address through as the address', async () => {
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    await send.execute({ to: 'dev', message: 'x', session_id: 'session-them-1' })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1].sessionId).toBe('session-them-1')
  })

  it('ignores a Session address that is not a string', async () => {
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    await send.execute({ to: 'dev', message: 'x', conversation_id: 'main', session_id: 7 })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1].sessionId).toBeUndefined()
  })

  it('reports the Session it delivered into', async () => {
    const service = serviceStub()
    const detail = (await toolOf(build(service), 'digital_human_send')
      .execute({ to: 'dev', message: 'x', conversation_id: 'main' })).detail
    expect(detail).toContain('session-1')
  })

  it('refuses a send that names no address at all', async () => {
    // Omitting both would pour every subject into the one shared `main` thread, and
    // the split would be silent and permanent.
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    await expect(send.execute({ to: 'dev', message: 'x' })).rejects.toThrow(/conversation_id or session_id is required/)
    expect(service.calls.some((entry) => entry.method === 'send')).toBe(false)
  })

  it('still accepts an explicit "main", which is a choice rather than an omission', async () => {
    const service = serviceStub()
    await toolOf(build(service), 'digital_human_send').execute({ to: 'dev', message: 'x', conversation_id: 'main' })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1].conversationId).toBe('main')
  })

  it('accepts a Session address in place of the conversation', async () => {
    const service = serviceStub()
    await toolOf(build(service), 'digital_human_send').execute({ to: 'dev', message: 'x', session_id: 'session-them-1' })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1].sessionId).toBe('session-them-1')
  })

  it('refuses an unknown peer, a self-send and an empty target', async () => {
    const send = toolOf(build(serviceStub()), 'digital_human_send')
    await expect(send.execute({ to: 'nobody', message: 'x' })).rejects.toThrow(/unknown digital human/)
    await expect(send.execute({ to: 'pm', message: 'x' })).rejects.toThrow(/cannot send to itself/)
    await expect(send.execute({ to: '', message: 'x' })).rejects.toThrow(/target digital human is required/)
  })

  it('reads a conversation', async () => {
    const service = serviceStub()
    const messages = toolOf(build(service), 'digital_human_messages')
    const result = await messages.execute({ to: 'dev', conversation_id: 'REQ-1', limit: 5 })
    expect(result.detail).toContain('please review')
    expect(service.calls.find((entry) => entry.method === 'messages')!.args).toEqual(['dev', 'REQ-1', 5])
  })

  it('says when a conversation is empty, and clamps the limit', async () => {
    const service = serviceStub()
    service.messages = async (id: string, conversationId: string, limit: number) => {
      service.calls.push({ method: 'messages', args: [id, conversationId, limit] })
      return { conversationId: conversationId ?? 'main', items: [] }
    }
    const messages = toolOf(build(service), 'digital_human_messages')
    expect((await messages.execute({ to: 'dev' })).detail).toContain('No messages')
    await messages.execute({ to: 'dev', limit: 9999 })
    expect(service.calls.at(-1)!.args[2]).toBe(200)
    await messages.execute({ to: 'dev', limit: -3 })
    expect(service.calls.at(-1)!.args[2]).toBe(1)
  })

  it('reports status and stops a turn', async () => {
    const service = serviceStub()
    const status = toolOf(build(service), 'digital_human_status')
    expect((await status.execute({ to: 'dev' })).detail).toContain('idle')
    const stop = toolOf(build(service), 'digital_human_stop')
    expect((await stop.execute({ to: 'dev' })).detail).toContain('Stopped')
  })

  it('reports a peer that is working', async () => {
    const service = serviceStub({ status: async () => ({ exists: true, isGenerating: true }) })
    expect((await toolOf(build(service), 'digital_human_status').execute({ to: 'dev' })).detail).toContain('working')
  })

  it('lists both address forms it already shares with a peer', async () => {
    const service = serviceStub()
    const conversations = toolOf(build(service), 'digital_human_conversations')
    const result = await conversations.execute({ to: 'dev' })
    // A conversation name and a bare Session id are both addresses, and the caller
    // must be able to reuse either rather than invent one.
    expect(result.detail).toContain('main → session-aaaa')
    expect(result.detail).toContain('(addressed by Session) session-bbbb')
  })

  it('says when there is no conversation yet', async () => {
    const service = serviceStub({ chat: { addresses: async () => [] } })
    expect((await toolOf(build(service), 'digital_human_conversations').execute({ to: 'dev' })).detail)
      .toContain('No conversation')
  })

  it('lists the roster and marks the caller', async () => {
    const detail = (await toolOf(build(serviceStub()), 'digital_human_list').execute({})).detail
    expect(detail).toContain('pm — 研发PM助手 (you, bot wecom_1, target leader)')
    expect(detail).toContain('disabled')
  })
})

describe('notify_bot', () => {
  const build = (service: any, dshIm?: unknown) => buildHumanTools({ ctx: ctxWith(dshIm), service, humanId: 'pm' })

  it('sends through the bound bot to the configured target', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const notify = toolOf(build(serviceStub(), { send, listTargets: async () => [] }), 'notify_bot')
    const result = await notify.execute({ message: 'hello' })
    expect(result).toMatchObject({ botId: 'wecom_1', targetId: 'leader' })
    expect(send).toHaveBeenCalledWith('wecom_1', 'leader', 'hello', { format: 'plain' })
  })

  it('honours an explicit bot, target and format', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const notify = toolOf(
      build(serviceStub(), { send, listTargets: async () => [{ targetId: 'group-1' }] }),
      'notify_bot',
    )
    await notify.execute({ message: 'hi', bot_id: 'wecom_9', to: 'group-1', format: 'markdown' })
    expect(send).toHaveBeenCalledWith('wecom_9', 'group-1', 'hi', { format: 'markdown' })
  })

  it('names the targets a bot accepts when a send is refused', async () => {
    // A bare "Unknown target" leaves the model no way to learn the right one, and a
    // chat id is not a target: the channel addresses targets by the names it reports.
    const im = {
      send: async () => { throw new Error('Unknown target') },
      listTargets: async () => [{ targetId: 'rtcpc-result-group', name: '需求修复群', kind: 'group' }],
    }
    const notify = toolOf(build(serviceStub(), im), 'notify_bot')
    await expect(notify.execute({ message: 'x', to: 'wrhR_chatid' }))
      .rejects.toThrow(/Unknown target.*rtcpc-result-group \(需求修复群\)/)
  })

  it('explains an empty target list when a send is refused', async () => {
    const im = {
      send: async () => { throw new Error('Unknown target') },
      listTargets: async () => [],
    }
    const notify = toolOf(build(serviceStub(), im), 'notify_bot')
    await expect(notify.execute({ message: 'x', to: 'x' })).rejects.toThrow(/reports no targets yet/)
  })

  it('still explains when the target list cannot be read', async () => {
    const im = {
      send: async () => { throw new Error('Unknown target') },
      listTargets: async () => { throw new Error('im is down') },
    }
    const notify = toolOf(build(serviceStub(), im), 'notify_bot')
    await expect(notify.execute({ message: 'x', to: 'x' })).rejects.toThrow(/reports no targets yet/)
  })

  it('sends to a raw chat id the bot has never saved as a target', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const notify = toolOf(build(serviceStub(), { send, listTargets: async () => [] }), 'notify_bot')
    const result = await notify.execute({ message: 'hi', to: 'wohR_chat', kind: 'user' })
    expect(send).toHaveBeenCalledWith(
      'wecom_1',
      { kind: 'user', route: { chatId: 'wohR_chat' } },
      'hi',
      { format: 'plain' },
    )
    expect(result).toMatchObject({ botId: 'wecom_1', targetId: 'wohR_chat' })
  })

  it('refuses when IM is absent, when nothing is bound and when the text is empty', async () => {
    const absent = toolOf(build(serviceStub(), undefined), 'notify_bot')
    await expect(absent.execute({ message: 'x' })).rejects.toThrow(/IM plugin is not active/)
    const im = { send: vi.fn(), listTargets: async () => [] }
    const unbound = buildHumanTools({ ctx: ctxWith(im), service: serviceStub(), humanId: 'dev' })
    await expect(toolOf(unbound, 'notify_bot').execute({ message: 'x' })).rejects.toThrow(/no IM bot is bound/)
    // `dev` has neither a bot nor a target, so an explicit bot leaves no target.
    const noTarget = buildHumanTools({ ctx: ctxWith(im), service: serviceStub(), humanId: 'dev' })
    await expect(toolOf(noTarget, 'notify_bot').execute({ message: 'x', bot_id: 'b' }))
      .rejects.toThrow(/no IM target is configured/)
    const notify = toolOf(build(serviceStub(), im), 'notify_bot')
    await expect(notify.execute({ message: '   ' })).rejects.toThrow(/must not be empty/)
  })
})

describe('list_bot_targets', () => {
  const build = (service: any, dshIm?: unknown) => buildHumanTools({ ctx: ctxWith(dshIm), service, humanId: 'pm' })

  it('lists what the bot can reach', async () => {
    const im = { listTargets: async () => [{ targetId: 't1', name: 'Group', kind: 'group' }] }
    const detail = (await toolOf(build(serviceStub(), im), 'list_bot_targets').execute({})).detail
    expect(detail).toContain('t1 — Group (group)')
  })

  it('names a target with no label', async () => {
    const im = { listTargets: async () => [{ targetId: 't1' }] }
    expect((await toolOf(build(serviceStub(), im), 'list_bot_targets').execute({})).detail).toContain('t1 — t1 (unknown)')
  })

  it('explains an empty list, and says how a target comes to exist', async () => {
    const im = { listTargets: async () => [] }
    const detail = (await toolOf(build(serviceStub(), im), 'list_bot_targets').execute({})).detail
    expect(detail).toContain('reports no targets yet')
    expect(detail).toContain('never to a chat id')
  })

  it('refuses without IM, without a bot, and with no targets array', async () => {
    await expect(toolOf(build(serviceStub(), undefined), 'list_bot_targets').execute({}))
      .rejects.toThrow(/IM plugin is not active/)
    const im = { listTargets: async () => [] }
    const unbound = buildHumanTools({ ctx: ctxWith(im), service: serviceStub(), humanId: 'dev' })
    await expect(toolOf(unbound, 'list_bot_targets').execute({})).rejects.toThrow(/no IM bot is bound/)
    const broken = { listTargets: async () => 'nope' }
    expect((await toolOf(build(serviceStub(), broken), 'list_bot_targets').execute({})).detail)
      .toContain('reports no targets yet')
  })
})

describe('the memory tools', () => {
  const build = (service: any) => buildHumanTools({ ctx: ctxWith(), service, humanId: 'pm' })

  it('reports structure before anything exists', async () => {
    const detail = (await toolOf(build(serviceStub()), 'memory_status').execute({})).detail
    expect(detail).toContain('no file yet')
  })

  it('reports nothing to archive, then archives', async () => {
    const service = serviceStub()
    const compact = toolOf(build(service), 'memory_compact')
    expect((await compact.execute({})).detail).toContain('no memory.md')
    // The status tool reads without creating, so a file has to exist first.
    const { ensureMemory, memoryPaths } = await import('../../src/lib/memory')
    ensureMemory(memoryPaths(service.store, 'pm').file)
    expect((await compact.execute({})).detail).toContain('Archived to')
  })
})

describe('the registry tool', () => {
  const build = (service: any) => buildRegistryTool({ service })



  it('lists, shows, creates, updates and removes', async () => {
    const service = serviceStub({
      upsert: async (patch: any) => ({ ...patch, id: patch.id, name: patch.name ?? 'x' }),
      remove: async (id: string) => id === 'dev',
    })
    const tool = build(service)
    expect((await tool.execute({ action: 'list' })).detail).toContain('pm')
    expect((await tool.execute({ action: 'show', id: 'dev' })).detail).toContain('dev')
    expect((await tool.execute({ action: 'create', id: 'new', name: 'New' })).detail).toContain('Created')
    expect((await tool.execute({ action: 'update', id: 'new', name: 'New2' })).detail).toContain('Updated')
    expect((await tool.execute({ action: 'remove', id: 'dev' })).detail).toContain('Removed')
  })

  it('parses the comma-separated lists', async () => {
    const seen: any[] = []
    const service = serviceStub({ upsert: async (patch: any) => { seen.push(patch); return patch } })
    await build(service).execute({ action: 'create', id: 'x', peers: 'dev, pm', skills: 'a,b' })
    expect(seen[0].peers).toEqual(['dev', 'pm'])
    expect(seen[0].skills).toEqual(['a', 'b'])
  })

  it('maps the optional fields, including the IM pair', async () => {
    const seen: any[] = []
    const service = serviceStub({ upsert: async (patch: any) => { seen.push(patch); return patch } })
    await build(service).execute({
      action: 'update', id: 'x', name: 'N', description: 'D', system_prompt: 'S', workspace: '/w',
      bot_id: 'wecom_1', target_id: 't', enabled: false, memory: false,
    })
    expect(seen[0]).toMatchObject({
      name: 'N', description: 'D', systemPrompt: 'S', workspace: '/w',
      im: { botId: 'wecom_1', targetId: 't' }, enabled: false, memory: false,
    })
  })

  it('keeps the IM pair out when neither half was given', async () => {
    const seen: any[] = []
    const service = serviceStub({ upsert: async (patch: any) => { seen.push(patch); return patch } })
    await build(service).execute({ action: 'update', id: 'x', name: 'N' })
    expect(seen[0].im).toBeUndefined()
  })

  it('refuses an unsupported action and a missing id', async () => {
    const tool = build(serviceStub())
    await expect(tool.execute({ action: 'explode' })).rejects.toThrow(/unsupported action/)
    await expect(tool.execute({ action: 'create' })).rejects.toThrow(/id is required/)
    await expect(tool.execute({})).rejects.toThrow(/unsupported action/)
  })

  it('says when a record is not there', async () => {
    const service = serviceStub({ require: async (id: string) => { if (id !== 'pm') throw new Error('unknown digital human: "x"') } })
    const tool = build(service)
    await expect(tool.execute({ action: 'show', id: 'x' })).rejects.toThrow(/unknown digital human/)
  })

  it('refuses to remove something that is not there', async () => {
    const service = serviceStub({ remove: async () => false })
    await expect(build(service).execute({ action: 'remove', id: 'gone' })).rejects.toThrow(/unknown digital human/)
    await expect(build(service).execute({ action: 'remove' })).rejects.toThrow(/id is required/)
  })
})
