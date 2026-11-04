/**
 * One path-segment rule shared by the requirement directory and session memory.
 *
 * A conversation id is a label chosen by a persona, not a filename. It may carry
 * spaces or a colon, so the rule here is deliberately lossy: anything outside the
 * safe set becomes `-`, and a value that could still walk out of its parent is
 * refused outright rather than silently rewritten. The two callers must agree on
 * the result, or a Session's cwd and its memory file would name different threads.
 */

/** Characters a path segment may keep. */
const SAFE = /[^A-Za-z0-9._-]/g

/**
 * Turn one conversation id into a safe, stable path segment.
 *
 * @param value - the conversation id, as a caller wrote it.
 * @returns the segment, or '' when the value is blank (the caller then keeps its
 *   old behaviour).
 * @throws when the value contains `..`, which is the only remaining way a
 *   segment could leave the directory it is joined under.
 */
export function conversationSlug(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (text.includes('..')) {
    throw new Error(`conversation must not contain "..": ${JSON.stringify(value)}`)
  }
  return text.replace(SAFE, '-')
}
