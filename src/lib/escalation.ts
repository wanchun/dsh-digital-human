/**
 * Escalation policy: when a work item has to reach a person, and what that message says.
 *
 * A digital human works without a person watching, so the states a person must see are
 * exactly the ones that stopped the work — `failed` and `blocked`. A completed,
 * cancelled, or superseded item is not news: its receipt is already on the ledger for
 * the peer that assigned it.
 *
 * The message carries three facts and nothing else. Logs, transcripts, and product
 * detail belong to the ledger; a chat message is not a debugging channel, and an owner
 * who has to read a wall of text will stop reading escalations altogether.
 */

import type { TaskRow, TaskState } from './ledger.js'

/** Minutes a handover may run before it is due, when nothing configures a value. */
export const DEFAULT_DEADLINE_MINUTES = 30

/**
 * How long one conversation's next escalation is folded into its previous message.
 *
 * Five minutes is the shortest window that covers a burst of failures from one broken
 * handover without making a genuinely new problem wait for its own notification.
 */
export const ESCALATION_MERGE_MS = 5 * 60 * 1000

/** The states a person has to hear about. Everything else is not an escalation. */
export function escalates(state: TaskState): boolean {
  return state === 'failed' || state === 'blocked'
}

/** One item's line: which item and thread, what state, and one reason line. */
export function escalationLine(task: TaskRow): string {
  const reason = task.reason ? `，原因 ${task.reason}` : ''
  return `工作项 ${task.id}（${task.conversation}）：${task.state}${reason}`
}

/** The whole message: one line per item, so a burst from one thread reads as one event. */
export function escalationText(tasks: TaskRow[]): string {
  return tasks.map(escalationLine).join('\n')
}

/**
 * Whether the escalation sent at `lastAt` still covers this conversation.
 *
 * A missing or unreadable timestamp never folds: sending one message too many is
 * better than dropping an escalation because a clock could not be compared.
 */
export function foldedInto(lastAt: string | undefined, now: Date): boolean {
  if (lastAt === undefined) return false
  const at = Date.parse(lastAt)
  return Number.isFinite(at) && now.getTime() - at < ESCALATION_MERGE_MS
}

/** When a new work item is due, counted from now. */
export function deadlineIn(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString()
}
