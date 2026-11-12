import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildHumanTools, buildRegistryTool } from '../../src/lib/tools'

let home = ''

/** The requirement every send names, and the directory that backs it. */
const REQ = 'REQ-1'
const REQ_NAME = '组织基线验证'
let requirementDir = ''

/**
 * The receipt request a dispatch ends with.
 *
 * The tool fills the requirement's thread name and the node of the call; a call that
 * names no node keeps the placeholder. Only `expect_receipt: true` adds the line.
 */
const receipt = (thread = REQ, node = '<节点名>') =>
  `—— 完成后请用 digital_human_send 回执给我：requirement=${thread}，node=${node}。写在你自己的会话里我收不到。`

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dh-tools-'))
  // A requirement exists before a send may name it: the tools refuse a name they
  // cannot resolve, so the fixture is the same fact every call reads.
  requirementDir = join(home, 'workspace', 'reqs', REQ + '-20260101')
  mkdirSync(requirementDir, { recursive: true })
  writeFileSync(join(requirementDir, 'meta.json'), JSON.stringify({ thread: REQ, name: REQ_NAME }))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** The two records the tool surface talks about. */
const people: Record<string, any> = {
  pm: { id: 'pm', name: '研发PM助手', enabled: true, peers: ['dev', 'front'], im: { botId: 'wecom_1', targetId: 'leader' } },
  dev: { id: 'dev', name: '开发助手', enabled: true, im: { botId: '', targetId: '' } },
  // A front-desk record: it serves the person who filed the requirement, so its
  // address is that person's chat and never a thread name.
  front: { id: 'front', name: '需求前台', enabled: true, sessionKey: 'chat', im: { botId: 'wecom_1', targetId: '' } },
  off: { id: 'off', name: '停用', enabled: false, im: { botId: '', targetId: '' } },
}

/**
 * Every key a value carries that its own output schema does not declare.
 *
 * The Host validates a tool result against the schema it was registered with, so a
 * field the value carries but the schema omits fails the call at runtime — exactly
 * the shape a test can see and a type cannot.
 */
function undeclaredKeys(schema: any, value: any, path = 'value'): string[] {
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => undeclaredKeys(schema?.items, item, `${path}[${index}]`))
  }
  const properties = schema?.properties
  if (!properties) return []
  const found: string[] = []
  for (const [key, entry] of Object.entries(value)) {
    if (!(key in properties)) {
      found.push(`${path}.${key}`)
      continue
    }
    found.push(...undeclaredKeys(properties[key], entry, `${path}.${key}`))
  }
  return found
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
    store: { home, dir: (id: string) => join(home, 'humans', id) },
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
      return {
        sessionId: options.sessionId ?? 'session-1',
        conversationId: options.conversationId ?? 'main',
        accepted: true,
      }
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
    // The transport's edge lookup. Undefined by default: no thread has been used, so
    // a call that gives no address still has to open one.
    threadTarget: async (id: string, options: any) => {
      record('threadTarget', id, options)
      return undefined
    },
    // The trigger-chat lookup a chat-keyed peer needs. Undefined by default: no
    // Session has been seen for the chat, so a dispatch to one must refuse.
    chatTarget: async (id: string, chatId: string) => {
      record('chatTarget', id, chatId)
      return undefined
    },
    noteEdge: async (id: string, edge: any) => { record('noteEdge', id, edge) },
    // The work-item ledger. Empty by default: a record with no handed-over work has
    // nothing for status to report.
    tasks: async (id: string, conversationId: string) => {
      record('tasks', id, conversationId)
      return []
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

/** Register one delivery-target alias in the bridge registry under this home. */
function aliasFor(botId: string, alias: string, chatId: string) {
  const file = join(home, '..', 'integrations', 'dsh-wecom', 'workspaces.json')
  let d: any = {}
  try { d = JSON.parse(readFileSync(file, 'utf8')) } catch { d = {} }
  d.deliveryTargets = d.deliveryTargets ?? {}
  d.deliveryTargets[botId] = d.deliveryTargets[botId] ?? {}
  d.deliveryTargets[botId][alias] = { name: alias, kind: 'user', route: { chatId } }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(d))
}

const toolOf = (tools: any[], name: string) => tools.find((tool) => tool.name === name)

describe('the chat tools', () => {
  const build = (service: any, dshIm?: unknown) => buildHumanTools({ ctx: ctxWith(dshIm), service, humanId: 'pm' })

  it('offers the whole surface', () => {
    const names = build(serviceStub()).map((tool) => tool.name)
    expect(names).toEqual([
      'digital_human_send', 'digital_human_status', 'digital_human_stop', 'digital_human_messages',
      'digital_human_conversations', 'digital_human_list', 'digital_human_usage', 'notify_bot', 'list_bot_targets',
      'set_session_title', 'memory_status', 'memory_compact', 'digital_human_requirement_create',
      'digital_human_requirement_read', 'digital_human_requirement_update', 'digital_human_requirement_attach',
      'digital_human_requirement_archive', 'digital_human_requirement_restore',
    ])
  })

  it('leaves the IM tools out when the record has no bot', () => {
    // A record with no bot has no outbound channel: offering notify_bot would only
    // ever fail, and its persona would keep trying to use it.
    const names = buildHumanTools({ ctx: ctxWith(), service: serviceStub(), humanId: 'dev', im: false })
      .map((tool) => tool.name)
    expect(names).not.toContain('notify_bot')
    expect(names).not.toContain('list_bot_targets')
    // Naming a Session does not need a bot, so this tool stays.
    expect(names).toContain('set_session_title')
    expect(names).toContain('digital_human_send')
  })

  it('leaves the archive tools out when the record may not archive', () => {
    // Archiving is the PM's action. A lead's link stops at the test environment, so
    // offering it the tools would invite an archive nothing asked for.
    const names = buildHumanTools({ ctx: ctxWith(), service: serviceStub(), humanId: 'dev', canArchive: false })
      .map((tool) => tool.name)
    expect(names).not.toContain('digital_human_requirement_archive')
    expect(names).not.toContain('digital_human_requirement_restore')
    // Reading and recording progress stay: only the archive pair is withheld.
    expect(names).toContain('digital_human_requirement_read')
    expect(names).toContain('digital_human_requirement_update')
  })

  it('states the one trigger an archive needs', () => {
    // The chain ends at the test environment, so nothing in it may justify an
    // archive by itself: only a person's word does.
    const archive = toolOf(build(serviceStub()), 'digital_human_requirement_archive')
    expect(archive.description).toContain('Call it only when the person says the requirement is live or may be archived')
    const restore = toolOf(build(serviceStub()), 'digital_human_requirement_restore')
    expect(restore.description).toContain('asks to change something based on an archived requirement')
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
    const result = await send.execute({ to: 'dev', message: 'do it', requirement: REQ, expect_receipt: true })
    expect(result).toMatchObject({ to: 'dev', conversationId: REQ, accepted: true, finished: false })
    const delivered = service.calls.find((entry) => entry.method === 'send')!.args[1]
    // The requirement's thread is the address: every role is reached there.
    expect(delivered).toMatchObject({ conversationId: REQ, from: 'pm' })
    // The requirement directory rides ahead of the body, so the peer works inside it.
    expect(delivered.message).toBe(`需求目录：${requirementDir}\n\ndo it\n\n${receipt()}`)
    const byName = await send.execute({ to: '开发助手', message: 'x', requirement: REQ })
    expect(byName.to).toBe('dev')
  })

  it('steers by default and queues only when asked', async () => {
    // Steer is the default: the peer's news reaches the turn in progress at its next
    // step. "queue" is the explicit choice to wait for that turn to end.
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    await send.execute({ to: 'dev', message: 'a', requirement: REQ })
    await send.execute({ to: 'dev', message: 'b', requirement: REQ, delivery: 'queue' })
    await send.execute({ to: 'dev', message: 'c', requirement: REQ, delivery: 'steer' })
    expect(service.calls.filter((entry) => entry.method === 'send')
      .map((entry) => entry.args[1].deliveryMode)).toEqual(['steer', 'queue', 'steer'])
  })

  it('says steer cannot break into a long tool call', async () => {
    // The model has to know the limit: a wrong direction needs a stop, not a steer.
    const send = toolOf(build(serviceStub()), 'digital_human_send')
    const description = send.parameters.properties.delivery.description
    expect(description).toContain('does not interrupt a long tool call')
    expect(description).toContain('digital_human_stop first')
  })

  it('refuses a send that names no requirement, delivering nothing', async () => {
    // A peer that gets no requirement directory would file the work wherever its
    // workspace happens to be; the refusal is the contract, not a fallback.
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    await expect(send.execute({ to: 'dev', message: 'x', conversation_id: 'main' }))
      .rejects.toThrow(/requires a requirement.*派单必须带需求/)
    expect(service.calls.some((entry) => entry.method === 'send')).toBe(false)
  })

  it('refuses a requirement it cannot resolve instead of guessing one', async () => {
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    await expect(send.execute({ to: 'dev', message: 'x', conversation_id: 'main', requirement: 'ghost' }))
      .rejects.toThrow(/unknown requirement: "ghost"/)
    expect(service.calls.some((entry) => entry.method === 'send')).toBe(false)
  })

  it('resolves a requirement by directory name as well as by thread name', async () => {
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    await send.execute({
      to: 'dev', message: 'x', requirement: REQ + '-20260101', expect_receipt: true,
    })
    // The receipt names the thread, even when the call named the directory.
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1].message)
      .toBe(`需求目录：${requirementDir}\n\nx\n\n${receipt()}`)
  })

  it('writes task, node, facts and context after the requirement path, in a fixed order', async () => {
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    await send.execute({
      to: 'dev',
      message: '请处理',
      requirement: REQ,
      task_id: 'w-01',
      node: '开发',
      // Deliberately out of order: the head must not depend on key order.
      facts: {
        version: '1.16.0',
        subsystem: 'RCS-CSA',
        docs: ['/spec.md', '/issue.md'],
        environment: 'M1',
        branch: 'feature/x',
        repo: '/repo',
      },
      context: '开发完成；上一步结论见 nodes/dev.md',
      expect_receipt: true,
    })
    const delivered = service.calls.find((entry) => entry.method === 'send')!.args[1]
    expect(delivered.message).toBe([
      `需求目录：${requirementDir}`,
      '工作项：w-01',
      '节点：开发',
      '事实：',
      '- 子系统：RCS-CSA',
      '- 版本：1.16.0',
      '- 分支：feature/x',
      '- 环境：M1',
      '- 仓库：/repo',
      '- 文档：/spec.md、/issue.md',
      '上下文：开发完成；上一步结论见 nodes/dev.md',
      '',
      '请处理',
      '',
      receipt(REQ, '开发'),
    ].join('\n'))
  })

  it('sends a structured dispatch with no body', async () => {
    const service = serviceStub()
    await toolOf(build(service), 'digital_human_send').execute({
      to: 'dev', requirement: REQ,
      facts: { subsystem: 'RCS-CSA' },
      context: '已接单；上一步结论见 nodes/intake.md',
      expect_receipt: true,
    })
    const delivered = service.calls.find((entry) => entry.method === 'send')!.args[1]
    expect(delivered.message).toBe([
      `需求目录：${requirementDir}`,
      '事实：',
      '- 子系统：RCS-CSA',
      '上下文：已接单；上一步结论见 nodes/intake.md',
      '',
      receipt(),
    ].join('\n'))
  })

  it('accepts facts as one line when the caller has no structure to give', async () => {
    const service = serviceStub()
    await toolOf(build(service), 'digital_human_send').execute({
      to: 'dev', message: 'x', requirement: REQ,
      facts: '子系统 RCS-CSA；版本 1.16.0',
      expect_receipt: true,
    })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1].message)
      .toBe(`需求目录：${requirementDir}\n事实：子系统 RCS-CSA；版本 1.16.0\n\nx\n\n${receipt()}`)
  })

  it('refuses a dispatch that carries steps, commands or cautions', async () => {
    // The executor's playbook owns the procedure. A payload that writes it down
    // would take the decision away, so the contract rejects the call instead of
    // letting the two descriptions drift.
    for (const [field, label] of [['steps', '步骤列表'], ['commands', '命令'], ['cautions', '注意事项']]) {
      const service = serviceStub()
      const send = toolOf(build(service), 'digital_human_send')
      await expect(send.execute({
        to: 'dev', message: 'x', requirement: REQ,
        [field]: ['do this', 'then that'],
      })).rejects.toThrow(new RegExp(`refuses ${field}（${label}）：派单只传事实`))
      expect(service.calls.some((entry) => entry.method === 'send')).toBe(false)
    }
  })

  it('refuses the aliases of the forbidden dispatch fields too', async () => {
    for (const field of ['step_list', 'instructions', 'precautions', 'command']) {
      const service = serviceStub()
      await expect(toolOf(build(service), 'digital_human_send').execute({
        to: 'dev', message: 'x', requirement: REQ, [field]: 'x',
      })).rejects.toThrow(/派单只传事实，不传做法/)
      expect(service.calls.some((entry) => entry.method === 'send')).toBe(false)
    }
  })

  it('ignores an empty forbidden field instead of refusing the call', async () => {
    // An empty list is no instruction at all; refusing it would make a caller
    // rewrite the payload for no gain.
    const service = serviceStub()
    await toolOf(build(service), 'digital_human_send').execute({
      to: 'dev', message: 'x', requirement: REQ, steps: [], expect_receipt: true,
    })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1].message)
      .toBe(`需求目录：${requirementDir}\n\nx\n\n${receipt()}`)
  })

  it('ends a dispatch with one fixed receipt request when asked to', async () => {
    // The caller decides; the line itself is fixed. It cannot depend on a persona
    // remembering it: the dispatch carries the two values the answer has to name.
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    await send.execute({ to: 'dev', message: 'x', requirement: REQ, node: '开发', expect_receipt: true })
    const message = service.calls.find((entry) => entry.method === 'send')!.args[1].message
    const lines = message.split('\n')
    expect(lines[lines.length - 1]).toBe(receipt(REQ, '开发'))
    expect(message.endsWith(`\n\n${receipt(REQ, '开发')}`)).toBe(true)
  })

  it('keeps the receipt placeholders when the dispatch names no node', async () => {
    // A node is the executor's call, so the request must still go out without one.
    const service = serviceStub()
    await toolOf(build(service), 'digital_human_send')
      .execute({ to: 'dev', message: 'x', requirement: REQ, expect_receipt: true })
    const message = service.calls.find((entry) => entry.method === 'send')!.args[1].message
    expect(message).toContain('requirement=REQ-1，node=<节点名>。')
  })

  it('adds no receipt request when the call omits expect_receipt', async () => {
    // The flag defaults to false: a message goes out as written.
    const service = serviceStub()
    await toolOf(build(service), 'digital_human_send').execute({
      to: 'dev', message: 'x', requirement: REQ, node: '开发',
    })
    const message = service.calls.find((entry) => entry.method === 'send')!.args[1].message
    expect(message).not.toContain('完成后请用 digital_human_send 回执给我')
    expect(message).toBe(`需求目录：${requirementDir}\n节点：开发\n\nx`)
  })

  it('adds no receipt request on a new handover', async () => {
    // `mode` does not imply the flag: only `expect_receipt` decides.
    const service = serviceStub()
    await toolOf(build(service), 'digital_human_send').execute({
      to: 'dev', message: 'x', mode: 'new', requirement: REQ, node: '自测',
    })
    const message = service.calls.find((entry) => entry.method === 'send')!.args[1].message
    expect(message).not.toContain('回执给我')
    expect(message).toBe(`需求目录：${requirementDir}\n节点：自测\n\nx`)
  })

  it('documents the flag as the only switch for the receipt request', () => {
    const send = toolOf(build(serviceStub()), 'digital_human_send')
    expect(send.description).toContain('expect_receipt')
    expect(send.parameters.properties.expect_receipt.type).toBe('boolean')
    expect(send.parameters.properties.expect_receipt.description).toContain('Omit it for a receipt')
  })

  it('adds no receipt request to a receipt', async () => {
    // A receipt answers the Session that asked. Asking for a receipt there too would
    // let two peers ask each other forever, so the caller omits the flag.
    const service = serviceStub()
    await toolOf(build(service), 'digital_human_send').execute({
      to: 'dev', message: '【回执】REQ-1 开发完成', requirement: REQ, node: '开发',
    })
    const message = service.calls.find((entry) => entry.method === 'send')!.args[1].message
    expect(message).not.toContain('完成后请用 digital_human_send 回执给我')
    // The head is unchanged; only the request at the end is missing.
    expect(message).toBe(`需求目录：${requirementDir}\n节点：开发\n\n【回执】REQ-1 开发完成`)
  })

  it('waits for a reply when asked, and reports the outcome', async () => {
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    const result = await send.execute({ to: 'dev', message: 'x', wait_seconds: 1, requirement: REQ })
    expect(result.finished).toBe(true)
    expect(result.detail).toContain('turn finished')
  })

  it('reports a reply that is still running', async () => {
    const service = serviceStub({ status: async () => ({ exists: true, isGenerating: true }) })
    const send = toolOf(build(service), 'digital_human_send')
    const result = await send.execute({ to: 'dev', message: 'x', wait_seconds: 1, requirement: REQ })
    expect(result.finished).toBe(false)
    expect(result.detail).toContain('not ready')
  })

  it('carries the caller Session when the Host supplies one', async () => {
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    await send.execute({ to: 'dev', message: 'x', requirement: REQ }, { agent: { session: { header: { id: 'session-me-1' } } } })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1].fromSession).toBe('session-me-1')
  })

  it('omits the caller Session when the call carries none', async () => {
    // The Agent is optional on an execution, and a call from a nested dispatcher may
    // not have one — an absent id must not become the string "undefined".
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    for (const exec of [undefined, {}, { agent: {} }, { agent: { session: { header: {} } } }, { agent: { session: { header: { id: 7 } } } }]) {
      await send.execute({ to: 'dev', message: 'x', requirement: REQ }, exec)
    }
    expect(service.calls.filter((entry) => entry.method === 'send')
      .every((entry) => entry.args[1].fromSession === undefined)).toBe(true)
  })

  it('passes an explicit deadline through to the assignment', async () => {
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    const deadline = '2026-11-01T00:00:00.000Z'
    await send.execute({ to: 'dev', message: 'x', deadline, requirement: REQ })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1]).toMatchObject({ deadline })
    // A blank value is "no deadline", not a deadline of empty string.
    await send.execute({ to: 'dev', message: 'x', deadline: '  ', requirement: REQ })
    expect(service.calls.filter((entry) => entry.method === 'send')[1].args[1].deadline).toBeUndefined()
  })

  it('offers no Session parameter, because a remembered id is not an address', () => {
    const send = toolOf(build(serviceStub()), 'digital_human_send')
    expect(send.parameters.properties.session_id).toBeUndefined()
    expect(send.description).not.toContain('session_id')
  })

  it('ignores a stray Session address and keeps the requirement thread', async () => {
    // session_id is gone from the contract. A caller that still passes one gets the
    // requirement's thread: a remembered id belongs to the thread it was minted for,
    // so honouring it would deliver this requirement's work somewhere else.
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    await send.execute({ to: 'dev', message: 'x', session_id: 'session-them-1', requirement: REQ })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1])
      .toMatchObject({ conversationId: REQ, sessionId: undefined })
  })

  it('reports the conversation it delivered into, not a Session id to remember', async () => {
    const service = serviceStub()
    const detail = (await toolOf(build(service), 'digital_human_send')
      .execute({ to: 'dev', message: 'x', requirement: REQ })).detail
    expect(detail).toContain('REQ-1')
    expect(detail).not.toContain('record that id')
  })

  it('never lets an edge choose where a dispatch lands', async () => {
    // Edges record who talked to whom. They are not an address: the requirement's
    // thread names the Session, so the transport is not even asked.
    const service = serviceStub({
      threadTarget: async () => {
        throw new Error('a dispatch must not resolve an address from an edge')
      },
    })
    const result = await toolOf(build(service), 'digital_human_send').execute(
      { to: 'dev', message: 'x', requirement: REQ },
      { agent: { session: { header: { id: 'session-me-1' } } } },
    )
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1])
      .toMatchObject({ conversationId: 'REQ-1', sessionId: undefined })
    expect(service.calls.some((entry) => entry.method === 'threadTarget')).toBe(false)
    expect(result).toMatchObject({ conversationId: 'REQ-1' })
  })

  it('addresses a chat-keyed peer by the trigger chat in meta.json', async () => {
    writeFileSync(join(requirementDir, 'meta.json'), JSON.stringify({
      thread: REQ, name: REQ_NAME, trigger: { name: '万纯', chatId: 'wohR_trigger' },
    }))
    const service = serviceStub()
    const lookups: unknown[][] = []
    service.chatTarget = async (id: string, chatId: string) => {
      lookups.push([id, chatId])
      return 'session-chat-1'
    }
    await toolOf(build(service), 'digital_human_send')
      .execute({ to: 'front', message: 'x', requirement: REQ })
    expect(lookups).toEqual([['front', 'wohR_trigger']])
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1])
      .toMatchObject({
        conversationId: 'wohR_trigger',
        sessionId: 'session-chat-1',
        triggerChat: 'wohR_trigger',
      })
  })

  it('refuses a chat-keyed peer when the requirement records no trigger', async () => {
    const service = serviceStub()
    await expect(toolOf(build(service), 'digital_human_send')
      .execute({ to: 'front', message: 'x', requirement: REQ }))
      .rejects.toThrow(/缺触发人/)
    expect(service.calls.some((entry) => entry.method === 'send')).toBe(false)
  })

  it('refuses a trigger chat that has no Session yet', async () => {
    writeFileSync(join(requirementDir, 'meta.json'), JSON.stringify({
      thread: REQ, name: REQ_NAME, trigger: { name: '万纯', chatId: 'wohR_trigger' },
    }))
    const service = serviceStub({ chatTarget: async () => undefined })
    await expect(toolOf(build(service), 'digital_human_send')
      .execute({ to: 'front', message: 'x', requirement: REQ }))
      .rejects.toThrow(/聊天会话/)
    expect(service.calls.some((entry) => entry.method === 'send')).toBe(false)
  })

  it('refuses to reach a digital human outside the declared peers', async () => {
    const send = toolOf(build(serviceStub()), 'digital_human_send')
    await expect(send.execute({ to: 'off', message: 'x', requirement: REQ }))
      .rejects.toThrow(/may only message/)
  })

  it('lets a record with no peers declared reach anyone', async () => {
    const service = serviceStub()
    await toolOf(buildHumanTools({ ctx: ctxWith(), service, humanId: 'dev' }), 'digital_human_send')
      .execute({ to: 'pm', message: 'x', requirement: REQ })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[0]).toBe('pm')
  })

  it('expands an array of targets into one work item each, with its own receipt', async () => {
    const qa = { id: 'qa', name: '测试助手', enabled: true, im: { botId: '', targetId: '' } }
    const service = serviceStub({
      resolve: async (reference: string) => {
        service.calls.push({ method: 'resolve', args: [reference] })
        return [people.pm, people.dev, qa].find((entry) => entry.id === reference || entry.name === reference)
      },
      send: async (id: string, options: any) => {
        service.calls.push({ method: 'send', args: [id, options] })
        return {
          sessionId: `session-${id}`,
          conversationId: options.conversationId,
          accepted: true,
          task: { id: `w-${id}`, state: 'queued', intent: 'assign', queued: false },
        }
      },
    })
    // dev declares no peers, so both targets are reachable.
    const send = toolOf(buildHumanTools({ ctx: ctxWith(), service, humanId: 'dev' }), 'digital_human_send')
    const result = await send.execute({ to: ['pm', 'qa'], message: 'do it', conversation_id: 'REQ-1', requirement: REQ })
    expect(service.calls.filter((entry) => entry.method === 'send').map((entry) => entry.args[0]))
      .toEqual(['pm', 'qa'])
    // Two targets, two receipts: each carries the Session and the work item of one peer.
    expect(result.results).toEqual([
      expect.objectContaining({ to: 'pm', conversationId: 'REQ-1', sessionId: 'session-pm', taskId: 'w-pm', accepted: true }),
      expect.objectContaining({ to: 'qa', conversationId: 'REQ-1', sessionId: 'session-qa', taskId: 'w-qa', accepted: true }),
    ])
    expect(result.detail).toContain('w-pm')
    expect(result.detail).toContain('w-qa')
    // The Host rejects any undeclared key, so the receipt must match its own schema.
    expect(undeclaredKeys(send.output.schema, result)).toEqual([])
  })

  it('does not hand the same work over twice when the caller retries', async () => {
    // A send delivers before it reports: a caller that sees a failure retries a
    // handover the peer already holds. Within a minute the retry returns the first
    // receipt instead of assigning the same work again.
    let delivered = 0
    const service = serviceStub({
      send: async (id: string, options: any) => {
        delivered += 1
        return {
          sessionId: `session-${id}`,
          conversationId: options.conversationId,
          accepted: true,
          task: { id: 'w-01', state: 'queued', intent: 'assign', queued: false },
        }
      },
    })
    const send = toolOf(buildHumanTools({ ctx: ctxWith(), service, humanId: 'dev' }), 'digital_human_send')
    const first = await send.execute({ to: 'pm', message: 'do it', conversation_id: 'REQ-1', requirement: REQ })
    const again = await send.execute({ to: 'pm', message: 'do it', conversation_id: 'REQ-1', requirement: REQ })
    expect(delivered).toBe(1)
    expect(again.taskId).toBe(first.taskId)
    expect(again.detail).toContain('not handed over twice')
  })

  it('returns a single receipt that keeps to its own schema', async () => {
    const service = serviceStub({
      send: async (id: string, options: any) => ({
        sessionId: `session-${id}`,
        conversationId: options.conversationId,
        accepted: true,
        task: { id: 'w-01', state: 'queued', intent: 'assign', queued: false },
      }),
    })
    const send = toolOf(buildHumanTools({ ctx: ctxWith(), service, humanId: 'dev' }), 'digital_human_send')
    const result = await send.execute({ to: 'pm', message: 'do it', conversation_id: 'REQ-1', requirement: REQ })
    expect(undeclaredKeys(send.output.schema, result)).toEqual([])
    expect(result.results[0].detail).toContain('w-01')
  })

  it('refuses the whole array when one target is unknown, delivering nothing', async () => {
    const service = serviceStub()
    const send = toolOf(buildHumanTools({ ctx: ctxWith(), service, humanId: 'dev' }), 'digital_human_send')
    await expect(send.execute({ to: ['pm', 'ghost'], message: 'x', requirement: REQ }))
      .rejects.toThrow(/unknown digital human/)
    expect(service.calls.some((entry) => entry.method === 'send')).toBe(false)
  })

  it('resolves status, messages and stop through the edge too', async () => {
    const service = serviceStub({
      threadTarget: async () => ({ sessionId: 'session-pm-work', conversationId: 'REQ-1', via: 'inbound' }),
    })
    const tools = build(service)
    const exec = { agent: { session: { header: { id: 'session-me-1' } } } }
    await toolOf(tools, 'digital_human_status').execute({ to: 'dev', conversation_id: 'REQ-1' }, exec)
    await toolOf(tools, 'digital_human_messages').execute({ to: 'dev', conversation_id: 'REQ-1' }, exec)
    await toolOf(tools, 'digital_human_stop').execute({ to: 'dev', conversation_id: 'REQ-1' }, exec)
    const argsOf = (method: string) => service.calls.find((entry) => entry.method === method)!.args
    expect(argsOf('status')[1]).toBe('session-pm-work')
    expect(argsOf('messages')[1]).toBe('session-pm-work')
    expect(argsOf('stop')[1]).toBe('session-pm-work')
  })

  it('still addresses by the requirement thread when the transport cannot resolve edges', async () => {
    const service = serviceStub({ threadTarget: undefined })
    await toolOf(build(service), 'digital_human_send')
      .execute({ to: 'dev', message: 'x', requirement: REQ })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1])
      .toMatchObject({ conversationId: REQ, sessionId: undefined })
  })

  it('polls by conversation when the delivery reports no Session', async () => {
    const service = serviceStub({
      send: async (id: string, options: any) => {
        service.calls.push({ method: 'send', args: [id, options] })
        return { sessionId: undefined, conversationId: options.conversationId ?? 'main', accepted: true }
      },
    })
    const result = await toolOf(build(service), 'digital_human_send')
      .execute({ to: 'dev', message: 'x', wait_seconds: 1, requirement: REQ })
    expect(result.finished).toBe(true)
    expect(service.calls.find((entry) => entry.method === 'status')!.args[1]).toBe(REQ)
  })

  it('reports an idle peer and a turn that was not stopped', async () => {
    const service = serviceStub({
      status: async () => ({ exists: false, isGenerating: false, conversationId: 'REQ-1' }),
      stop: async () => ({ stopped: false }),
    })
    const tools = build(service)
    const idle = await toolOf(tools, 'digital_human_status').execute({ to: 'dev', conversation_id: 'REQ-1' })
    expect(idle.exists).toBe(false)
    const stopped = await toolOf(tools, 'digital_human_stop').execute({ to: 'dev', conversation_id: 'REQ-1' })
    expect(stopped.stopped).toBe(false)
  })

  it('reads a conversation whose last line is outbound', async () => {
    const service = serviceStub({
      messages: async () => ({
        conversationId: 'REQ-1',
        items: [{ at: '2026-01-01T00:00:00Z', kind: 'outbound', text: 'sent' }],
      }),
    })
    const read = await toolOf(build(service), 'digital_human_messages')
      .execute({ to: 'dev', conversation_id: 'REQ-1' })
    expect(read.detail).toContain('开发助手 → pm')
  })

  it('opens the requirement thread when the send names no address', async () => {
    // The requirement is the address. A send with no edge to follow still reaches
    // the peer, in the one thread every role of that requirement shares.
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    const result = await send.execute({ to: 'dev', message: 'x', requirement: REQ })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1])
      .toMatchObject({ conversationId: REQ, sessionId: undefined })
    expect(result.conversationId).toBe(REQ)
  })

  it('accepts the requirement directory as the thread name', async () => {
    const service = serviceStub()
    await toolOf(build(service), 'digital_human_send')
      .execute({ to: 'dev', message: 'x', conversation_id: REQ + '-20260101', requirement: REQ })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1].conversationId).toBe(REQ)
  })

  it('refuses a role-suffixed conversation instead of splitting the requirement', async () => {
    // One requirement is one conversation. A suffix would file the same requirement
    // under a second node in the tree, which is exactly the split this guards.
    const service = serviceStub()
    const send = toolOf(build(service), 'digital_human_send')
    await expect(send.execute({ to: 'dev', message: 'x', conversation_id: REQ + '-dev', requirement: REQ }))
      .rejects.toThrow(/must be the requirement's thread name.*do not add a role suffix/)
    expect(service.calls.some((entry) => entry.method === 'send')).toBe(false)
  })

  it('keeps the requirement conversation when a stray Session address is passed', async () => {
    const service = serviceStub()
    await toolOf(build(service), 'digital_human_send').execute({ to: 'dev', message: 'x', session_id: 'session-them-1', requirement: REQ })
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1].conversationId).toBe(REQ)
  })

  it('refuses an unknown peer, a self-send and an empty target', async () => {
    const send = toolOf(build(serviceStub()), 'digital_human_send')
    await expect(send.execute({ to: 'nobody', message: 'x', requirement: REQ })).rejects.toThrow(/unknown digital human/)
    await expect(send.execute({ to: 'pm', message: 'x', requirement: REQ })).rejects.toThrow(/cannot send to itself/)
    await expect(send.execute({ to: '', message: 'x', requirement: REQ })).rejects.toThrow(/target digital human is required/)
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

  it('echoes the work item a send was recorded as', async () => {
    const service = serviceStub({
      send: async (id: string, options: any) => {
        service.calls.push({ method: 'send', args: [id, options] })
        return {
          sessionId: 'session-1', conversationId: 'REQ-1', accepted: true,
          task: { id: 'w-01', state: 'in_progress', intent: 'amend', queued: false },
        }
      },
    })
    const result = await toolOf(build(service), 'digital_human_send').execute({
      to: 'dev', message: 'x', conversation_id: 'REQ-1', mode: 'amend', task_id: 'w-01', note: 'ships Monday', requirement: REQ,
    })
    expect(result).toMatchObject({ taskId: 'w-01', taskState: 'in_progress', taskIntent: 'amend' })
    expect(result.detail).toContain('amendment to w-01')
    expect(service.calls.find((entry) => entry.method === 'send')!.args[1])
      .toMatchObject({ mode: 'amend', taskId: 'w-01', note: 'ships Monday' })
  })

  it('says a task was queued, and does not wait for the turn in front of it', async () => {
    const service = serviceStub({
      send: async (id: string, options: any) => {
        service.calls.push({ method: 'send', args: [id, options] })
        return {
          sessionId: 'session-1', conversationId: 'REQ-1', accepted: true,
          task: { id: 'w-02', state: 'queued', intent: 'assign', queued: true },
        }
      },
    })
    const result = await toolOf(build(service), 'digital_human_send')
      .execute({ to: 'dev', message: 'x', conversation_id: 'REQ-1', wait_seconds: 30, requirement: REQ })
    expect(result.detail).toContain('Queued as w-02')
    expect(result.finished).toBe(false)
    // Waiting would only observe the turn in front of the queued item.
    expect(service.calls.some((entry) => entry.method === 'status')).toBe(false)
  })

  it('reports a cancellation instead of a delivery', async () => {
    const service = serviceStub({
      send: async (id: string, options: any) => {
        service.calls.push({ method: 'send', args: [id, options] })
        return {
          sessionId: '', conversationId: 'REQ-1', accepted: false,
          task: { id: 'w-01', state: 'cancelled', intent: 'cancel', queued: false },
        }
      },
    })
    const result = await toolOf(build(service), 'digital_human_send')
      .execute({ to: 'dev', message: 'stop', conversation_id: 'REQ-1', mode: 'cancel', requirement: REQ })
    expect(result).toMatchObject({ accepted: false, taskId: 'w-01', taskState: 'cancelled' })
    expect(result.detail).toContain('Cancelled work item w-01')
    expect(result.detail).not.toContain('Delivered')
  })

  it('reports the latest work item of a conversation beside the turn state', async () => {
    const service = serviceStub({
      status: async () => ({ exists: true, isGenerating: false, conversationId: 'REQ-1' }),
      tasks: async (id: string, conversationId: string) => {
        service.calls.push({ method: 'tasks', args: [id, conversationId] })
        return [
          { id: 'w-01', from: 'pm', to: 'dev', conversation: 'REQ-1', state: 'done', createdAt: '2026-01-01T00:00:00Z' },
          {
            id: 'w-02', from: 'pm', to: 'dev', conversation: 'REQ-1', state: 'failed',
            createdAt: '2026-01-01T00:02:00Z', endedAt: '2026-01-01T00:03:00Z', reason: 'truncated', note: 'see the log',
          },
        ]
      },
    })
    const result = await toolOf(build(service), 'digital_human_status')
      .execute({ to: 'dev', conversation_id: 'REQ-1' })
    expect(result).toMatchObject({
      taskId: 'w-02', state: 'failed', reason: 'truncated', endedAt: '2026-01-01T00:03:00Z', note: 'see the log',
    })
    expect(result.detail).toContain('w-02')
    expect(result.detail).toContain('failed')
    expect(result.detail).toContain('see the log')
    expect(service.calls.find((entry) => entry.method === 'tasks')!.args).toEqual(['dev', 'REQ-1'])
  })
})

describe('the requirement tools', () => {
  const build = (service: any = serviceStub()) => buildHumanTools({ ctx: ctxWith(), service, humanId: 'pm' })
  const stateFile = () => join(requirementDir, 'state.json')

  it('reads the digest of a requirement with no state yet', async () => {
    const read = toolOf(build(), 'digital_human_requirement_read')
    const result = await read.execute({ requirement: REQ })
    expect(result.detail).toContain('线程名：REQ-1')
    expect(result.detail).toContain('需求名：组织基线验证')
    expect(result.detail).toContain('（尚未开始）')
    // Reading is not a write: no state.json appears until an update makes one.
    expect(existsSync(stateFile())).toBe(false)
    expect(undeclaredKeys(read.output.schema, result)).toEqual([])
  })

  it('refuses a requirement it cannot resolve, instead of guessing a directory', async () => {
    const read = toolOf(build(), 'digital_human_requirement_read')
    await expect(read.execute({ requirement: 'ghost' })).rejects.toThrow(/unknown requirement: "ghost"/)
    await expect(read.execute({})).rejects.toThrow(/requires a requirement/)
  })

  it('advances one node, writes state.json and returns the new digest', async () => {
    const tools = build()
    const update = toolOf(tools, 'digital_human_requirement_update')
    const result = await update.execute({
      requirement: REQ, node: 'dev', status: 'running', note: '写代码', evidence: ['nodes/dev.md'],
    })
    expect(result.detail).toContain('- dev：running（写代码） 证据 nodes/dev.md')
    const state = JSON.parse(readFileSync(stateFile(), 'utf8'))
    expect(state).toMatchObject({
      thread: REQ,
      name: REQ_NAME,
      nodes: { dev: { status: 'running', note: '写代码', evidence: ['nodes/dev.md'] } },
    })
    expect(typeof state.updatedAt).toBe('string')
    // The same read tool reports what the update wrote, so the state has one source.
    expect((await toolOf(tools, 'digital_human_requirement_read').execute({ requirement: REQ })).detail)
      .toContain('- dev：running')
    expect(undeclaredKeys(update.output.schema, result)).toEqual([])
  })

  it('refuses an update with no node or no status', async () => {
    const update = toolOf(build(), 'digital_human_requirement_update')
    await expect(update.execute({ requirement: REQ, status: 'done' })).rejects.toThrow(/node is required/)
    await expect(update.execute({ requirement: REQ, node: 'dev' })).rejects.toThrow(/status is required/)
    expect(existsSync(stateFile())).toBe(false)
  })

  it('attaches evidence inside the requirement directory and returns its path', async () => {
    const attach = toolOf(build(), 'digital_human_requirement_attach')
    const result = await attach.execute({ requirement: REQ, name: 'report.md', content: '# ok', kind: 'self-test' })
    expect(result.path).toBe(join(requirementDir, 'self-test', 'report.md'))
    expect(result.detail).toContain(result.path)
    expect(readFileSync(result.path, 'utf8')).toBe('# ok')
    // The default folder is nodes, where a node's own evidence belongs; a name
    // there carries a ticket id or a nature prefix (2026-11-12 convention).
    const node = await attach.execute({ requirement: REQ, name: 'w1-dev.md', content: 'x' })
    expect(node.path).toBe(join(requirementDir, 'nodes', 'w1-dev.md'))
    expect(undeclaredKeys(attach.output.schema, result)).toEqual([])
  })

  it('keeps a slash in the name from leaving the evidence folder', async () => {
    const attach = toolOf(build(), 'digital_human_requirement_attach')
    const result = await attach.execute({ requirement: REQ, name: 'fix-/escape.md', content: 'x' })
    expect(result.path).toBe(join(requirementDir, 'nodes', 'fix--escape.md'))
  })

  it('refuses an attachment with no name, and an unknown requirement', async () => {
    const attach = toolOf(build(), 'digital_human_requirement_attach')
    await expect(attach.execute({ requirement: REQ, content: 'x' })).rejects.toThrow(/name is required/)
    await expect(attach.execute({ requirement: 'ghost', name: 'a.md', content: 'x' }))
      .rejects.toThrow(/unknown requirement/)
  })

  it('creates a requirement and renders its receipt', async () => {
    const create = toolOf(build(), 'digital_human_requirement_create')
    const result = await create.execute({ thread: 'REQ-2', name: '交付验证' })
    expect(result.dir.startsWith('交付验证-')).toBe(true)
    expect(existsSync(join(result.path, 'meta.json'))).toBe(true)
    expect(existsSync(join(result.path, 'params.md'))).toBe(true)
    // The generic gaps check calls every renderer, so this one must exist.
    expect(create.output.render({}, result)).toEqual([{ type: 'text', text: JSON.stringify(result) }])
  })

  it('archives a requirement: moves every file, appends the index, marks the state archived', async () => {
    const tools = build()
    // A requirement holds its own documents and its state; archiving keeps both.
    writeFileSync(join(requirementDir, 'nodes.md'), 'evidence')
    mkdirSync(join(requirementDir, 'nodes'))
    writeFileSync(join(requirementDir, 'nodes', 'dev.md'), 'x')
    await toolOf(tools, 'digital_human_requirement_update').execute({ requirement: REQ, node: 'dev', status: 'done' })
    const archive = toolOf(tools, 'digital_human_requirement_archive')
    const result = await archive.execute({ requirement: REQ })
    const archived = join(home, 'workspace', '_archive', REQ + '-20260101')
    expect(result.dir).toBe(REQ + '-20260101')
    expect(result.index).toBe(join(home, 'workspace', '_archive', 'index.md'))
    expect(typeof result.archivedAt).toBe('string')
    // A move, not a delete: every file kept its name and its bytes.
    expect(existsSync(requirementDir)).toBe(false)
    expect(readFileSync(join(archived, 'meta.json'), 'utf8')).toContain(REQ)
    expect(readFileSync(join(archived, 'nodes.md'), 'utf8')).toBe('evidence')
    expect(readFileSync(join(archived, 'nodes', 'dev.md'), 'utf8')).toBe('x')
    const state = JSON.parse(readFileSync(join(archived, 'state.json'), 'utf8'))
    expect(state.archived).toBe(true)
    expect(state).not.toHaveProperty('phase')
    expect(state.events.at(-1)).toContain('archived to')
    // The first archive creates the index with its header, then one row.
    const index = readFileSync(result.index, 'utf8')
    expect(index.split('\n')[0]).toBe('| 需求名 | 线程名 | 归档时间 | 节点数 | 最后阶段 |')
    // The row records the phase the nodes derived at the moment of the archive.
    expect(index).toContain(`| ${REQ_NAME} | ${REQ} | ${result.archivedAt} | 1 | done |`)
    expect(result.detail).toContain(archived)
    expect(undeclaredKeys(archive.output.schema, result)).toEqual([])
    expect(archive.output.render({}, result)).toEqual([{ type: 'text', text: result.detail }])
    // A second archive appends a row and does not write the header again.
    await toolOf(tools, 'digital_human_requirement_create').execute({ thread: 'REQ-2', name: '交付验证' })
    const appended = await archive.execute({ requirement: 'REQ-2' })
    const rows = readFileSync(appended.index, 'utf8').trim().split('\n')
    expect(rows.filter((row) => row.startsWith('| 需求名'))).toHaveLength(1)
    expect(rows.at(-1)).toContain('| 交付验证 | REQ-2 |')
    // An archived requirement left reqs/, so its name no longer resolves there.
    await expect(archive.execute({ requirement: REQ })).rejects.toThrow(/unknown requirement/)
  })

  it('refuses to archive onto a directory that already exists', async () => {
    const target = join(home, 'workspace', '_archive', REQ + '-20260101')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'kept.md'), 'old')
    const archive = toolOf(build(), 'digital_human_requirement_archive')
    await expect(archive.execute({ requirement: REQ })).rejects.toThrow(/archive target already exists/)
    // Nothing moved, nothing overwritten, no index written.
    expect(existsSync(join(requirementDir, 'meta.json'))).toBe(true)
    expect(readFileSync(join(target, 'kept.md'), 'utf8')).toBe('old')
    expect(existsSync(join(home, 'workspace', '_archive', 'index.md'))).toBe(false)
  })

  it('refuses an archive it cannot resolve, instead of moving the wrong directory', async () => {
    const archive = toolOf(build(), 'digital_human_requirement_archive')
    await expect(archive.execute({ requirement: 'ghost' })).rejects.toThrow(/unknown requirement: "ghost"/)
    await expect(archive.execute({})).rejects.toThrow(/requires a requirement/)
    expect(existsSync(requirementDir)).toBe(true)
    expect(existsSync(join(home, 'workspace', '_archive'))).toBe(false)
  })

  it('refuses a dispatch to an archived requirement, then restores it and dispatches again', async () => {
    const tools = build()
    const archivedState = join(requirementDir, 'state.json')
    // A state written by an older version still carries `phase`; it is ignored.
    writeFileSync(archivedState, JSON.stringify({
      thread: REQ, name: REQ_NAME, phase: 'executing', nodes: {}, next: [], events: [],
    }))
    const archive = toolOf(tools, 'digital_human_requirement_archive')
    const archived = await archive.execute({ requirement: REQ })
    // The name is archived, not unknown: the reason says what to do next.
    const send = toolOf(tools, 'digital_human_send')
    await expect(send.execute({ to: 'dev', requirement: REQ, message: '继续改' }))
      .rejects.toThrow(/该需求已归档，先恢复再派单/)
    await expect(send.execute({ to: 'dev', requirement: REQ + '-20260101', message: '继续改' }))
      .rejects.toThrow(/该需求已归档，先恢复再派单/)

    const restore = toolOf(tools, 'digital_human_requirement_restore')
    const result = await restore.execute({ requirement: REQ })
    expect(result.dir).toBe(REQ + '-20260101')
    expect(typeof result.restoredAt).toBe('string')
    // A move back, never a copy: the live directory is back and the archive is empty.
    expect(existsSync(requirementDir)).toBe(true)
    expect(existsSync(join(home, 'workspace', '_archive', REQ + '-20260101'))).toBe(false)
    const state = JSON.parse(readFileSync(archivedState, 'utf8'))
    // The archived mark is cleared and the legacy phase is not written back: the
    // phase derives from the nodes, and there are none.
    expect(state.archived).toBeUndefined()
    expect(state).not.toHaveProperty('phase')
    expect(state.events.at(-1)).toContain('restored to')
    // The row is annotated in place: one row, now carrying the restore stamp.
    const index = readFileSync(archived.index, 'utf8')
    const rows = index.split('\n').filter((line) => line.startsWith(`| ${REQ_NAME} | ${REQ} |`))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('已恢复')
    expect(rows[0]).toContain(result.restoredAt)
    expect(undeclaredKeys(restore.output.schema, result)).toEqual([])
    expect(restore.output.render({}, result)).toEqual([{ type: 'text', text: result.detail }])
    // Restored, the requirement resolves and a dispatch goes through again.
    const sent = await send.execute({ to: 'dev', requirement: REQ, message: '继续改' })
    expect(sent.accepted).toBe(true)
  })

  it('refuses to restore onto a directory that already exists', async () => {
    const tools = build()
    await toolOf(tools, 'digital_human_requirement_archive').execute({ requirement: REQ })
    // Newer work took the live name; the restore must not overwrite it.
    mkdirSync(requirementDir, { recursive: true })
    writeFileSync(join(requirementDir, 'live.md'), 'new')
    const restore = toolOf(tools, 'digital_human_requirement_restore')
    await expect(restore.execute({ requirement: REQ })).rejects.toThrow(/restore target already exists/)
    expect(readFileSync(join(requirementDir, 'live.md'), 'utf8')).toBe('new')
    expect(existsSync(join(home, 'workspace', '_archive', REQ + '-20260101', 'meta.json'))).toBe(true)
  })

  it('restores only an archived requirement, and says so otherwise', async () => {
    const restore = toolOf(build(), 'digital_human_requirement_restore')
    await expect(restore.execute({})).rejects.toThrow(/requires a requirement/)
    // A live requirement needs no restore; an unknown name is not archived either.
    await expect(restore.execute({ requirement: REQ })).rejects.toThrow(/no archived requirement/)
    await expect(restore.execute({ requirement: 'ghost' })).rejects.toThrow(/no archived requirement/)
  })

  it('restores a hand-archived requirement and drops the archived mark', async () => {
    const archivedDir = join(home, 'workspace', '_archive', '手工归档-20260101')
    mkdirSync(archivedDir, { recursive: true })
    writeFileSync(join(archivedDir, 'meta.json'), JSON.stringify({ thread: 'HAND-1', name: '手工归档' }))
    writeFileSync(join(archivedDir, 'state.json'), JSON.stringify({
      thread: 'HAND-1', name: '手工归档', phase: 'archived', nodes: {}, next: [], events: [],
    }))
    const restore = toolOf(build(), 'digital_human_requirement_restore')
    const result = await restore.execute({ requirement: 'HAND-1' })
    expect(result.dir).toBe('手工归档-20260101')
    const state = JSON.parse(readFileSync(join(home, 'workspace', 'reqs', '手工归档-20260101', 'state.json'), 'utf8'))
    expect(state.archived).toBeUndefined()
    expect(state).not.toHaveProperty('phase')
    // No index existed, so the restore must still finish and report success.
    expect(result.detail).toContain(join(home, 'workspace', 'reqs', '手工归档-20260101'))
  })
})

describe('notify_bot', () => {

  it('counts a target alias to this chat as already covered', async () => {
    // The person writes the alias they know, the bridge's map names the raw chat
    // id: one chat, two spellings. The push must still be skipped.
    const stateDir = join(home, '..', 'integrations', 'dsh-wecom', 'bots', 'wecom_1')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ version: 1, sessions: { 'direct:wohR_1': 'session-me' } }))
    aliasFor('wecom_1', 'harrywan-direct', 'wohR_1')
    const send = vi.fn(async () => ({ ok: true }))
    const notify = toolOf(build(serviceStub(), { send, listTargets: async () => [{ targetId: 'harrywan-direct' }] }), 'notify_bot')
    await expect(notify.execute({ message: 'hi', to: 'harrywan-direct' }, { agent: { session: { header: { id: 'session-me' } } } }))
      .rejects.toThrow(/本会话已送达/)
    expect(send).not.toHaveBeenCalled()
  })

  const build = (service: any, dshIm?: unknown) => buildHumanTools({ ctx: ctxWith(dshIm), service, humanId: 'pm' })

  it('refuses a message with no explicit target', async () => {
    // A record's own target belongs to one conversation; guessing it for another
    // message would put that message in a group nobody asked for.
    const send = vi.fn(async () => ({ ok: true }))
    const notify = toolOf(build(serviceStub(), { send, listTargets: async () => [{ targetId: 'leader' }] }), 'notify_bot')
    await expect(notify.execute({ message: 'hello' })).rejects.toThrow(/needs an explicit to/)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends to the explicit target through the bound bot', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const notify = toolOf(build(serviceStub(), { send, listTargets: async () => [{ targetId: 'leader' }] }), 'notify_bot')
    const result = await notify.execute({ message: 'hello', to: 'leader' })
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

  it('registers a chat id it just delivered to, when the IM plugin can', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const createTarget = vi.fn(async () => ({}))
    const notify = toolOf(build(serviceStub(), { send, listTargets: async () => [], createTarget }), 'notify_bot')
    const result = await notify.execute({ message: 'hi', to: 'wohR_abcdef12', kind: 'user' })
    expect(createTarget).toHaveBeenCalledWith('wecom_1', {
      targetId: 'auto-abcdef12',
      kind: 'user',
      route: { chatId: 'wohR_abcdef12' },
    })
    expect(result.detail).toContain('registered as target "auto-abcdef12"')
  })

  it('still delivers when the IM plugin cannot register the chat id', async () => {
    const send = vi.fn(async () => ({ ok: true }))
    const notify = toolOf(build(serviceStub(), { send, listTargets: async () => [] }), 'notify_bot')
    const result = await notify.execute({ message: 'hi', to: 'wohR_chat' })
    expect(result.detail).toContain('Sent to raw chat id wohR_chat')
    expect(result.detail).toContain('not registered as a target')
  })

  it('tells the model how to recover from an address it cannot deliver to', async () => {
    const notify = toolOf(build(serviceStub(), {
      send: async () => { throw new Error('Unknown target') },
      listTargets: async () => [],
    }), 'notify_bot')
    await expect(notify.execute({ message: 'x', to: 'someone-direct' })).rejects.toThrow(/raw chat id/)
  })

  it('sends to a raw chat id as a group when kind says so', async () => {
    // A group chat id is addressed the same way as a person's, and only `kind`
    // tells the channel which of the two it is.
    const send = vi.fn(async () => ({ ok: true }))
    const notify = toolOf(build(serviceStub(), { send, listTargets: async () => [] }), 'notify_bot')
    await notify.execute({ message: 'hi', to: 'wrGROUP', kind: 'group' })
    expect(send).toHaveBeenCalledWith(
      'wecom_1',
      { kind: 'group', route: { chatId: 'wrGROUP' } },
      'hi',
      { format: 'plain' },
    )
  })

  it('falls back to target-id delivery when the target list cannot be read', async () => {
    // The documented trade: an unreadable roster keeps the original behaviour
    // instead of treating every target as a raw chat id.
    const send = vi.fn(async () => ({ ok: true }))
    const notify = toolOf(build(serviceStub(), {
      send,
      listTargets: async () => { throw new Error('im is down') },
    }), 'notify_bot')
    await notify.execute({ message: 'hi', to: 'leader' })
    expect(send).toHaveBeenCalledWith('wecom_1', 'leader', 'hi', { format: 'plain' })
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
      .rejects.toThrow(/needs an explicit to/)
    const notify = toolOf(build(serviceStub(), im), 'notify_bot')
    await expect(notify.execute({ message: '   ', to: 'leader' })).rejects.toThrow(/must not be empty/)
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

  it('archives only the timeline when asked, keeping `# now`', async () => {
    const service = serviceStub()
    const { ensureMemory, memoryPaths } = await import('../../src/lib/memory')
    const { readFileSync, writeFileSync } = await import('node:fs')
    const paths = memoryPaths(service.store, 'pm')
    ensureMemory(paths.file)
    writeFileSync(paths.file, '# now\n## State | x\n\n# History\n\n## 2026-10-01-1200 | old\nbody\n', 'utf8')
    const result = await toolOf(build(service), 'memory_compact').execute({ scope: 'history' })
    expect(result.detail).toContain('Archived')
    const text = readFileSync(paths.file, 'utf8')
    // The daily path: the timeline is gone, the working block is untouched.
    expect(text).toContain('## State | x')
    expect(text).not.toContain('old')
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
      bot_id: 'wecom_1', target_id: 't', enabled: false, memory: false, session_mode: 'single',
      icon: 'data:image/png;base64,iVBORw0KGgo=',
    })
    expect(seen[0]).toMatchObject({
      name: 'N', description: 'D', systemPrompt: 'S', workspace: '/w',
      im: { botId: 'wecom_1', targetId: 't' }, enabled: false, memory: false, sessionMode: 'single',
      icon: 'data:image/png;base64,iVBORw0KGgo=',
    })
  })

  it('only treats an explicit single as the shared mode', async () => {
    const seen: any[] = []
    const service = serviceStub({ upsert: async (patch: any) => { seen.push(patch); return patch } })
    await build(service).execute({ action: 'create', id: 'x', session_mode: 'thread' })
    await build(service).execute({ action: 'create', id: 'y', session_mode: 'typo' })
    expect(seen.map((entry) => entry.sessionMode)).toEqual(['thread', 'thread'])
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
