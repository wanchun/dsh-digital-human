/**
 * Usage reporting for one digital human.
 *
 * A report is a replay, not a ledger: every figure comes from
 * `ctx.tokenMeter.measure`, which folds the durable session log and makes no model
 * call. Nothing is cached or written, so one window always answers the same way and
 * an old report can never disagree with the log it described.
 *
 * The window selects Sessions by their last activity, while each figure still
 * covers the whole Session: the meter prices a request, not a calendar slice.
 */

/** Default window length, in days. */
export const DEFAULT_USAGE_DAYS = 7

/** Longest window a caller may ask for, in days. */
export const MAX_USAGE_DAYS = 365

const DAY_MS = 24 * 60 * 60 * 1000

/** The half-open span a report covers, in epoch milliseconds. */
export interface UsageWindow {
  since: number
  until: number
}

/** One session's share of the report. */
export interface UsageRow {
  sessionId: string
  /** Conversation the session is filed under, when the record knows one. */
  thread?: string
  tokens: number
}

/**
 * Resolve the window a call asks for.
 *
 * `days` is clamped rather than rejected: a model that writes 0 or 900 has still
 * said something useful, and the label in the answer states the window that was
 * actually used.
 */
export function usageWindow(args: { days?: unknown; since?: unknown } = {}, now: number = Date.now()): UsageWindow {
  // An explicit start is a statement, not a shorthand: a typo must fail loudly
  // rather than silently report the default week as if it were the asked one.
  const from = args.since
  if (typeof from === 'string' && from.trim()) {
    const parsed = Date.parse(from.trim())
    if (!Number.isFinite(parsed)) {
      throw new Error(`since must be an ISO 8601 date or timestamp, for example 2026-10-01; got ${JSON.stringify(from)}`)
    }
    return { since: parsed, until: now }
  }
  if (typeof from === 'number' && Number.isFinite(from)) return { since: from, until: now }
  const asked = Number(args.days)
  const days = Number.isFinite(asked)
    ? Math.min(Math.max(Math.trunc(asked), 1), MAX_USAGE_DAYS)
    : DEFAULT_USAGE_DAYS
  return { since: now - days * DAY_MS, until: now }
}

/**
 * When one Session last did anything.
 *
 * The tail event carries the time; an empty Session falls back to the time it was
 * created. Reading the tail is what the meter does too — the Session is the only
 * place that knows both.
 */
export function lastActivityOf(session: any): number | undefined {
  const tail = Number(session?.seq) - 1
  if (tail >= 0 && typeof session.eventAt === 'function') {
    const event = session.eventAt(tail)
    if (Number.isFinite(event?.time)) return event.time
  }
  const created = session?.header?.createdAt
  return Number.isFinite(created) ? created : undefined
}

/** Group a count for reading, without depending on the process locale. */
export function formatTokens(value: number): string {
  return String(Math.max(0, Math.round(Number(value) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** The calendar day a timestamp falls on, which is the resolution the label needs. */
function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Render one report as the paragraph a person reads. */
export function renderUsageReport({ name, id, window, rows, skipped = [] }: {
  name: string
  id: string
  window: UsageWindow
  rows: UsageRow[]
  skipped?: string[]
}): string {
  const span = `${day(window.since)} → ${day(window.until)}`
  const unreadable = skipped.length > 0
    ? ` ${skipped.length} session(s) could not be read: ${skipped.join(', ')}.`
    : ''
  if (rows.length === 0) {
    // A window where nothing worked and a window where nothing happened are
    // different answers, and only the second one means the record was quiet.
    return skipped.length > 0
      ? `Usage for ${name} (${id}), ${span}: no readable session in this window.${unreadable}`
      : `Usage for ${name} (${id}), ${span}: no session was active in this window.`
  }
  const total = rows.reduce((sum, row) => sum + row.tokens, 0)
  const lines = rows.map((row) => {
    const label = row.thread && row.thread !== row.sessionId ? `${row.thread} (${row.sessionId})` : row.sessionId
    return `- ${label}: ${formatTokens(row.tokens)} tokens`
  })
  return [
    `Usage for ${name} (${id}), ${span}:`,
    ...lines,
    `Total: ${formatTokens(total)} tokens across ${rows.length} session(s).${unreadable}`,
    'Each figure replays the session\'s durable log: it is an estimate of request/response pressure at that session\'s tail, not a billing record, and it covers the whole session rather than only the window. Only sessions this Host still holds live are included.',
  ].join('\n')
}
