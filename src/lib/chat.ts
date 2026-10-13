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

import { appendFile, readdir, readFile, rename, writeFile } from 'node:fs/promises'
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

/**
 * Whether an address names a DSH Session rather than a conversation.
 *
 * One address parameter carries either form, because a caller that was told which
 * Session to reply into must be able to use it verbatim. A conversation name never
 * carries this prefix by construction — the personas name them after a requirement.
 */
export function isSessionAddress(value) {
  return /^session-/.test(String(value ?? '').trim())
}

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

/**
 * The block that names the conversation a peer message arrived in.
 *
 * The transport knows this and the recipient does not: without the block it has to
 * take the conversation id from somewhere else — a file it read earlier, or its own
 * memory — and a remembered id that has since changed silently starts a second
 * thread for the same subject, with its own context and its own history.
 *
 * The shape matches the IM plugin's `<dsh_im_source>`, so one convention covers
 * every channel a digital human hears from.
 */
function peerSource(from, fromSession, conversationId) {
  // Every value is already constrained: the conversation id by CONVERSATION, the
  // sender by the registry's id rule, the Session id by the Host. None can break
  // out of its attribute.
  //
  // `session` is the one that matters for a reply: it names the Sender's own
  // Session, so the reply lands in the Session that asked for the work rather than
  // in whichever Session the conversation name happens to be bound to.
  const session = fromSession ? ` session="${fromSession}"` : ''
  return `<dsh_peer_source from="${from}"${session} conversation="${conversationId}" />`
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
  // controller lives as long as the chat service and is never aborted, so every
  // prompt it carries stays cancellable through `stop`.
  #abort = new AbortController()

  /**
   * @param ctx - Host context carrying `sessionController`.
   * @param store - the digital-human registry.
   * @param log - sink for contained failures; never throws.
   */
  #defaultWorkspacePath

  /**
   * Resolve a directory to the Workspace that owns it.
   *
   * A session created with a `cwd` alone is not filed under any Workspace, so the
   * UI cannot group it. This is the lookup that fixes that.
   */
  #workspaceIdOf

  constructor(
    ctx: Ctx,
    store: HumanStore,
    log: (message: string) => void = () => {},
    {
      defaultWorkspacePath,
      workspaceIdOf,
    }: {
      defaultWorkspacePath?: () => string | undefined
      workspaceIdOf?: (path: string) => string | undefined
    } = {},
  ) {
    this.#ctx = ctx
    this.#defaultWorkspacePath = defaultWorkspacePath
    this.#workspaceIdOf = workspaceIdOf
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

  /**
   * Every conversation this digital human already has.
   *
   * A caller that invents a conversation id instead of reusing one splits a
   * subject across two Sessions — two contexts, two histories, the same work done
   * twice. Listing what exists is what lets a caller reuse rather than invent.
   */
  async conversations(humanId) {
    return Object.keys(await this.#index(humanId))
  }

  /**
   * Every Session this digital human can be reached in, by whatever address names
   * it: the conversation it was filed under, or its own Session id.
   *
   * A caller needs both forms, because a reply travels as a Session id while an
   * older thread is named by its conversation.
   */
  async addresses(humanId) {
    const found: Array<{ conversationId: string | null; sessionId: string }> = []
    for (const [conversationId, sessionId] of Object.entries(await this.#index(humanId))) {
      if (typeof sessionId === 'string') found.push({ conversationId, sessionId })
    }
    for (const [sessionId, owner] of this.#bySession) {
      if (owner.humanId !== humanId) continue
      if (found.some((entry) => entry.sessionId === sessionId)) continue
      found.push({ conversationId: null, sessionId })
    }
    return found
  }

  /** Map a Session back to the digital human and conversation that own it. */
  ownerOf(sessionId) {
    return this.#bySession.get(sessionId)
  }

  /**
   * Drop every index entry for a digital human that no longer exists.
   *
   * Without this its sessions keep resolving to an owner, so an assistant turn in
   * one of them is appended to a mailbox in a directory the record no longer has.
   */
  forget(humanId) {
    const index = this.#indexes.get(humanId)
    if (index) {
      for (const sessionId of Object.values(index)) {
        if (typeof sessionId === 'string') this.#bySession.delete(sessionId)
      }
      this.#indexes.delete(humanId)
    }
  }

  /** Rebuild the reverse index from disk so a restart keeps routing outbound events. */
  async prime(humans: Human[]): Promise<void> {
    for (const human of humans) {
      const index = await this.#index(human.id)
      for (const [conversationId, sessionId] of Object.entries(index)) {
        if (typeof sessionId === 'string') this.#bySession.set(sessionId, { humanId: human.id, conversationId })
      }
      // A Session addressed directly is not in the index, so its own log file is
      // what names it — without this its replies would not be logged after a restart.
      const dir = `${this.#store.dir(human.id)}/conversations`
      if (!existsSync(dir)) continue
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.jsonl')) continue
        const key = decodeURIComponent(name.slice(0, -'.jsonl'.length))
        // Only what the index does not already name: it knows the conversation the
        // Session was filed under, and the filename does not.
        if (key.startsWith('session-') && !this.#bySession.has(key)) {
          this.#bySession.set(key, { humanId: human.id, conversationId: key })
        }
      }
    }
  }

  /**
   * Locate one Session summary, tolerating a paged listing.
   *
   * @returns the summary; `undefined` when the listing was read and does not
   *   contain it; `null` when the listing could not be read at all. The caller must
   *   tell those apart — see {@link ensureSession}.
   */
  async #find(sessionId) {
    try {
      const listed = await this.#ctx.sessionController.list({})
      return (listed?.items ?? []).find((item) => item.sessionId === sessionId)
    } catch (error) {
      this.#log(`session list failed: ${error.message}`)
      return null
    }
  }

  /** Create or adopt the Session for one conversation. */
  /**
   * Resolve the Session one conversation runs in, reopening only when it must.
   *
   * A conversation maps to exactly one Session for its whole life. That mapping is
   * kept here, and the Session is *adopted* by id rather than looked up and replaced
   * — an archived or idle Session is not in the live listing, and treating "absent
   * from the listing" as "gone" opened a second Session for a subject that already
   * had one, with its own context and its own history.
   *
   * @param human - the record the conversation belongs to.
   * @param conversationId - the thread to resolve.
   * @param presetId - the preset the Session must run under.
   * @returns the Session id, which is also recorded for the next call.
   */
  async ensureSession(human, conversationId = DEFAULT_CONVERSATION, presetId) {
    const existing = await this.lookup(human.id, conversationId)
    if (existing) {
      try {
        return this.#remember(human.id, conversationId, await this.#adopt(human, existing, presetId))
      } catch (error) {
        // A Session cannot change its preset or its directory, so a record that now
        // declares a different one cannot reuse it. That is the only reason to
        // reopen, and it is said out loud because it costs the conversation's
        // history.
        this.#log(
          `conversation ${human.id}/${conversationId} could not reuse ${existing}`
          + ` (${error.message}); reopening`,
        )
      }
    }
    return this.#remember(human.id, conversationId, await this.#create(human, presetId))
  }

  /**
   * Resolve one address to the Session it names.
   *
   * The address carries either a conversation name — the old form — or a DSH
   * Session id, which is what a peer message reports so its reply can land in the
   * Session that asked for the work. A Session id is adopted as given; a name goes
   * through the index, and either way a Session that cannot be reused is replaced.
   *
   * @returns the Session id and the conversation name it belongs to, if any.
   */
  async #resolve(human, address, presetId) {
    const text = String(address ?? '').trim()
    if (isSessionAddress(text)) {
      // "Passed an id that exists → use it; passed one that does not → a new one."
      const conversation = await this.#conversationOf(human.id, text)
      let sessionId
      try {
        sessionId = await this.#adopt(human, text, presetId)
      } catch (error) {
        this.#log(
          `session ${text} could not receive for ${human.id} (${error.message}); opening a new one`,
        )
        sessionId = await this.#create(human, presetId)
      }
      // Remembered even though no conversation was filed for it: without the reverse
      // entry its own replies would not reach a mailbox, and it would be invisible to
      // a caller asking which Sessions this digital human answers in.
      this.#bySession.set(sessionId, { humanId: human.id, conversationId: conversation ?? sessionId })
      return { sessionId, conversation: conversation ?? sessionId }
    }
    const conversation = requireConversation(text)
    return { sessionId: await this.ensureSession(human, conversation, presetId), conversation }
  }

  /** The conversation name a recorded Session was filed under, if any. */
  async #conversationOf(humanId, sessionId) {
    const index = await this.#index(humanId)
    for (const [conversationId, recorded] of Object.entries(index)) {
      if (recorded === sessionId) return conversationId
    }
    return undefined
  }

  /** Adopt one Session by id, or fail when it cannot carry this record. */
  async #adopt(human, sessionId, presetId) {
    const adopted = await this.#ctx.sessionController.create({
      sessionId,
      ...this.#location(human),
      ...(presetId ? { agentPreset: presetId } : {}),
    })
    return adopted.sessionId
  }

  /** Open a fresh Session for this record. */
  async #create(human, presetId) {
    const created = await this.#ctx.sessionController.create({
      ...this.#location(human),
      ...(presetId ? { agentPreset: presetId } : {}),
    })
    return created.sessionId
  }

  /**
   * Where the Session runs.
   *
   * The Workspace id files it under the Workspace's list, which is what the UI
   * groups by, and is passed *instead of* `cwd`: the Host resolves the directory
   * from the Workspace and rejects a request that names both.
   */
  #location(human) {
    const cwd = human.workspace || this.#defaultWorkspacePath?.() || undefined
    const workspaceId = cwd ? this.#workspaceIdOf?.(cwd) : undefined
    if (workspaceId) return { workspaceId }
    return cwd ? { cwd } : {}
  }

  /**
   * The mailbox file for one Session, migrating a log written under the old key.
   *
   * The log used to be keyed by the conversation name. It is keyed by the Session
   * now, because a reply may address either form and both must read the same file —
   * otherwise one side writes a reply the other side cannot find.
   */
  async #mailbox(humanId, sessionId, conversation) {
    const path = this.#store.conversationPath(humanId, sessionId)
    if (conversation && conversation !== sessionId && !existsSync(path)) {
      const legacy = this.#store.conversationPath(humanId, conversation)
      if (existsSync(legacy)) {
        try {
          await rename(legacy, path)
        } catch (error) {
          this.#log(`could not carry the log for ${humanId}/${conversation}: ${error.message}`)
        }
      }
    }
    return path
  }

  /** Append one mailbox record, creating the directory on first use. */
  async #append(humanId, sessionId, conversation, line) {
    const path = await this.#mailbox(humanId, sessionId, conversation)
    await this.#store.ensureDir(`${this.#store.dir(humanId)}/conversations`)
    await appendFile(path, `${line}\n`, 'utf8')
  }

  /**
   * Deliver one message into a digital human's conversation and start a turn.
   * @returns the Session identity and the prompt receipt.
   */
  async deliver(
    human: Human,
    { conversationId, sessionId, message, from = 'user', fromSession, presetId }: {
      conversationId?: string
      sessionId?: string
      message?: string
      from?: string
      fromSession?: string
      presetId?: string
    } = {},
  ) {
    if (!human.enabled) throw new Error(`digital human "${human.id}" is disabled`)
    const text = String(message ?? '').trim()
    if (!text) throw new Error('message must not be empty')
    if (text.length > MESSAGE_MAX_CHARS) throw new Error(`message exceeds ${MESSAGE_MAX_CHARS} characters`)
    const target = await this.#resolve(human, sessionId ?? conversationId, presetId)
    await this.#append(human.id, target.sessionId, target.conversation, record('inbound', { from, text }))
    const accepted = await this.#ctx.sessionController.prompt({
      requestId: randomUUID(),
      sessionId: target.sessionId,
      mode: 'queue',
      // The mailbox keeps the message as written; the model also gets the two facts
      // only the transport knows: who sent it, and which Session to answer.
      content: [{ type: 'text', text: `${peerSource(from, fromSession, target.conversation)}\n${text}` }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, this.#abort.signal)
    return {
      sessionId: target.sessionId,
      conversationId: target.conversation,
      accepted: accepted?.accepted === true,
    }
  }

  /** Record one outbound assistant message observed on the session event feed. */
  async noteAssistant(sessionId, message) {
    const owner = this.#bySession.get(sessionId)
    if (!owner) return
    const text = textOf(message)
    if (!text) return
    await this.#append(owner.humanId, sessionId, owner.conversationId, record('outbound', { text }))
  }

  /** Read the tail of one conversation log. */
  async messages(human, address, limit = 20) {
    const found = await this.#address(human, address)
    if (!found) return { conversationId: requireConversation(address), sessionId: null, items: [] }
    const { sessionId, conversation } = found
    const path = await this.#mailbox(human.id, sessionId, conversation)
    if (!existsSync(path)) return { conversationId: conversation, sessionId, items: [] }
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    const items: MailboxEntry[] = []
    for (const line of lines.slice(-Math.max(1, limit))) {
      try {
        items.push(JSON.parse(line))
      } catch {
        this.#log(`skipped malformed mailbox line in ${path}`)
      }
    }
    return { conversationId: conversation, sessionId, items }
  }

  /** Report whether the conversation exists and whether its agent is mid-turn. */
  async status(human, address) {
    const resolved = await this.#address(human, address)
    if (!resolved) {
      return { conversationId: requireConversation(address), exists: false, sessionId: null, isGenerating: false }
    }
    const { sessionId, conversation } = resolved
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
  async stop(human, address) {
    const resolved = await this.#address(human, address)
    if (!resolved) return { stopped: false, sessionId: null }
    await this.#ctx.sessionController.cancel({ sessionId: resolved.sessionId })
    return { stopped: true, sessionId: resolved.sessionId }
  }

  /**
   * Resolve an address without creating anything.
   *
   * A Session id is taken as given once this record is known to own it; a
   * conversation name goes through the index. Reading must never open a Session,
   * so an unknown address resolves to nothing.
   */
  async #address(human, address) {
    const text = String(address ?? '').trim()
    if (isSessionAddress(text)) {
      if (!this.#bySession.has(text)) return undefined
      return { sessionId: text, conversation: (await this.#conversationOf(human.id, text)) ?? text }
    }
    const conversation = requireConversation(text)
    const sessionId = await this.lookup(human.id, conversation)
    return sessionId ? { sessionId, conversation } : undefined
  }
}
