/**
 * Lift the peer source block out of a message body and into a message of its own.
 *
 * A delivery carries two facts only the transport knows — who sent the message and
 * which conversation it arrived in — and writes them ahead of the body. Left inside
 * the body, the block is rendered as the message text, so the reader sees an XML tag
 * where a person's words belong. The Host already folds any user message whose
 * `source.kind` is not `user` into one context row, so moving the block into such a
 * message is the whole fix: the model still reads the same text, in the same order,
 * and the transcript no longer claims the sender typed it.
 *
 * Only `<dsh_peer_source>` is recognised. The IM channel has its own splitter for
 * `<dsh_im_source>` and would otherwise see this plugin's block as its own (or the
 * other way round), splitting the same text twice.
 */

import { randomUUID } from 'node:crypto'

/** The open of the block this plugin writes into a peer message. */
const TAG_OPEN = '<dsh_peer_source'

/** A message that opens with that block: one self-closing tag, then its body. */
const TAG = new RegExp(`^${TAG_OPEN}\\b[^>]*\\/>`)

/** Name under which the lifted block is presented. */
const NOTICE_KIND = 'plugin:digital-human'

/** Longest summary the Host accepts on a `notice` source. */
const SUMMARY_MAX_CHARS = 120

/** The attributes a peer source block may carry. */
interface PeerSourceFields {
  from?: string
  session?: string
  conversation?: string
  [name: string]: string | undefined
}

/** One lifted block, with whatever of the message body remains. */
interface Lift {
  header: string
  fields: PeerSourceFields
  content: unknown[]
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
 *
 * @param from - the sender's registry id.
 * @param fromSession - the sender's Session id, when the delivery knows it.
 * @param conversationId - the thread the message arrived in.
 * @returns one self-closing tag, on its own first line once the caller adds a newline.
 */
export function peerSource(from: string, fromSession: string | undefined, conversationId: string): string {
  // Every value is already constrained: the conversation id by CONVERSATION, the
  // sender by the registry's id rule, the Session id by the Host. None can break
  // out of its attribute.
  //
  // `session` is the one that matters for a reply: it names the Sender's own
  // Session, so the reply lands in the Session that asked for the work rather than
  // in whichever Session the conversation name happens to be bound to.
  const session = fromSession ? ` session="${fromSession}"` : ''
  return `${TAG_OPEN} from="${from}"${session} conversation="${conversationId}" />`
}

/**
 * Read the attributes of one self-closing tag.
 *
 * Every value this plugin writes is already constrained (the conversation id by its
 * rule, the sender by the registry, the Session id by the Host), so there is nothing
 * to unescape — but a foreign block is read the same way rather than trusted.
 */
function attributesOf(header: string): PeerSourceFields {
  const fields: PeerSourceFields = {}
  for (const match of header.matchAll(/([A-Za-z][\w-]*)\s*=\s*"([^"]*)"/g)) {
    fields[match[1]] = match[2]
  }
  return fields
}

/**
 * The one line a folded row shows.
 *
 * The sender's display name is the registry's, when this host knows the record; the
 * id the block carries is the fallback, because a row that names nothing is worse
 * than one that names the sender opaquely. Bounded because the Host rejects a
 * longer summary outright, which would cost the whole notice.
 */
function summaryOf(fields: PeerSourceFields, nameOf?: (id: string) => string | undefined): string {
  const from = fields.from ?? ''
  const name = from ? nameOf?.(from) || from : ''
  const parts: string[] = []
  if (name) parts.push(`来自 ${name}`)
  if (fields.conversation) parts.push(`会话 ${fields.conversation}`)
  return (parts.join(' · ') || '来自对等会话').slice(0, SUMMARY_MAX_CHARS)
}

/**
 * Take the leading block off one message, or return null when it carries none.
 *
 * The block must start the content, at offset 0. A tag mentioned mid-sentence is
 * prose — a peer quoting the convention, say — and rewriting that would corrupt the
 * message instead of tidying it.
 */
function lift(message: any): Lift | null {
  if (message?.role !== 'user') return null
  // A notice of our own is the block already. Lifting it again would leave an empty
  // message, and the Host folds it either way, so there is nothing to gain.
  if (message.source !== undefined && message.source?.kind !== 'user') return null
  const content = message.content
  if (!Array.isArray(content)) return null
  const first = content[0]
  if (first?.type !== 'text' || typeof first.text !== 'string') return null
  const match = TAG.exec(first.text)
  if (!match) return null
  const header = match[0]
  // The delivery writes the block and the body in one part, one newline apart:
  // drop that newline, so the body starts where the sender's words did.
  const rest = first.text.slice(header.length).replace(/^\r?\n/, '')
  // A message with nothing left is never rewritten: keeping a slightly ugly body
  // beats dropping what a peer took the trouble to send.
  if (rest.trim() === '') return null
  return { header, fields: attributesOf(header), content: [{ ...first, text: rest }, ...content.slice(1)] }
}

/**
 * Replace every peer message that opens with a source block by a clean body plus a
 * separate notice.
 *
 * @param messages - the batch entering one step.
 * @param options - `nameOf` resolves a sender id to its display name; `newId` mints
 * the notice's id, injectable so a test can pin it.
 * @returns the rewritten batch, or null when no message carried a block — the caller
 * then keeps the original decision untouched.
 */
export function splitPeerSourceMessages(
  messages: unknown,
  options: { nameOf?: (id: string) => string | undefined; newId?: () => string } = {},
): any[] | null {
  if (!Array.isArray(messages)) return null
  const newId = options.newId ?? (() => randomUUID())
  const rewritten: any[] = []
  let changed = false
  for (const message of messages) {
    const lifted = lift(message)
    if (lifted === null) {
      // Unchanged messages go back as the same objects, in the same places: a
      // consumer that matches a claimed message by identity must not lose it.
      rewritten.push(message)
      continue
    }
    changed = true
    // Before the body, so the model reads the sender first — the order the single
    // part it replaces had.
    rewritten.push({
      id: newId(),
      role: 'user',
      source: {
        kind: NOTICE_KIND,
        form: 'notice',
        summary: summaryOf(lifted.fields, options.nameOf),
      },
      content: [{ type: 'text', text: lifted.header }],
    })
    rewritten.push({ ...message, content: lifted.content })
  }
  return changed ? rewritten : null
}
