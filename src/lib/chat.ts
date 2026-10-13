/**
 * Chat runtime for digital humans — the DSH form of Halo's Chat system
 * (`/chat/send`, `/chat/status`, `/chat/messages`, `/chat/stop`).
 *
 * Each (digital human, conversation) pair owns one durable DSH Session, created
 * on first use and resumed on demand. The mailbox beside it is an append-only
 * JSONL log: inbound messages are written when delivered, outbound assistant
 * messages are written from the session event feed. The log — not the Session
 * transcript — is what peers read back, so a conversation survives compaction.
 */

import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { HumanStore } from './store.js'
import type { Ctx, Human, MailboxEntry } from './types.js'

/** Conversation used when a caller names none. */
export const DEFAULT_CONVERSATION = 'main'

/** Longest message a peer may post, matching the IM text bound. */
export const MESSAGE_MAX_CHARS = 32000

/** Conversation ids stay path-safe, mirroring Halo's chatId rule. */
// The Halo specification builds `app-chat:dev-assistant:http:direct:{slug}`,
// so a colon must be legal here. `store.conversationPath` percent-encodes the
// id, which keeps the name safe for a filesystem.
const CONVERSATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** Reject a conversation id that would escape its directory. */
export function requireConversation(value) {
  const text = String(value ?? '').trim() || DEFAULT_CONVERSATION
  if (!CONVERSATION.test(text)) {
    throw new Error(`conversationId must match ${CONVERSATION}: ${JSON.stringify(value)}`)
  }
  return text
}

/** Join the text blocks of one session message. */
function textOf(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** One bounded, JSON-safe mailbox record. */
function record(kind, fields) {
  return JSON.stringify({ at: new Date().toISOString(), kind, ...fields })
}

/** Owns every Session and mailbox a digital human uses. */
export class HumanChat {
  #ctx
  #store
  #log
  #indexes = new Map()
  #bySession = new Map()
  // `sessionController.prompt(request, signal)` requires an AbortSignal. One
  // controller lives as long as the chat service; `stopAll` aborts it.
  #abort = new AbortController()

  /**
   * @param ctx - Host context carrying `sessionController`.
   * @param store - the digital-human registry.
   * @param log - sink for contained failures; never throws.
   */
  #defaultWorkspacePath

  constructor(
    ctx: Ctx,
    store: HumanStore,
    log: (message: string) => void = () => {},
    { defaultWorkspacePath }: { defaultWorkspacePath?: () => string | undefined } = {},
  ) {
    this.#ctx = ctx
    this.#defaultWorkspacePath = defaultWorkspacePath
    this.#store = store
    this.#log = log
  }

  /** Session identity remembered for one (human, conversation) pair. */
  async #index(humanId) {
    if (this.#indexes.has(humanId)) return this.#indexes.get(humanId)
    const path = this.#store.sessionIndexPath(humanId)
    let index = {}
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'))
        if (parsed && typeof parsed === 'object') index = parsed
      } catch (error) {
        this.#log(`session index unreadable for ${humanId}: ${error.message}`)
      }
    }
    this.#indexes.set(humanId, index)
    return index
  }

  async #remember(humanId, conversationId, sessionId) {
    const index = await this.#index(humanId)
    index[conversationId] = sessionId
    this.#bySession.set(sessionId, { humanId, conversationId })
    await this.#store.ensureDir(this.#store.dir(humanId))
    const path = this.#store.sessionIndexPath(humanId)
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
    await rename(temp, path)
    return sessionId
  }

  /** Resolve the recorded Session for one conversation, without creating one. */
  async lookup(humanId, conversationId = DEFAULT_CONVERSATION) {
    const index = await this.#index(humanId)
    return index[conversationId]
  }

  /** Map a Session back to the digital human and conversation that own it. */
  ownerOf(sessionId) {
    return this.#bySession.get(sessionId)
  }

  /** Rebuild the reverse index from disk so a restart keeps routing outbound events. */
  async prime(humans: Human[]): Promise<void> {
    for (const human of humans) {
      const index = await this.#index(human.id)
      for (const [conversationId, sessionId] of Object.entries(index)) {
        if (typeof sessionId === 'string') this.#bySession.set(sessionId, { humanId: human.id, conversationId })
      }
    }
  }

  /** Locate one Session summary, tolerating a paged listing. */
  async #find(sessionId) {
    try {
      const listed = await this.#ctx.sessionController.list({})
      return (listed?.items ?? []).find((item) => item.sessionId === sessionId)
    } catch (error) {
      this.#log(`session list failed: ${error.message}`)
      return undefined
    }
  }

  /** Create or adopt the Session for one conversation. */
  async ensureSession(human, conversationId = DEFAULT_CONVERSATION, presetId) {
    const existing = await this.lookup(human.id, conversationId)
    if (existing) {
      const found = await this.#find(existing)
      // A Session may already exist under this conversation without carrying the
      // digital human's mode — an inbound IM turn creates one, and a record that
      // gained a preset after the fact leaves one behind. Adopting it would run
      // the conversation without the persona and tools the record declares, so
      // reopen the conversation under the right preset instead.
      if (found && (!presetId || found.agentPreset === presetId)) return existing
      if (found) {
        this.#log(
          `conversation ${human.id}/${conversationId} ran as ${found.agentPreset ?? '(no preset)'}`
          + `; reopening as ${presetId}`,
        )
      }
    }
    // A record that names no Workspace lands in the default one, so a digital
    // human always runs inside a Workspace rather than an implicit home.
    const cwd = human.workspace || this.#defaultWorkspacePath?.() || undefined
    const created = await this.#ctx.sessionController.create({
      ...(cwd ? { cwd } : {}),
      ...(presetId ? { agentPreset: presetId } : {}),
    })
    return this.#remember(human.id, conversationId, created.sessionId)
  }

  /** Append one mailbox record, creating the directory on first use. */
  async #append(humanId, conversationId, line) {
    const path = this.#store.conversationPath(humanId, conversationId)
    await this.#store.ensureDir(`${this.#store.dir(humanId)}/conversations`)
    await appendFile(path, `${line}\n`, 'utf8')
  }

  /**
   * Deliver one message into a digital human's conversation and start a turn.
   * @returns the Session identity and the prompt receipt.
   */
  async deliver(
    human: Human,
    { conversationId, message, from = 'user', presetId }: {
      conversationId?: string
      message?: string
      from?: string
      presetId?: string
    } = {},
  ) {
    if (!human.enabled) throw new Error(`digital human "${human.id}" is disabled`)
    const text = String(message ?? '').trim()
    if (!text) throw new Error('message must not be empty')
    if (text.length > MESSAGE_MAX_CHARS) throw new Error(`message exceeds ${MESSAGE_MAX_CHARS} characters`)
    const conversation = requireConversation(conversationId)
    const sessionId = await this.ensureSession(human, conversation, presetId)
    await this.#append(human.id, conversation, record('inbound', { from, text }))
    const accepted = await this.#ctx.sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, this.#abort.signal)
    return { sessionId, conversationId: conversation, accepted: accepted?.accepted === true }
  }

  /** Record one outbound assistant message observed on the session event feed. */
  async noteAssistant(sessionId, message) {
    const owner = this.#bySession.get(sessionId)
    if (!owner) return
    const text = textOf(message)
    if (!text) return
    await this.#append(owner.humanId, owner.conversationId, record('outbound', { text }))
  }

  /** Read the tail of one conversation log. */
  async messages(human, conversationId, limit = 20) {
    const conversation = requireConversation(conversationId)
    const sessionId = await this.lookup(human.id, conversation)
    const path = this.#store.conversationPath(human.id, conversation)
    if (!existsSync(path)) return { conversationId: conversation, sessionId: sessionId ?? null, items: [] }
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    const items: MailboxEntry[] = []
    for (const line of lines.slice(-Math.max(1, limit))) {
      try {
        items.push(JSON.parse(line))
      } catch {
        this.#log(`skipped malformed mailbox line in ${path}`)
      }
    }
    return { conversationId: conversation, sessionId: sessionId ?? null, items }
  }

  /** Report whether the conversation exists and whether its agent is mid-turn. */
  async status(human, conversationId) {
    const conversation = requireConversation(conversationId)
    const sessionId = await this.lookup(human.id, conversation)
    if (!sessionId) return { conversationId: conversation, exists: false, sessionId: null, isGenerating: false }
    const found = await this.#find(sessionId)
    return {
      conversationId: conversation,
      exists: true,
      sessionId,
      isGenerating: found?.running === true,
      agentAvailable: found?.agentAvailable === true,
    }
  }

  /** Ask the target Session to stop its current turn. */
  async stop(human, conversationId) {
    const conversation = requireConversation(conversationId)
    const sessionId = await this.lookup(human.id, conversation)
    if (!sessionId) return { stopped: false, sessionId: null }
    await this.#ctx.sessionController.cancel({ sessionId })
    return { stopped: true, sessionId }
  }
}
