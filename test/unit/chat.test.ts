import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_CONVERSATION, HumanChat, MESSAGE_MAX_CHARS, requireConversation } from '../../src/lib/chat'
import { HumanStore, normalizeHuman } from '../../src/lib/store'

let home = ''
let store: HumanStore

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dh-chat-'))
  store = new HumanStore(home)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const human = (patch: Record<string, unknown> = {}) => normalizeHuman({
  id: 'pm', name: 'PM', systemPrompt: 'x', workspace: '/w', ...patch,
})

/**
 * A session controller whose answers the test can steer, and which records every
 * create and prompt so reuse is measurable.
 */
function controllerStub() {
  const created: any[] = []
  const prompted: any[] = []
  const cancelled: string[] = []
  let next = 0
  const sessions: any[] = []
  const controller: any = {
    created,
    prompted,
    cancelled,
    sessions,
    /**
     * Mirrors the Host's real `session.create` contract, because both of its rules
     * have bitten this code: naming a Workspace and a cwd together is refused, and an
     * explicit id adopts the Session — refusing when its preset or directory differs.
     */
    create: async (options: any) => {
      created.push(options)
      if (options?.workspaceId !== undefined && options?.cwd !== undefined) {
        throw new Error('session.create accepts workspaceId or cwd, not both')
      }
      if (options?.sessionId !== undefined) {
        const known = sessions.find((entry) => entry.sessionId === options.sessionId)
        if (!known) {
          sessions.push({ sessionId: options.sessionId, agentPreset: options.agentPreset, cwd: options.cwd, running: false })
          return { sessionId: options.sessionId, agentPreset: options.agentPreset }
        }
        if (options.agentPreset !== undefined && known.agentPreset !== options.agentPreset) {
          throw new Error(`session "${options.sessionId}" would change preset`)
        }
        // The Host resolves the directory from the Workspace when one is named, and
        // compares that — so a Workspace id is not a way around the check.
        const wanted = options.cwd ?? (options.workspaceId === 'ws-1' ? '/w' : undefined)
        if (wanted !== undefined && known.cwd !== undefined && known.cwd !== wanted) {
          throw new Error(`session "${options.sessionId}" would change directory`)
        }
        return { sessionId: known.sessionId, agentPreset: known.agentPreset }
      }
      next += 1
      const sessionId = `session-${next}`
      sessions.push({ sessionId, agentPreset: options?.agentPreset, cwd: options?.cwd, running: false })
      return { sessionId }
    },
    prompt: async (request: any, signal: AbortSignal) => {
      prompted.push(request)
      if (!(signal instanceof AbortSignal)) throw new TypeError('prompt requires an AbortSignal')
      const found = sessions.find((entry) => entry.sessionId === request.sessionId)
      if (found) found.running = true
      return { accepted: true }
    },
    list: async () => ({ items: sessions.map((entry) => ({ ...entry })) }),
    cancel: async ({ sessionId }: { sessionId: string }) => {
      cancelled.push(sessionId)
      const found = sessions.find((entry) => entry.sessionId === sessionId)
      if (found) found.running = false
      return { accepted: true }
    },
  }
  return controller
}

const chatWith = (controller: any, options: Record<string, unknown> = {}) => {
  const log = vi.fn()
  const chat = new HumanChat({ sessionController: controller, ...(options.ctx as object ?? {}) } as any, store, log, {
    defaultWorkspacePath: () => '/default',
    workspaceIdOf: (path: string) => (path === '/w' ? 'ws-1' : undefined),
    ...options,
  } as any)
  return { chat, log }
}

describe('requireConversation', () => {
  it('defaults an absent id', () => {
    expect(requireConversation(undefined)).toBe(DEFAULT_CONVERSATION)
    expect(requireConversation('')).toBe('main')
    expect(requireConversation('   ')).toBe('main')
  })

  it('keeps a valid id and trims it', () => {
    expect(requireConversation('  REQ-1  ')).toBe('REQ-1')
    expect(requireConversation('app-chat:dev:http:direct:slug')).toBe('app-chat:dev:http:direct:slug')
  })

  it('refuses a value a filename cannot carry', () => {
    expect(() => requireConversation('a/b')).toThrow(/conversationId must match/)
    expect(() => requireConversation('a\nb')).toThrow(/conversationId must match/)
    expect(() => requireConversation('x'.repeat(200))).toThrow(/conversationId must match/)
  })
})

describe('ensureSession', () => {
  it('creates the session once, then adopts it by id', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    const first = await chat.ensureSession(human(), 'main', 'dh-pm')
    const second = await chat.ensureSession(human(), 'main', 'dh-pm')
    expect(second).toBe(first)
    expect(controller.created).toHaveLength(2)
    // The second call names the Session, which is what makes the Host adopt it
    // rather than mint another one.
    expect(controller.created[0].sessionId).toBeUndefined()
    expect(controller.created[1]).toMatchObject({ sessionId: first, agentPreset: 'dh-pm' })
    expect(controller.sessions).toHaveLength(1)
  })

  it('never names a Workspace and a cwd together, which the Host refuses', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    await chat.ensureSession(human(), 'main', 'dh-pm')
    const request = controller.created[0]
    expect(request.workspaceId).toBe('ws-1')
    expect(request.cwd).toBeUndefined()
  })

  it('adopts a Session the live listing no longer carries', async () => {
    // Archived, or idle and closed: the Session is neither gone nor a reason to
    // start a second thread for a subject that already has one.
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    const first = await chat.ensureSession(human(), 'main', 'dh-pm')
    controller.sessions.length = 0
    controller.list = async () => ({ items: [] })
    expect(await chat.ensureSession(human(), 'main', 'dh-pm')).toBe(first)
  })

  it('reopens only when the Session cannot carry the record any more', async () => {
    const controller = controllerStub()
    const { chat, log } = chatWith(controller)
    const first = await chat.ensureSession(human(), 'main', 'dh-pm')
    controller.sessions[0].agentPreset = 'standard'
    const second = await chat.ensureSession(human(), 'main', 'dh-pm')
    expect(second).not.toBe(first)
    // Three calls: the first create, the refused adoption, and the replacement.
    expect(controller.created).toHaveLength(3)
    expect(String(log.mock.calls[0][0])).toContain('could not reuse')
  })

  it('reopens when the record moved to another directory', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    const first = await chat.ensureSession(human(), 'main', 'dh-pm')
    controller.sessions[0].cwd = '/elsewhere'
    expect(await chat.ensureSession(human(), 'main', 'dh-pm')).not.toBe(first)
  })

  it('does not read the live listing at all, so a listing failure cannot split it', async () => {
    const controller = controllerStub()
    controller.list = async () => { throw new Error('listing down') }
    const { chat } = chatWith(controller)
    const first = await chat.ensureSession(human(), 'main', 'dh-pm')
    expect(await chat.ensureSession(human(), 'main', 'dh-pm')).toBe(first)
  })

  it('falls back to the default directory and no workspace', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    await chat.ensureSession(human({ workspace: '' }), 'main', 'dh-pm')
    expect(controller.created[0]).toMatchObject({ cwd: '/default' })
    expect(controller.created[0].workspaceId).toBeUndefined()
  })

  it('works without a workspace mapper or a default directory', async () => {
    const controller = controllerStub()
    const chat = new HumanChat({ sessionController: controller } as any, store, vi.fn(), {})
    await chat.ensureSession(human({ workspace: '' }), 'main')
    expect(controller.created[0].cwd).toBeUndefined()
    expect(controller.created[0].agentPreset).toBeUndefined()
  })
})

describe('deliver', () => {
  it('creates the session, starts a turn and records both sides', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    const delivered = await chat.deliver(human(), { message: 'hello', from: 'dev', presetId: 'dh-pm' })
    expect(delivered).toMatchObject({ conversationId: 'main', accepted: true })
    expect(controller.prompted[0]).toMatchObject({ mode: 'queue' })
    // The model is told which conversation the message arrived in, so it can reply
    // on the same one without remembering an id from somewhere else.
    const sent = controller.prompted[0].content[0].text
    expect(sent).toContain('<dsh_peer_source from="dev" conversation="main" />')
    expect(sent.endsWith('hello')).toBe(true)
    const mailbox = readFileSync(store.conversationPath('pm', delivered.sessionId), 'utf8')
    expect(mailbox).toContain('"kind":"inbound"')
    expect(mailbox).toContain('"from":"dev"')
  })

  it('names the conversation and the sender, for any conversation id', async () => {
    // This is the fix for a real split: a receiver that is not told the conversation
    // falls back on a remembered id, and a stale one starts a second thread.
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    await chat.deliver(human(), { message: 'a', conversationId: 'REQ-1', from: 'pm-assistant' })
    expect(controller.prompted[0].content[0].text)
      .toContain('<dsh_peer_source from="pm-assistant" conversation="REQ-1" />')
    // The mailbox keeps the message as written, without the block.
    const mailbox = readFileSync(store.conversationPath('pm', controller.sessions[0].sessionId), 'utf8')
    expect(mailbox).not.toContain('dsh_peer_source')
  })

  it('records an outbound line for a session it owns', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    const delivered = await chat.deliver(human(), { message: 'kick off' })
    await chat.noteAssistant(delivered.sessionId, { content: [{ type: 'text', text: 'report back' }] })
    expect(readFileSync(store.conversationPath('pm', delivered.sessionId), 'utf8')).toContain('"kind":"outbound"')
  })

  it('ignores an outbound line for a session it does not own, or with no text', async () => {
    const { chat } = chatWith(controllerStub())
    await chat.noteAssistant('someone-else', { content: [{ type: 'text', text: 'x' }] })
    await chat.noteAssistant('nobody', { content: [] })
    expect(() => readFileSync(store.conversationPath('pm', 'main'), 'utf8')).toThrow()
  })

  it('marks the prompt as user-authored and carries the client time zone', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    await chat.deliver(human(), { message: 'x' })
    expect(controller.prompted[0].requestId).toBeTypeOf('string')
    expect(controller.prompted[0].clientTimeZone).toBeTypeOf('string')
  })

  it('refuses an oversized message rather than storing a truncated one', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    await expect(chat.deliver(human(), { message: 'x'.repeat(MESSAGE_MAX_CHARS + 1) }))
      .rejects.toThrow(/message exceeds/)
    expect(controller.prompted).toEqual([])
  })

  it('accepts a message at the limit', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    const body = 'x'.repeat(MESSAGE_MAX_CHARS)
    await chat.deliver(human(), { message: body })
    // The limit bounds the message, not the block the transport adds.
    expect(controller.prompted[0].content[0].text.endsWith(body)).toBe(true)
  })

  it('refuses a disabled record and an empty message', async () => {
    const { chat } = chatWith(controllerStub())
    await expect(chat.deliver(human({ enabled: false }), { message: 'x' })).rejects.toThrow(/is disabled/)
    await expect(chat.deliver(human(), { message: '   ' })).rejects.toThrow(/must not be empty/)
  })

  it('reports a prompt that the host refused, without throwing', async () => {
    const controller = controllerStub()
    controller.prompt = async () => ({ accepted: false })
    const { chat } = chatWith(controller)
    const delivered = await chat.deliver(human(), { message: 'x' })
    expect(delivered.accepted).toBe(false)
  })

  it('propagates a transport failure so the caller can retry', async () => {
    const controller = controllerStub()
    controller.prompt = async () => { throw new Error('session is gone') }
    const { chat } = chatWith(controller)
    await expect(chat.deliver(human(), { message: 'x' })).rejects.toThrow('session is gone')
  })
})

describe('messages', () => {
  it('reports an empty conversation', async () => {
    const { chat } = chatWith(controllerStub())
    expect(await chat.messages(human(), 'main')).toEqual({ conversationId: 'main', sessionId: null, items: [] })
  })

  it('returns the last entries, in order', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    await chat.deliver(human(), { message: 'one' })
    await chat.deliver(human(), { message: 'two' })
    const read = await chat.messages(human(), 'main', 10)
    expect(read.items.map((entry: any) => entry.text)).toEqual(['one', 'two'])
    expect(read.sessionId).toBeTypeOf('string')
  })

  it('honours the limit and clamps a nonsensical one', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    await chat.deliver(human(), { message: 'one' })
    await chat.deliver(human(), { message: 'two' })
    expect((await chat.messages(human(), 'main', 1)).items).toHaveLength(1)
    expect((await chat.messages(human(), 'main', 0)).items).toHaveLength(1)
    expect((await chat.messages(human(), 'main', -5)).items).toHaveLength(1)
  })

  it('skips a malformed line instead of failing the read', async () => {
    const controller = controllerStub()
    const { chat, log } = chatWith(controller)
    const delivered = await chat.deliver(human(), { message: 'good' })
    writeFileSync(store.conversationPath('pm', delivered.sessionId), '{ not json\n', { flag: 'a' })
    const read = await chat.messages(human(), 'main', 10)
    expect(read.items).toHaveLength(1)
    expect(String(log.mock.calls.at(-1)![0])).toContain('malformed mailbox line')
  })
})

describe('addressing a Session directly', () => {
  it('delivers into the Session a peer names, without opening another', async () => {
    // This is how a reply reaches the Session that asked for the work: the message
    // header reports it, and the answer is addressed to it verbatim.
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    const first = await chat.ensureSession(human(), 'main', 'dh-pm')
    const delivered = await chat.deliver(human(), { sessionId: first, message: 'answer', fromSession: 'session-sender-9' })
    expect(delivered.sessionId).toBe(first)
    expect(controller.sessions).toHaveLength(1)
    expect(controller.prompted[0].content[0].text)
      .toContain('<dsh_peer_source from="user" session="session-sender-9" conversation="main" />')
  })

  it('names the sending Session so the answer can go back to it', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    await chat.deliver(human(), { message: 'x', from: 'dev', fromSession: 'session-pm-1' })
    expect(controller.prompted[0].content[0].text).toContain('session="session-pm-1"')
  })

  it('creates the Session an unknown address names', async () => {
    // "Passed an id that exists → use it; passed one that does not → a new one." The
    // Host creates a Session under the id it is given, so the address still holds.
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    const delivered = await chat.deliver(human(), { sessionId: 'session-fresh-1', message: 'x' })
    expect(delivered.sessionId).toBe('session-fresh-1')
    expect(controller.sessions.map((entry) => entry.sessionId)).toEqual(['session-fresh-1'])
  })

  it('reports and replaces a Session it cannot adopt', async () => {
    const controller = controllerStub()
    const { chat, log } = chatWith(controller)
    const first = await chat.ensureSession(human(), 'main', 'dh-pm')
    controller.sessions[0].agentPreset = 'standard'
    const delivered = await chat.deliver(human(), { sessionId: first, message: 'x', presetId: 'dh-pm' })
    expect(delivered.sessionId).not.toBe(first)
    expect(log.mock.calls.map(([line]) => String(line)).some((line) => line.includes('opening a new one'))).toBe(true)
  })

  it('reads and stops by Session id as well as by conversation name', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    const delivered = await chat.deliver(human(), { message: 'hello' })
    expect((await chat.messages(human(), delivered.sessionId)).items.map((e: any) => e.text)).toEqual(['hello'])
    expect((await chat.status(human(), delivered.sessionId)).sessionId).toBe(delivered.sessionId)
    expect((await chat.stop(human(), delivered.sessionId))).toMatchObject({ stopped: true })
  })

  it('resolves nothing for an address it does not know, without creating a Session', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    expect(await chat.messages(human(), 'session-other-1')).toMatchObject({ sessionId: null, items: [] })
    expect(await chat.status(human(), 'session-other-1')).toMatchObject({ exists: false })
    expect(await chat.stop(human(), 'session-other-1')).toEqual({ stopped: false, sessionId: null })
    expect(controller.sessions).toEqual([])
  })

  it('lists both address forms', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    const named = await chat.ensureSession(human(), 'main', 'dh-pm')
    await chat.deliver(human(), { sessionId: named, message: 'x' })
    const addresses = await chat.addresses('pm')
    expect(addresses).toEqual([{ conversationId: 'main', sessionId: named }])
  })

  it('carries a log written under the old conversation key', async () => {
    // The log used to be keyed by the conversation name. A reply may address either
    // form, so the old file has to follow the Session or one side reads nothing.
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    const sessionId = await chat.ensureSession(human(), 'main', 'dh-pm')
    await store.ensureDir(`${store.dir('pm')}/conversations`)
    writeFileSync(store.conversationPath('pm', 'main'), `${JSON.stringify({ at: 'x', kind: 'inbound', from: 'dev', text: 'old' })}\n`)
    const read = await chat.messages(human(), sessionId)
    expect(read.items.map((entry: any) => entry.text)).toEqual(['old'])
    expect(existsSync(store.conversationPath('pm', sessionId))).toBe(true)
  })
})

describe('the address list', () => {
  it('names a Session addressed directly, which no conversation was filed under', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    await chat.deliver(human(), { sessionId: 'session-direct-1', message: 'x' })
    expect(await chat.addresses('pm')).toEqual([{ conversationId: null, sessionId: 'session-direct-1' }])
  })

  it('leaves out a Session that belongs to another digital human', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    await chat.deliver(human({ id: 'other' }), { sessionId: 'session-other-1', message: 'x' })
    expect(await chat.addresses('pm')).toEqual([])
  })

  it('lists a named conversation once, not twice', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    const named = await chat.ensureSession(human(), 'main', 'dh-pm')
    await chat.deliver(human(), { sessionId: named, message: 'x' })
    expect(await chat.addresses('pm')).toHaveLength(1)
  })
})

describe('status and stop', () => {
  it('reports a conversation that does not exist', async () => {
    const { chat } = chatWith(controllerStub())
    expect(await chat.status(human(), 'main')).toMatchObject({ exists: false, isGenerating: false })
    expect(await chat.stop(human(), 'main')).toEqual({ stopped: false, sessionId: null })
  })

  it('reports a running turn and stops it', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    const delivered = await chat.deliver(human(), { message: 'x' })
    expect(await chat.status(human(), 'main')).toMatchObject({ exists: true, isGenerating: true })
    expect(await chat.stop(human(), 'main')).toMatchObject({ stopped: true })
    expect(controller.cancelled).toEqual([delivered.sessionId])
    expect(await chat.status(human(), 'main')).toMatchObject({ isGenerating: false })
  })

  it('lets a failed cancel surface', async () => {
    // The caller asked to stop a turn; swallowing the failure would report success.
    const controller = controllerStub()
    controller.cancel = async () => { throw new Error('already done') }
    const { chat } = chatWith(controller)
    await chat.deliver(human(), { message: 'x' })
    await expect(chat.stop(human(), 'main')).rejects.toThrow('already done')
  })

  it('still reports the conversation as existing when the listing no longer carries it', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    await chat.deliver(human(), { message: 'x' })
    controller.sessions.length = 0
    // The record is what "exists" means here; the listing only answers "is it busy".
    expect(await chat.status(human(), 'main')).toMatchObject({ exists: true, isGenerating: false })
  })
})

describe('the conversation index', () => {
  it('lists the conversations a human already has', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    await chat.deliver(human(), { message: 'a' })
    await chat.deliver(human(), { message: 'b', conversationId: 'REQ-1' })
    expect((await chat.conversations('pm')).sort()).toEqual(['REQ-1', 'main'])
  })

  it('maps a session back to its owner, and rebuilds that map from disk', async () => {
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    const delivered = await chat.deliver(human(), { message: 'a' })
    expect(chat.ownerOf(delivered.sessionId)).toEqual({ humanId: 'pm', conversationId: 'main' })

    const restarted = chatWith(controller).chat
    expect(restarted.ownerOf(delivered.sessionId)).toBeUndefined()
    await restarted.prime([human()])
    expect(restarted.ownerOf(delivered.sessionId)).toEqual({ humanId: 'pm', conversationId: 'main' })
  })

  it('survives a session index that is malformed', async () => {
    const controller = controllerStub()
    await store.ensureDir(store.dir('pm'))
    writeFileSync(store.sessionIndexPath('pm'), '{ not json')
    const { chat } = chatWith(controller)
    expect(await chat.conversations('pm')).toEqual([])
  })

  it('drops a non-string entry from a hand-edited index', async () => {
    await store.ensureDir(store.dir('pm'))
    writeFileSync(store.sessionIndexPath('pm'), JSON.stringify({ main: 'session-1', broken: 42 }))
    const controller = controllerStub()
    const { chat } = chatWith(controller)
    expect(await chat.conversations('pm')).toEqual(['main', 'broken'])
    await chat.prime([human()])
    expect(chat.ownerOf('session-1')).toEqual({ humanId: 'pm', conversationId: 'main' })
    expect(chat.ownerOf(42)).toBeUndefined()
  })
})
