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

import { appendFile, mkdir, open, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { peerSource } from './peer-source.js'
import { conversationSlug } from './slug.js'
import type { HumanStore } from './store.js'
import type { Ctx, Human, MailboxEntry } from './types.js'

/** Conversation used when a caller names none. */
export const DEFAULT_CONVERSATION = 'main'

/** Longest message a peer may post, matching the IM text bound. */
export const MESSAGE_MAX_CHARS = 32000

/**
 * One peer message, as a directed edge between two Sessions.
 *
 * `selfSession` is the side that keeps the line; `peerSession` is the other side.
 * `dir` says which way the message travelled. A reply is resolved from the inbound
 * edges of the Session that answers, so the answer follows the Session that asked
 * instead of whatever the thread's name happens to be bound to.
 */
export interface PeerEdge {
  at: string
  dir: 'in' | 'out'
  selfSession: string
  peer: string
  peerSession: string
  conversation: string
}

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

/**
 * The title a peer-delivered session should carry, derived from the message.
 *
 * A delivery that opens a conversation is the one moment the transport knows what
 * the subject is: the PM's first line names the requirement. Left to the model, the
 * title becomes whatever the first prompt happened to say — usually the transport's
 * own peer block — so the list is unreadable.
 *
 * @param text - the delivered message, with its peer header already stripped.
 * @param conversation - the thread name, used when the message names no subject.
 * @returns a title, or undefined when nothing worth naming the thread is known.
 */
export function sessionTitleFor(text, conversation) {
  const firstLine = String(text ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  const named = /^【(?:新需求|参数更新|需求阻塞|需求完成|阻塞处理反馈|需求终止)】\s*(.+)$/.exec(firstLine)
  const fromMessage = named?.[1]?.trim() ?? ''
  const fromThread = fromMessage || (conversation && conversation !== DEFAULT_CONVERSATION && !isSessionAddress(conversation) ? conversation : '')
  const title = fromThread.replace(/\s+/g, ' ').trim()
  return title ? title.slice(0, 60) : undefined
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

/** Order two edges by their timestamp, newest first. */
function byNewest(a: PeerEdge, b: PeerEdge): number {
  return a.at < b.at ? 1 : a.at > b.at ? -1 : 0
}

/** One bounded, JSON-safe mailbox record. */
function record(kind, fields) {
  return JSON.stringify({ at: new Date().toISOString(), kind, ...fields })
}

/** Bytes read per step while looking for the thread name in one mailbox log. */
const MAILBOX_CHUNK = 64 * 1024

/** The thread one mailbox line belongs to, or null when the line names none. */
function conversationOf(line: string): string | null {
  if (!line.trim()) return null
  try {
    const entry = JSON.parse(line)
    const conversation = entry?.conversation
    return typeof conversation === 'string' && conversation.trim() ? conversation : null
  } catch {
    return null
  }
}

/** What one mailbox file has already reported, so a large log is read once. */
interface MailboxScan {
  mtimeMs: number
  size: number
  conversation: string | null
}

/** Owns every Session and mailbox a digital human uses. */
export class HumanChat {
  #ctx
  #store
  #log
  #indexes = new Map()
  #bySession = new Map()
  // Sessions this instance opened, so a first delivery can name them without
  // guessing from the transcript whether they already had a title.
  #fresh = new Set()
  // Every peer message seen, per human: appended to edges.jsonl and read back by
  // prime, so a restart keeps the routing.
  #edges = new Map<string, PeerEdge[]>()
  // What each mailbox log has already reported, per human and per file: a thread
  // name is read once, not on every tree read.
  #mailboxes = new Map<string, Map<string, MailboxScan>>()
  // One write at a time per human. The index is rewritten whole, so two concurrent
  // writers would drop each other's line.
  #writes = new Map<string, Promise<unknown>>()
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
  #ensureWorkspace
  #workspaceIdOf

  constructor(
    ctx: Ctx,
    store: HumanStore,
    log: (message: string) => void = () => {},
    {
      defaultWorkspacePath,
      workspaceIdOf,
      ensureWorkspace,
    }: {
      defaultWorkspacePath?: () => string | undefined
      workspaceIdOf?: (path: string) => string | undefined
      /**
       * Register a directory as a Workspace and return its id.
       *
       * A per-requirement directory is created on the fly, so it is not in the
       * roster yet; without an id the Session runs in the right place but the UI
       * cannot group it, and it shows up ungrouped.
       */
      ensureWorkspace?: (path: string, title?: string) => Promise<string | undefined>
    } = {},
  ) {
    this.#ctx = ctx
    this.#defaultWorkspacePath = defaultWorkspacePath
    this.#workspaceIdOf = workspaceIdOf
    this.#ensureWorkspace = ensureWorkspace
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
    this.#warnSharedSessions(humanId, index)
    this.#indexes.set(humanId, index)
    return index
  }

  /**
   * Say out loud when one Session carries two conversation names.
   *
   * The name is written once per thread, so a duplicate can only come from a
   * hand-edited index or an older build. It is announced, not repaired here: which
   * name owns the Session is the operator's call, and guessing would move a thread's
   * history without telling anyone.
   */
  #warnSharedSessions(humanId, index) {
    const owners = new Map()
    for (const [name, recorded] of Object.entries(index)) {
      if (typeof recorded !== 'string') continue
      const first = owners.get(recorded)
      if (first === undefined) owners.set(recorded, name)
      else this.#log(`session ${recorded} of ${humanId} is filed under both "${first}" and "${name}"`)
    }
  }

  /** Run one write after the previous write for the same human finished. */
  #serial(humanId, task) {
    const previous = this.#writes.get(humanId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.#writes.set(humanId, next.catch(() => {}))
    return next
  }

  async #remember(humanId, conversationId, sessionId) {
    const index = await this.#index(humanId)
    // One Session carries one thread: two names for it merge two subjects into one
    // history, and the second thread's replies land in the first thread's mailbox.
    // Refused, not overwritten — a silent merge is the failure this guards against.
    const owner = Object.keys(index).find((name) => name !== conversationId && index[name] === sessionId)
    if (owner !== undefined) {
      const problem = `conversation "${conversationId}" resolved to ${sessionId}, which already belongs to "${owner}"`
      this.#log(problem)
      throw new Error(problem)
    }
    index[conversationId] = sessionId
    this.#bySession.set(sessionId, { humanId, conversationId })
    await this.#serial(humanId, async () => {
      await this.#store.ensureDir(this.#store.dir(humanId))
      const path = this.#store.sessionIndexPath(humanId)
      // Merge into what is on disk now, not into the cached map: a reloaded
      // plugin instance may have filed another thread since this map was read,
      // and writing the stale copy would drop that entry.
      let onDisk = {}
      try { onDisk = JSON.parse(await readFile(path, 'utf8')) } catch { onDisk = {} }
      const merged = { ...onDisk, [conversationId]: sessionId }
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
      await rename(temp, path)
      this.#indexes.set(humanId, merged)
    })
    return sessionId
  }

  /** The edge list for one human, in arrival order. */
  #edgesOf(humanId) {
    let list = this.#edges.get(humanId)
    if (list === undefined) {
      list = []
      this.#edges.set(humanId, list)
    }
    return list
  }

  /**
   * Append one edge and keep it in memory.
   *
   * A failed write is contained: the delivery still happens, and the edge is still
   * known to this process — losing the line costs routing after a restart, not the
   * message that is already on its way.
   */
  async noteEdge(humanId: string, edge: Omit<PeerEdge, 'at'>) {
    if (!edge.selfSession || !edge.peer || !edge.peerSession) return
    const entry: PeerEdge = { at: new Date().toISOString(), ...edge }
    this.#edgesOf(humanId).push(entry)
    try {
      await this.#serial(humanId, async () => {
        await this.#store.ensureDir(this.#store.dir(humanId))
        await appendFile(this.#store.edgePath(humanId), `${JSON.stringify(entry)}\n`, 'utf8')
      })
    } catch (error) {
      this.#log(`edge for ${humanId} was not written: ${error.message}`)
    }
  }

  /**
   * The Session a message to one peer should reach, resolved from traffic.
   *
   * Order matters:
   * 1. the newest message the peer sent into this Session — a reply belongs to the
   *    Session that asked;
   * 2. the newest message this Session sent to the peer on the same thread — a
   *    continuation stays in the thread it opened;
   * 3. the newest edge with that peer on that thread, from any of this human's
   *    Sessions — a call from another window still finds the thread's home;
   * 4. the legacy name index, for a thread that only ever existed before edges.
   *
   * @returns the target and how it was found, or null when nothing is known.
   */
  async threadTarget(humanId, { selfSession, peer, conversationId }: {
    selfSession?: string
    peer: string
    conversationId?: string
  }) {
    const list = this.#edgesOf(humanId)
    const pick = (predicate: (edge: PeerEdge) => boolean) => list.filter(predicate).sort(byNewest)[0]
    const sameThread = (edge: PeerEdge) => conversationId === undefined || edge.conversation === conversationId
    const inbound = selfSession
      ? pick((edge) => edge.dir === 'in' && edge.selfSession === selfSession && edge.peer === peer && sameThread(edge))
      : undefined
    if (inbound) return { sessionId: inbound.peerSession, conversationId: inbound.conversation, via: 'inbound' as const }
    const outbound = selfSession
      ? pick((edge) => edge.dir === 'out' && edge.selfSession === selfSession && edge.peer === peer && sameThread(edge))
      : undefined
    if (outbound) return { sessionId: outbound.peerSession, conversationId: outbound.conversation, via: 'outbound' as const }
    // Only a named thread may be found from another Session: without a name, the
    // newest exchange could belong to a different subject entirely.
    const thread = conversationId !== undefined
      ? pick((edge) => edge.peer === peer && edge.conversation === conversationId)
      : undefined
    if (thread) return { sessionId: thread.peerSession, conversationId: thread.conversation, via: 'thread' as const }
    if (conversationId !== undefined) {
      const legacy = await this.lookup(humanId, conversationId)
      if (typeof legacy === 'string') return { sessionId: legacy, conversationId, via: 'legacy' as const }
    }
    return null
  }

  /**
   * The newest recorded exchange that matches a filter.
   *
   * Answering "is this a reply to the question that Session just asked" needs the
   * last line in each direction, not the whole history.
   */
  async latestEdge(humanId, { dir, peer, conversation, peerSession }: {
    dir: 'in' | 'out'
    peer?: string
    conversation?: string
    peerSession?: string
  }) {
    return this.#edgesOf(humanId)
      .filter((edge) => edge.dir === dir
        && (peer === undefined || edge.peer === peer)
        && (conversation === undefined || edge.conversation === conversation)
        && (peerSession === undefined || edge.peerSession === peerSession))
      .sort(byNewest)[0]
  }

  /** The conversation name a recorded Session was filed under, if any. */
  async conversationOf(humanId, sessionId) {
    return this.#conversationOf(humanId, sessionId)
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

  /**
   * Every address the mailbox itself proves for one digital human.
   *
   * `sessions.json` is a cache of the same fact, and a delivery path that never
   * writes it leaves a Session the index cannot name. The mailbox is written on
   * every delivery, so it is read here instead: one file per Session, and each
   * inbound line names the thread the message belongs to.
   *
   * The file name is the authority for the Session. `conversationPath` keys the
   * log by Session, while the `session` field of a line names the *peer* that
   * asked — the two do not confirm each other, and the name is what this side of
   * the exchange is called. A log filed under a conversation name predates the
   * Session key: it gives no Session of its own, so its thread is left to the
   * index rather than guessed here.
   *
   * @returns one address per Session, or an empty list when nothing is logged.
   */
  async addressesFromMailbox(humanId: string) {
    const dir = join(this.#store.dir(humanId), 'conversations')
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      this.#mailboxes.delete(humanId)
      return []
    }
    const scans = this.#mailboxScans(humanId)
    const found: Array<{ conversationId: string | null; sessionId: string }> = []
    const present = new Set<string>()
    for (const name of names.sort()) {
      if (!name.endsWith('.jsonl')) continue
      let sessionId: string
      try {
        sessionId = decodeURIComponent(name.slice(0, -'.jsonl'.length))
      } catch {
        continue
      }
      if (!isSessionAddress(sessionId)) continue
      const path = join(dir, name)
      present.add(path)
      const conversation = await this.#mailboxConversation(path, scans)
      if (conversation) found.push({ conversationId: conversation, sessionId })
    }
    // A log that is gone must not keep answering after it is deleted.
    for (const path of [...scans.keys()]) if (!present.has(path)) scans.delete(path)
    return found
  }

  /** The per-file scan cache of one digital human. */
  #mailboxScans(humanId: string) {
    let scans = this.#mailboxes.get(humanId)
    if (scans === undefined) {
      scans = new Map<string, MailboxScan>()
      this.#mailboxes.set(humanId, scans)
    }
    return scans
  }

  /**
   * The thread one mailbox log names, read only when the file may have changed.
   *
   * @param path - the log to read.
   * @param scans - the per-file cache this call fills.
   * @returns the thread name, or null when the log names none yet.
   */
  async #mailboxConversation(path: string, scans: Map<string, MailboxScan>) {
    let handle
    try {
      handle = await open(path, 'r')
      const stats = await handle.stat()
      const known = scans.get(path)
      if (known && known.mtimeMs === stats.mtimeMs && known.size === stats.size) {
        return known.conversation
      }
      // A thread name is fixed once it is known: rewriting the log cannot move its
      // Session to another requirement.
      if (known?.conversation) {
        scans.set(path, { ...known, mtimeMs: stats.mtimeMs, size: stats.size })
        return known.conversation
      }
      const conversation = await this.#threadIn(handle)
      scans.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, conversation })
      return conversation
    } catch {
      // A log that cannot be opened or read says nothing; the other logs still do.
      scans.delete(path)
      return null
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  /**
   * Read one log far enough to find its thread name.
   *
   * The log is read in chunks and stops at the first line that names a thread, so
   * the size a mailbox reaches does not decide the cost of a tree read. A line that
   * a chunk edge splits is joined before it is parsed; a line that is not JSON, and
   * a line still being written, are skipped.
   */
  async #threadIn(handle: FileHandle): Promise<string | null> {
    const decoder = new StringDecoder('utf8')
    const buffer = Buffer.alloc(MAILBOX_CHUNK)
    let position = 0
    let carry = ''
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      position += bytesRead
      // The decoder keeps a UTF-8 sequence that a chunk edge splits, and `carry`
      // keeps a line that the edge splits, so neither is lost or parsed half.
      const lines = (carry + decoder.write(buffer.subarray(0, bytesRead))).split('\n')
      carry = lines.pop() as string
      for (const line of lines) {
        const conversation = conversationOf(line)
        if (conversation !== null) return conversation
      }
    }
    return null
  }

  /**
   * Map a Session back to the digital human and conversation that own it.
   *
   * The in-memory map only covers Sessions this process has already delivered
   * into; after a restart, or on the very first assembly of a reused Session, it
   * is empty. A caller that knows which record it is asking about passes the id,
   * and the persisted index answers instead of falling back to a default thread.
   */
  ownerOf(sessionId, humanId?: string) {
    const known = this.#bySession.get(sessionId)
    if (known !== undefined || typeof humanId !== 'string') return known
    const index = this.#indexSync(humanId)
    for (const [conversationId, value] of Object.entries(index)) {
      if (value !== sessionId) continue
      const owner = { humanId, conversationId }
      this.#bySession.set(sessionId, owner)
      return owner
    }
    return undefined
  }

  /** Read one record's session index without waiting, for a synchronous caller. */
  #indexSync(humanId) {
    if (this.#indexes.has(humanId)) return this.#indexes.get(humanId)
    const path = this.#store.sessionIndexPath(humanId)
    let index = {}
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        if (parsed && typeof parsed === 'object') index = parsed
      } catch (error) {
        this.#log(`session index unreadable for ${humanId}: ${error.message}`)
      }
    }
    this.#indexes.set(humanId, index)
    return index
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
    // Edges are what a restart would otherwise lose: the name index says what a
    // thread is called, the edges say which Sessions actually talked on it.
    for (const human of humans) await this.#loadEdges(human)
  }

  /**
   * Recognise a Session as one digital human's, at the moment an event names it.
   *
   * `prime` is the normal path, but a Host that restarted while the reverse index was
   * empty would otherwise drop every event for that Session: no mailbox entry, no turn
   * boundary, and an in-progress work item that never closes. The Session header names
   * the preset, which names the record; the name index says which thread it belongs to.
   * Recovering the mapping here keeps one missed startup read from silencing a record.
   */
  async adopt(sessionId, humanId): Promise<{ humanId: string; conversationId: string }> {
    const known = await this.#conversationOf(humanId, sessionId)
    const entry = { humanId, conversationId: known ?? sessionId }
    this.#bySession.set(sessionId, entry)
    return entry
  }

  /** Read one human's edge log back into memory. */
  async #loadEdges(human: Human) {
    const path = this.#store.edgePath(human.id)
    if (!existsSync(path)) return
    try {
      const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
      const list: PeerEdge[] = []
      for (const line of lines) {
        try {
          const entry = JSON.parse(line)
          if (entry && typeof entry.selfSession === 'string'
            && typeof entry.peer === 'string' && typeof entry.peerSession === 'string') {
            list.push(entry)
          }
        } catch {
          this.#log(`skipped malformed edge line in ${path}`)
        }
      }
      this.#edges.set(human.id, list)
    } catch (error) {
      this.#log(`edges unreadable for ${human.id}: ${error.message}`)
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
        return this.#remember(human.id, conversationId, await this.#adopt(human, existing, presetId, conversationId))
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
    // The id is passed through: an address that does not exist yet still gets created
    // under it, so the caller's record of it stays true.
    return this.#remember(human.id, conversationId, await this.#create(human, presetId, existing, conversationId))
  }

  /**
   * Resolve one address to the Session it names.
   *
   * The address carries either a conversation name — the old form — or a DSH
   * Session id, which is what a peer message reports so its reply can land in the
   * Session that asked for the work. A Session id is adopted as given; a name goes
   * through the index, and either way a Session that cannot be reused is replaced.
   *
   * A sender may name the thread too, but naming it does not move it: the name is
   * a label, and a Session that merely received a message is not its owner. The
   * delivery still goes to the addressed Session, and the thread's name keeps
   * pointing where it pointed — otherwise a chat window a message happened to land
   * in would take the thread over.
   *
   * @returns the Session id and the conversation name it belongs to, if any.
   */
  async #resolve(human, { conversationId, sessionId }, presetId) {
    const text = String(sessionId ?? conversationId ?? '').trim()
    if (isSessionAddress(text)) {
      // "Passed an id that exists → use it; passed one that does not → a new one."
      const named = conversationId === undefined ? undefined : requireConversation(conversationId)
      let resolved
      try {
        resolved = await this.#adopt(human, text, presetId, named)
      } catch (error) {
        this.#log(
          `session ${text} could not receive for ${human.id} (${error.message}); opening a new one`,
        )
        resolved = await this.#create(human, presetId, text, named)
      }
      const conversation = named ?? (await this.#conversationOf(human.id, resolved)) ?? resolved
      // The reverse entry is needed even though nothing was filed: without it this
      // Session's own replies would not reach a mailbox, and it would be invisible to
      // a caller asking which Sessions this digital human answers in.
      this.#bySession.set(resolved, { humanId: human.id, conversationId: conversation })
      return { sessionId: resolved, conversation }
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

  /**
   * Adopt one Session by id, or fail when it cannot carry this record.
   *
   * `create` is not adoption. Since Host 0.2.1 a named Session that has already
   * started a turn is left as it is, and a fresh one is minted instead — the call
   * returns the *new* id, so adopting through it split every conversation that had
   * work in it into a second Session with its own context. Resume is what `prompt`
   * does anyway; this only has to fail early, before a message lands somewhere else.
   */
  async #adopt(human, sessionId, presetId, conversation) {
    const resolved = await this.#resume(sessionId)
    // No resolution entry point: the Host cannot say, and `prompt` still resumes the
    // Session. A genuinely unknown id fails there rather than being silently replaced.
    if (resolved === undefined) return sessionId
    const header = resolved?.agent?.session?.header
    const wanted = this.#cwdOf(human, conversation)
    if (wanted !== undefined && header?.cwd !== undefined && header.cwd !== wanted) {
      throw new Error(`session "${sessionId}" runs in "${header.cwd}", not "${wanted}"`)
    }
    if (presetId !== undefined && header?.agentPreset !== undefined && header.agentPreset !== presetId) {
      throw new Error(`session "${sessionId}" runs preset "${header.agentPreset}", not "${presetId}"`)
    }
    return sessionId
  }

  /**
   * Resume one Session, reporting an id this Host cannot resolve as an error.
   * @returns the resolved Agent; `undefined` when the controller has no resolver.
   */
  async #resume(sessionId) {
    const controller = this.#ctx.sessionController
    if (typeof controller?.resolveAgent !== 'function') return undefined
    const resolved = await controller.resolveAgent(sessionId)
    if (resolved?.error !== undefined) {
      throw new Error(resolved.error?.message ?? String(resolved.error))
    }
    return resolved
  }

  /**
   * Open a Session for this record.
   *
   * A named id is passed through, so an address the caller invented still holds when
   * the Session does not exist yet. When it does exist and cannot be reused, the Host
   * mints a different id; the caller sees the returned one.
   */
  async #create(human, presetId, sessionId, conversation) {
    const location = this.#location(human, conversation)
    // The Host creates a Workspace's directory for it, but a requirement directory
    // is ours: without this the first turn would start in a cwd that does not exist.
    if (location.cwd && human.sessionWorkspace === 'requirement') {
      await mkdir(location.cwd, { recursive: true })
      // A directory created here is not in the Workspace roster, and the UI groups
      // by id: registering it (and passing the id instead of the cwd) is what puts
      // the requirement's Sessions under their own entry in the menu.
      const workspaceId = await this.#ensureWorkspace?.(location.cwd, conversation)
      if (workspaceId !== undefined) {
        delete location.cwd
        location.workspaceId = workspaceId
      }
    }
    const created = await this.#ctx.sessionController.create({
      ...(sessionId ? { sessionId } : {}),
      ...location,
      ...(presetId ? { agentPreset: presetId } : {}),
    })
    // A different id is legal here — a Session that cannot be reused is replaced —
    // but it must not be silent: the caller's record of the address just changed.
    if (sessionId && created.sessionId !== sessionId) {
      this.#log(`session ${sessionId} could not carry ${human.id}; the Host opened ${created.sessionId}`)
    }
    // The Session's first turn assembles its prompt before the mailbox is written,
    // so the reverse index must know this thread now: otherwise the memory context
    // cannot name the requirement and falls back to the default file.
    if (typeof conversation === 'string' && conversation !== '') {
      this.#bySession.set(created.sessionId, { humanId: human.id, conversationId: conversation })
    }
    this.#fresh.add(created.sessionId)
    return created.sessionId
  }

  /**
   * Where the Session runs.
   *
   * A record-scoped Session is filed by Workspace id, which is what the UI groups
   * by, and is passed *instead of* `cwd`: the Host resolves the directory from the
   * Workspace and rejects a request that names both. A requirement-scoped Session
   * must pass `cwd` alone, because its directory is under the Workspace but is not
   * the Workspace itself.
   */
  #location(human, conversation) {
    const base = human.workspace || this.#defaultWorkspacePath?.() || undefined
    if (human.sessionWorkspace === 'requirement' && base) {
      const slug = conversationSlug(conversation)
      // No conversation (a direct Session address) keeps the old location: there is
      // no thread to name a directory after, and inventing one would split it later.
      if (slug) return { cwd: join(base, 'reqs', slug) }
    }
    const workspaceId = base ? this.#workspaceIdOf?.(base) : undefined
    if (workspaceId) return { workspaceId }
    return base ? { cwd: base } : {}
  }

  /**
   * The directory one conversation's Session must run in.
   *
   * Used only to decide whether a recorded Session can still carry the record.
   * It mirrors {@link #location}: a requirement record compares the per-thread
   * directory, and every other record compares the workspace it always did.
   */
  #cwdOf(human, conversation) {
    const base = human.workspace || this.#defaultWorkspacePath?.() || undefined
    if (human.sessionWorkspace === 'requirement' && base) {
      const slug = conversationSlug(conversation)
      if (slug) return join(base, 'reqs', slug)
    }
    return base
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
    { conversationId, sessionId, message, from = 'user', fromSession, presetId, deliveryMode }: {
      conversationId?: string
      sessionId?: string
      message?: string
      from?: string
      fromSession?: string
      presetId?: string
      deliveryMode?: 'steer' | 'queue'
    } = {},
  ) {
    if (!human.enabled) throw new Error(`digital human "${human.id}" is disabled`)
    const text = String(message ?? '').trim()
    if (!text) throw new Error('message must not be empty')
    if (text.length > MESSAGE_MAX_CHARS) throw new Error(`message exceeds ${MESSAGE_MAX_CHARS} characters`)
    const single = human.sessionMode === 'single'
    // A shared-session record ignores the thread name when choosing its Session; the
    // name still rides the message, so both sides keep the subject's label.
    const label = single ? (String(conversationId ?? '').trim() || DEFAULT_CONVERSATION) : conversationId
    const target = await this.#resolve(human, {
      conversationId: single && sessionId === undefined ? DEFAULT_CONVERSATION : conversationId,
      sessionId,
    }, presetId)
    const conversation = single ? label : target.conversation
    // Name a conversation the moment it opens: only a peer-only record (no bot of
    // its own) is named from the message, because a front-of-house record names its
    // own session from the IM source and would lose that here. A shared-session
    // record is named after itself: its one Session is the record, not a subject.
    if (this.#fresh.delete(target.sessionId)) {
      // One requirement holds one Session per role, and the sidebar lists them flat
      // inside the requirement's Workspace: the role has to be readable from the
      // title, or four Sessions look alike.
      if (single) await this.#setTitle(target.sessionId, human.name)
      // A bot-less record serves requirement threads, not one chat: its Sessions
      // are told apart by the custom tree, so the title names the role. An
      // IM-bound record keeps naming the person it is talking to.
      else if (!human.im?.botId) await this.#setTitle(target.sessionId, human.name)
    }
    await this.#append(human.id, target.sessionId, conversation, record('inbound', {
      from,
      text,
      // The two facts a reply needs, kept with the message they belong to.
      session: fromSession,
      conversation,
    }))
    // Written before the turn starts: an answer must never outrun the record of who
    // asked. The edge names both Sessions, which the thread's name cannot.
    if (fromSession) {
      await this.noteEdge(human.id, {
        dir: 'in',
        selfSession: target.sessionId,
        peer: from,
        peerSession: fromSession,
        conversation,
      })
    }
    const accepted = await this.#ctx.sessionController.prompt({
      requestId: randomUUID(),
      sessionId: target.sessionId,
      // `steer` puts the message into the running turn, so a busy peer reads it at its
      // next step instead of after the current turn. A peer's message is news the
      // recipient wants now, not a request to queue behind the work in progress. A
      // shared-session record is different: its tasks are work items, so they queue
      // behind the turn instead of interrupting it.
      mode: single ? 'queue' : deliveryMode ?? 'steer',
      // The mailbox keeps the message as written; the model also gets the two facts
      // only the transport knows: who sent it, and which Session to answer.
      content: [{ type: 'text', text: `${peerSource(from, fromSession, conversation)}\n${text}` }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, this.#abort.signal)
    return {
      sessionId: target.sessionId,
      conversationId: conversation,
      accepted: accepted?.accepted === true,
    }
  }

  /**
   * Give one Session a readable title, once, when its conversation opens.
   *
   * A title set through `rename` is pinned by the Host: automatic generation stops,
   * which is what a requirement thread wants — its subject does not change.
   */
  async #name(sessionId, conversation, text) {
    await this.#setTitle(sessionId, sessionTitleFor(text, conversation))
  }

  /** Rename one Session, containing a failure: a title is a convenience. */
  async #setTitle(sessionId, title) {
    if (!title) return
    const rename = this.#ctx.sessionController?.rename
    if (typeof rename !== 'function') return
    try {
      await rename.call(this.#ctx.sessionController, { sessionId, title })
    } catch (error) {
      this.#log(`could not name session ${sessionId}: ${error.message}`)
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
