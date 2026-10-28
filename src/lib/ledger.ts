/**
 * The work-item ledger: one append-only JSONL file per digital human.
 *
 * A work item is a ledger row, not a message and not a conversation. Every state
 * change appends the row again, so the file is the whole history and the last line
 * for an id is its current state. Nothing is rewritten: a crash mid-write can lose
 * the newest line, never the item.
 *
 * The ledger belongs to the digital human the work was assigned to. Its states are
 * driven by the Host's turn events, not by the model's own report — a turn ending
 * is the authoritative completion signal.
 */

import { appendFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { HumanStore } from './store.js'

/** Where one work item is in its life. */
export type TaskState = 'queued' | 'in_progress' | 'done' | 'failed' | 'stopped' | 'blocked' | 'cancelled'

/** The states a work item never leaves. */
const TERMINAL: TaskState[] = ['done', 'failed', 'stopped', 'blocked', 'cancelled']

/** One note appended to a running item instead of creating a second one. */
export interface TaskAmendment {
  at: string
  text: string
}

/** One work item, as a ledger line carries it. */
export interface TaskRow {
  id: string
  from: string
  to: string
  conversation: string
  state: TaskState
  createdAt: string
  owner?: string
  deadline?: string
  endedAt?: string
  reason?: string
  note?: string
  amendments?: TaskAmendment[]
  /**
   * When this item was escalated to its owner.
   *
   * Claiming writes this field before the message goes out, so a query that runs at
   * the same moment cannot escalate the same item twice.
   */
  escalatedAt?: string
}

/** What an assignment needs. The ledger fills the id, the state and the timestamps. */
export interface AssignInput {
  from: string
  conversation: string
  note?: string
  /** When the handover is due. ISO 8601; the caller supplies the default. */
  deadline?: string
}

/** How one turn ending becomes a work-item state. */
export function endStateOf(reason: any): { state: TaskState; reason: string } {
  const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
  if (kind === 'completed') return { state: 'done', reason: 'completed' }
  if (kind === 'max-tokens') return { state: 'failed', reason: 'truncated' }
  if (kind === 'error') {
    const code = reason?.error?.code
    return { state: 'failed', reason: typeof code === 'string' && code ? code : 'error' }
  }
  if (kind === 'aborted') return { state: 'stopped', reason: 'aborted' }
  if (kind === 'blocked') return { state: 'blocked', reason: 'blocked' }
  // A Host that names no reason still ended the turn, so the work is over.
  return { state: 'done', reason: 'completed' }
}

/** Whether one row is still open, in the sense that a turn may act on it. */
export function isOpen(task: TaskRow): boolean {
  return !TERMINAL.includes(task.state)
}

/** Owns every human's work-item ledger. */
export class HumanLedger {
  #store
  #log
  // One read-modify-append at a time per human: two concurrent state changes would
  // otherwise both fold the same base and each lose the other's line.
  #writes = new Map<string, Promise<unknown>>()

  constructor(store: HumanStore, log: (message: string) => void = () => {}) {
    this.#store = store
    this.#log = log
  }

  /** Run one ledger operation after the previous one for the same human finished. */
  #serial(humanId: string, work: () => Promise<unknown>): Promise<any> {
    const previous = this.#writes.get(humanId) ?? Promise.resolve()
    const next = previous.then(work, work)
    this.#writes.set(humanId, next.catch(() => {}))
    return next
  }

  /**
   * Read every work item of one human, folding repeated rows.
   *
   * Order is first appearance, which is creation order: the queue is read from it,
   * and a state change must not move an item in that order.
   */
  async list(humanId: string): Promise<TaskRow[]> {
    const path = this.#store.taskPath(humanId)
    if (!existsSync(path)) return []
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error: any) {
      this.#log(`task ledger unreadable for ${humanId}: ${error.message}`)
      return []
    }
    const order: string[] = []
    const latest = new Map<string, TaskRow>()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let entry: any
      try {
        entry = JSON.parse(line)
      } catch {
        this.#log(`skipped malformed task line in ${path}`)
        continue
      }
      if (!entry || typeof entry.id !== 'string' || typeof entry.state !== 'string') {
        this.#log(`skipped malformed task line in ${path}`)
        continue
      }
      if (!latest.has(entry.id)) order.push(entry.id)
      latest.set(entry.id, entry as TaskRow)
    }
    return order.map((id) => latest.get(id)!)
  }

  /** The work items of one conversation that a turn may still act on. */
  async open(humanId: string, conversation?: string): Promise<TaskRow[]> {
    const tasks = await this.list(humanId)
    return tasks.filter((task) => isOpen(task) && (conversation === undefined || task.conversation === conversation))
  }

  /** Append one assignment. It starts queued; a turn promotes it. */
  assign(humanId: string, { from, conversation, note, deadline }: AssignInput): Promise<TaskRow> {
    return this.#serial(humanId, async () => {
      const rows = await this.list(humanId)
      const row: TaskRow = {
        id: nextId(rows),
        from,
        to: humanId,
        conversation,
        state: 'queued',
        createdAt: new Date().toISOString(),
        ...(note === undefined ? {} : { note }),
        ...(deadline === undefined ? {} : { deadline: deadlineValue(deadline) }),
      }
      await this.#append(humanId, row)
      return row
    })
  }

  /**
   * Add a note to the one open item of a conversation.
   *
   * An amendment is an event on the item, never a second item: a reply to a
   * question that item's turn asked belongs to the same piece of work. When the
   * conversation holds more than one open item the anchor is unknown, and the
   * caller must name the one it means rather than have one guessed.
   */
  amend(humanId: string, { conversation, text, taskId }: {
    conversation: string
    text: string
    taskId?: string
  }): Promise<TaskRow> {
    const body = String(text ?? '').trim()
    if (!body) return Promise.reject(new Error('an amendment must not be empty'))
    return this.#serial(humanId, async () => {
      const open = (await this.list(humanId)).filter((task) => isOpen(task) && task.conversation === conversation)
      const target = anchor(open, conversation, taskId)
      const row: TaskRow = {
        ...target,
        amendments: [...(target.amendments ?? []), { at: new Date().toISOString(), text: body }],
      }
      await this.#append(humanId, row)
      return row
    })
  }

  /** Cancel one open item: a state transition, never a delivery. */
  cancel(humanId: string, { conversation, taskId }: {
    conversation: string
    taskId?: string
  }): Promise<TaskRow> {
    return this.#serial(humanId, async () => {
      const open = (await this.list(humanId)).filter((task) => isOpen(task) && task.conversation === conversation)
      const target = anchor(open, conversation, taskId)
      const row: TaskRow = {
        ...target,
        state: 'cancelled',
        endedAt: new Date().toISOString(),
      }
      await this.#append(humanId, row)
      return row
    })
  }

  /**
   * Promote the head of a conversation when its turn opens.
   *
   * An item already in progress keeps its owner: one conversation runs one turn at
   * a time, and a second event for that turn — or a turn someone else started in
   * the same Session — must not fork the ownership.
   */
  start(humanId: string, { conversation, sessionId }: {
    conversation: string
    sessionId: string
  }): Promise<TaskRow | undefined> {
    return this.#serial(humanId, async () => {
      const open = (await this.list(humanId)).filter((task) => isOpen(task) && task.conversation === conversation)
      const running = open.find((task) => task.state === 'in_progress')
      if (running) {
        if (running.owner === undefined) {
          const adopted: TaskRow = { ...running, owner: sessionId }
          await this.#append(humanId, adopted)
          return adopted
        }
        return running
      }
      const head = open.find((task) => task.state === 'queued')
      if (!head) return undefined
      const row: TaskRow = { ...head, state: 'in_progress', owner: sessionId }
      await this.#append(humanId, row)
      return row
    })
  }

  /**
   * Close the item one Session owned, then hand the conversation to the queue.
   *
   * Only the owner is closed: a turn that ends says nothing about the items lined
   * up behind it. The next item starts now because the queued message is already
   * waiting in that Session, so its turn is the next thing the Host runs.
   */
  end(humanId: string, { sessionId, reason }: {
    sessionId: string
    reason?: unknown
  }): Promise<{ closed: TaskRow; next?: TaskRow } | undefined> {
    return this.#serial(humanId, async () => {
      const rows = await this.list(humanId)
      const owned = rows.filter((task) => task.state === 'in_progress' && task.owner === sessionId).at(-1)
      if (!owned) return undefined
      const closing = endStateOf(reason)
      const closed: TaskRow = {
        ...owned,
        state: closing.state,
        endedAt: new Date().toISOString(),
        reason: closing.reason,
      }
      await this.#append(humanId, closed)
      // Read the queue from the folded view with the closing row already replaced.
      const open = rows
        .map((task) => (task.id === closed.id ? closed : task))
        .filter((task) => isOpen(task) && task.conversation === closed.conversation)
      const head = open.find((task) => task.state === 'queued')
      if (!head) return { closed }
      const next: TaskRow = { ...head, state: 'in_progress', owner: sessionId }
      await this.#append(humanId, next)
      return { closed, next }
    })
  }

  /**
   * Block every open item whose deadline has passed.
   *
   * There is no timer: the check runs when someone reads the ledger or a turn ends,
   * which is exactly when the answer matters. Running it twice is harmless, because
   * only open items are considered.
   *
   * A row written before deadlines existed carries none, so its creation time plus
   * the fallback window is used — a timeout with no fallback would leave those rows
   * open forever.
   */
  timeout(humanId: string, { now, fallbackMinutes }: {
    now: Date
    fallbackMinutes: number
  }): Promise<TaskRow[]> {
    return this.#serial(humanId, async () => {
      const blocked: TaskRow[] = []
      for (const task of await this.list(humanId)) {
        if (!isOpen(task)) continue
        const due = dueAt(task, fallbackMinutes)
        if (!Number.isFinite(due) || due > now.getTime()) continue
        const row: TaskRow = {
          ...task,
          state: 'blocked',
          endedAt: now.toISOString(),
          reason: 'timeout',
        }
        await this.#append(humanId, row)
        blocked.push(row)
      }
      return blocked
    })
  }

  /**
   * Claim the items one escalation covers, at most once each.
   *
   * The claim is written before the message is sent. A repeated message reaches the
   * owner and teaches them to ignore the channel, while a message that fails to send
   * is only one lost notification. Items already claimed are left alone, so the
   * return value says exactly what this call took responsibility for.
   */
  claim(humanId: string, { taskIds, at }: { taskIds: string[]; at: string }): Promise<TaskRow[]> {
    return this.#serial(humanId, async () => {
      const wanted = new Set(taskIds)
      const claimed: TaskRow[] = []
      for (const task of await this.list(humanId)) {
        if (!wanted.has(task.id) || task.escalatedAt !== undefined) continue
        const row: TaskRow = { ...task, escalatedAt: at }
        await this.#append(humanId, row)
        claimed.push(row)
      }
      return claimed
    })
  }

  /** Settle an item whose delivery never reached its Session. */
  fail(humanId: string, { taskId, reason }: { taskId: string; reason: string }): Promise<TaskRow | undefined> {
    return this.#serial(humanId, async () => {
      const target = (await this.list(humanId)).find((task) => task.id === taskId && isOpen(task))
      if (!target) return undefined
      const row: TaskRow = { ...target, state: 'failed', endedAt: new Date().toISOString(), reason }
      await this.#append(humanId, row)
      return row
    })
  }

  /**
   * Stop items whose conversation is no longer running.
   *
   * After a restart nothing is mid-turn, so every in-progress item is a ghost: no
   * turn will ever end it. This runs once at startup and says so in the reason.
   */
  sweep(humanId: string, isIdle: (conversation: string) => Promise<boolean>): Promise<TaskRow[]> {
    return this.#serial(humanId, async () => {
      const stopped: TaskRow[] = []
      for (const task of await this.list(humanId)) {
        if (task.state !== 'in_progress') continue
        if (!(await isIdle(task.conversation))) continue
        const row: TaskRow = {
          ...task,
          state: 'stopped',
          endedAt: new Date().toISOString(),
          reason: 'restart',
        }
        await this.#append(humanId, row)
        stopped.push(row)
      }
      return stopped
    })
  }

  async #append(humanId: string, row: TaskRow): Promise<void> {
    await this.#store.ensureDir(this.#store.dir(humanId))
    await appendFile(this.#store.taskPath(humanId), `${JSON.stringify(row)}\n`, 'utf8')
  }
}

/** Validate one deadline, failing loud rather than scheduling on a value no clock can read. */
function deadlineValue(deadline: string): string {
  if (!Number.isFinite(Date.parse(deadline))) {
    throw new Error(`deadline must be an ISO 8601 timestamp: ${JSON.stringify(deadline)}`)
  }
  return deadline
}

/**
 * The moment one item is due.
 *
 * A row's own deadline wins. A row with none predates the field, so its creation
 * time plus the configured window is the only honest answer.
 */
function dueAt(task: TaskRow, fallbackMinutes: number): number {
  const own = task.deadline === undefined ? Number.NaN : Date.parse(task.deadline)
  if (Number.isFinite(own)) return own
  const created = Date.parse(task.createdAt)
  return Number.isFinite(created) ? created + fallbackMinutes * 60_000 : Number.NaN
}

/** The next free id for one ledger. Ids are stable labels, so they never shrink. */
function nextId(rows: TaskRow[]): string {
  let highest = 0
  for (const row of rows) {
    const match = /^w-(\d+)$/.exec(row.id)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return `w-${String(highest + 1).padStart(2, '0')}`
}

/** Pick the item an amendment or a cancellation means, failing loud when unclear. */
function anchor(open: TaskRow[], conversation: string, taskId?: string): TaskRow {
  if (taskId !== undefined) {
    const named = open.find((task) => task.id === taskId)
    if (!named) throw new Error(`work item ${taskId} is not open in conversation "${conversation}"`)
    return named
  }
  if (open.length === 0) throw new Error(`no open work item in conversation "${conversation}"`)
  if (open.length > 1) {
    throw new Error(
      `conversation "${conversation}" has more than one open work item; pass task_id`,
    )
  }
  return open[0]
}
