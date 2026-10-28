/**
 * Model-facing tools of the digital-human platform.
 *
 * Two groups, matching Halo's split:
 *
 * - Chat tools (`digital_human_*`) are the DSH form of `/chat/send|status|messages`.
 *   They are registered in one digital human's preset scope, so the caller's own
 *   identity is a closure value and never has to be guessed.
 * - `notify_bot` is the DSH form of Halo's IM push. It sends through the IM bot
 *   bound to the calling digital human.
 *
 * The registry tool is registered globally by the Host plugin, because creating
 * and editing digital humans is deployment work, not digital-human work.
 */

import { requireConversation } from './chat.js'
import { archiveHistory, buildSnapshot, compactMemory, memoryPaths, renderSnapshot } from './memory.js'
import { presetIdOf } from './presets.js'
import { lastActivityOf, renderUsageReport, usageWindow } from './usage.js'
import type { UsageRow } from './usage.js'
import type { HumanPatch } from './types.js'

/** Longest a `send` call waits for the peer's turn to finish. */
const WAIT_MAX_SECONDS = 120

/**
 * How long an identical send is treated as a retry of the one before it.
 *
 * A send delivers before it reports, so a caller that sees a failure — a rejected
 * result, a dropped connection — retries a handover that already reached the peer.
 * Within this window the second call returns the first receipt instead of assigning
 * the same work twice; past it, an identical message is a new request on purpose.
 */
const DUPLICATE_WINDOW_MS = 60_000

const CONVERSATION_PARAM = {
  type: 'string',
  description: 'Conversation id that isolates one thread, for example a requirement or version name. Defaults to "main".',
}

/** Resolve a peer by id or display name, failing loud on an unknown target. */
async function resolvePeer(service, self, reference) {
  const wanted = String(reference ?? '').trim()
  if (!wanted) throw new Error('a target digital human is required')
  const peer = await service.resolve(wanted)
  if (!peer) throw new Error(`unknown digital human: ${JSON.stringify(reference)}`)
  if (peer.id === self.id) throw new Error('a digital human cannot send to itself')
  // A declared peer list is enforced when it exists. An empty one means the record
  // never restricted its correspondents, so it keeps the old open behaviour.
  const peers = Array.isArray(self.peers) ? self.peers : []
  if (peers.length > 0 && !peers.includes(peer.id)) {
    throw new Error(`${self.id} may only message ${peers.join(', ')}; ${peer.id} is not a peer`)
  }
  return peer
}

/**
 * The record a usage call names.
 *
 * Omitted means the caller itself, which is the common case and needs no id in the
 * prompt. Unlike a message, a reading may name any record the registry knows: it
 * writes nothing, and the caller can already see the roster.
 */
async function usageTarget(service, self, reference) {
  const wanted = String(reference ?? '').trim()
  if (!wanted) return self
  const found = await service.resolve(wanted)
  if (!found) throw new Error(`unknown digital human: ${JSON.stringify(reference)}`)
  return found
}

/**
 * Conversation names by Session id, for labelling the report.
 *
 * A missing name is only a plainer line: the measurement itself never depends on
 * the chat index, so an unreadable one must not turn a report into an error.
 */
async function threadNames(service, humanId) {
  const names = new Map<string, string>()
  try {
    const found = await service.chat?.addresses?.(humanId)
    for (const entry of found ?? []) {
      if (typeof entry?.sessionId === 'string' && typeof entry?.conversationId === 'string') {
        names.set(entry.sessionId, entry.conversationId)
      }
    }
  } catch {
    // The report still measures every session; only its labels stay ids.
  }
  return names
}

/**
 * The address a call about one peer should use.
 *
 * An explicit Session id wins. Otherwise the transport's edges decide: the Session
 * that last asked, then the one this Session last wrote to, then the thread's home.
 * A thread nobody has used resolves to nothing, which is what opens it.
 *
 * @returns the address to pass on, with the thread name it belongs to.
 */
async function addressOf(service, humanId, peer, { conversationId, sessionId, exec }: {
  conversationId?: string
  sessionId?: string
  exec?: unknown
}) {
  if (sessionId) return { sessionId, conversationId }
  const selfSession = callerSession(exec)
  // Without the caller's own Session there is nothing to scope an edge to, so the
  // named thread is the only address the call has.
  if (!selfSession) return { sessionId: undefined, conversationId }
  const target = await service.threadTarget?.(humanId, {
    selfSession,
    peer: peer.id,
    conversationId,
  })
  if (!target) return { sessionId: undefined, conversationId }
  return { sessionId: target.sessionId, conversationId: target.conversationId ?? conversationId }
}

/**
 * The Session the current tool call runs in.
 *
 * The Host stamps every execution with the Agent on whose behalf it runs, so a
 * digital human can report its own Session to its peer without being able to see
 * its own id — which no part of the prompt carries.
 */
function callerSession(exec) {
  const id = exec?.agent?.session?.header?.id
  return typeof id === 'string' && id ? id : undefined
}

/** What to say when an address is neither a saved target nor a deliverable chat id. */
const ADDRESS_HINT =
  'If that value is an alias, resend with the contact\'s raw chat id, or register the alias as a '
  + 'delivery target in the IM settings.'

/** A target id derived from a chat id, for registering an address seen for the first time. */
function autoTargetId(chatId: string): string {
  const tail = chatId.replace(/[^A-Za-z0-9._:@-]/g, '').slice(-8)
  return tail ? `auto-${tail}` : ''
}

/** What to do when a bot reports no addressable target. */
const WAIT_FOR_TARGET =
  'A target appears once the channel has seen a message from it, and the IM settings can name one; '
  + 'send to a target this bot reports, never to a chat id.'

/**
 * Name the targets a bot will accept.
 *
 * Read from the IM service, so it is what the channel actually answers to rather
 * than a guess at its id shape.
 */
async function targetHelp(dshIm, botId) {
  let list
  try {
    list = await dshIm.listTargets(botId)
  } catch {
    list = undefined
  }
  if (!Array.isArray(list) || list.length === 0) {
    return `Bot ${botId} reports no targets yet. ${WAIT_FOR_TARGET}`
  }
  const named = list
    .map((entry) => `${entry.targetId}${entry.name ? ` (${entry.name})` : ''}`)
    .join(', ')
  return `Targets of bot ${botId}: ${named}.`
}

/** Build the text-block renderer shared by every tool in this module. */
function renderText(value) {
  return [{ type: 'text', text: typeof value?.detail === 'string' ? value.detail : JSON.stringify(value) }]
}

/** Plain `{detail}` output shape: every tool reports one human-readable line. */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { detail: { type: 'string', required: true } },
  },
  render: (_args, value) => renderText(value),
}

/**
 * Build an object schema from the terse authoring form.
 *
 * Tools are written as `{field: {type, required?, description?}}` because that
 * reads well next to the field it describes. The tool registry enforces a subset
 * of standard JSON Schema, where `required` is an array of property names on the
 * object node — never a per-property flag. The conversion happens once, here, so
 * every tool below stays in the readable form.
 */
function objectSchema(fields: Record<string, any>) {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, field] of Object.entries(fields ?? {})) {
    const { required: isRequired, ...rest } = field ?? {}
    properties[name] = rest
    if (isRequired === true) required.push(name)
  }
  const schema: Record<string, unknown> = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) schema.required = required
  return schema
}

/** Accept either the terse field map or an already-built object schema. */
function normalizeSchema(schema) {
  if (schema?.type === 'object' && schema.properties) return objectSchema(schema.properties)
  return objectSchema(schema)
}

/** Project one authored tool into the exact shape the registry validates. */
function normalizeTool(definition) {
  return {
    ...definition,
    parameters: normalizeSchema(definition.parameters),
    output: { ...definition.output, schema: normalizeSchema(definition.output.schema) },
  }
}

/**
 * Chat and IM tools for one digital human.
 * @param options.service - the `digitalHumans` Host service.
 * @param options.humanId - the owning digital human.
 */
/**
 * Build one digital human's tool surface.
 *
 * @param options.memory - whether this record keeps a durable memory file. When
 *   it does not, the memory tools are left out: they would report an absent file
 *   and offer to archive nothing.
 * @param options.im - whether this record has a bot to push through. Without one,
 *   `notify_bot` can only fail, so the two IM tools are left out.
 */
export function buildHumanTools({ ctx, service, humanId, memory = true, im = true }) {
  const self = () => service.require(humanId)
  const botOf = async () => (await self()).im
  // Fingerprint of a send that already landed, so a retry after a failed report does
  // not assign the same work a second time.
  const recentSends = new Map<string, { at: number; value: any }>()

  const send = {
    name: 'digital_human_send',
    description:
      'Send a message to another digital human and start a turn in its conversation. '
      + 'Delivery is asynchronous, like handing over a task. Set wait_seconds to wait for its reply, '
      + 'then read it with digital_human_messages, or poll with digital_human_status. '
      + 'Omit the address to reply in the thread this Session already shares with the peer — the '
      + 'transport sends it back to the Session that asked. Pass session_id to choose a Session, '
      + 'or conversation_id to open a new thread. '
      + 'Every send is also a work item: a busy peer queues it, and a reply to its running turn '
      + 'amends the item already open. The detail says which it became.',
    parameters: {
      to: {
        required: true,
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
        description: 'Target digital human id or display name, or an array of them. '
          + 'An array assigns one independent work item per target, each with its own receipt.',
      },
      message: { type: 'string', required: true, description: 'Message body. State the task, the acceptance criteria, and how to report back.' },
      // Required here, unlike on the reading tools: a send with no address would put
      // every subject into one shared thread.
      conversation_id: {
        type: 'string',
        description: 'Conversation id that isolates one thread, for example a requirement or version name. '
          + 'Opens the thread when it is new; omit it to reply in the thread this Session is already in.',
      },
      // The other form of the same address, for answering the Session that asked.
      session_id: { type: 'string', description: 'The target Session id to deliver into, as reported by a <dsh_peer_source> block. Use this to answer the Session that asked for the work. One of session_id and conversation_id is required.' },
      wait_seconds: {
        type: 'number',
        description: `Wait up to this many seconds for the target to finish its turn, at most ${WAIT_MAX_SECONDS}. Defaults to 0 (return as soon as the message is accepted).`,
      },
      mode: {
        type: 'string',
        enum: ['new', 'amend', 'cancel'],
        description:
          'What this send means for the work item. "new" assigns a new item even when the peer is busy; '
          + '"amend" appends to the one open item of the conversation; "cancel" retires it and delivers nothing. '
          + 'Omit it to let the transport decide: busy queues a new item, a reply to the running turn amends it.',
      },
      task_id: {
        type: 'string',
        description: 'The work item to amend or cancel. Required when the conversation has more than one open item.',
      },
      note: {
        type: 'string',
        description: 'One line recorded on a new work item, visible in digital_human_status.',
      },
      deadline: {
        type: 'string',
        description: 'When this handover is due, as an ISO 8601 timestamp. Omit it to use the '
          + 'record\'s escalation window (30 minutes unless configured).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          detail: { type: 'string', required: true },
          to: { type: 'string', required: true },
          conversationId: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          accepted: { type: 'boolean', required: true },
          finished: { type: 'boolean', required: true },
          taskId: { type: 'string' },
          taskState: { type: 'string' },
          taskIntent: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                // Every per-target receipt carries its own sentence: the flat `detail`
                // above is their join, and the Host rejects any key this object does not
                // declare once `additionalProperties` is false.
                detail: { type: 'string' },
                to: { type: 'string' },
                conversationId: { type: 'string' },
                sessionId: { type: 'string' },
                accepted: { type: 'boolean' },
                finished: { type: 'boolean' },
                taskId: { type: 'string' },
                taskState: { type: 'string' },
                taskIntent: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const me = await self()
      const targets = Array.isArray(args.to) ? args.to : [args.to]
      if (targets.length === 0) throw new Error('a target digital human is required')
      // Its own Session travels with the message, so the reply can come back to the
      // Session that asked for the work rather than to a shared thread name.
      const fromSession = callerSession(exec)
      const mode = args.mode === 'new' || args.mode === 'amend' || args.mode === 'cancel' ? args.mode : undefined
      const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : undefined
      // Resolve every name and every address before delivering anything: one unknown
      // target must not leave half the recipients holding work items and the others
      // none. Order is kept, because the caller reads the receipts in the order it
      // wrote the targets.
      const addressed: Array<{ peer: any; address: any }> = []
      for (const target of targets) {
        const peer = await resolvePeer(service, me, target)
        // No address means "the thread this Session is already in": the edges say which
        // Session of the peer last asked here, and a reply goes back to it.
        const address = await addressOf(service, humanId, peer, {
          conversationId: typeof args.conversation_id === 'string' ? args.conversation_id : undefined,
          sessionId: typeof args.session_id === 'string' ? args.session_id : undefined,
          exec,
        })
        // Nothing to address and nothing to reply to: say what is missing rather than
        // pour the subject into the one shared `main` thread.
        if (address.conversationId === undefined && address.sessionId === undefined) {
          throw new Error(
            'conversation_id or session_id is required. A digital human is reached in a named '
            + 'conversation, and sending without one would put every requirement into the same '
            + 'shared thread. Use this requirement\'s conversation_id, or the session_id reported '
            + 'by the <dsh_peer_source> block of the message being answered.',
          )
        }
        addressed.push({ peer, address })
      }
      // Same targets, same thread, same words, within a minute: this is a retry of a
      // handover that already landed, not a second piece of work.
      const fingerprint = JSON.stringify([
        [...targets].sort(),
        typeof args.conversation_id === 'string' ? args.conversation_id : null,
        typeof args.session_id === 'string' ? args.session_id : null,
        mode ?? null,
        note ?? null,
        typeof args.task_id === 'string' ? args.task_id : null,
        typeof args.deadline === 'string' ? args.deadline : null,
        String(args.message ?? ''),
      ])
      const repeated = recentSends.get(fingerprint)
      if (repeated !== undefined && Date.now() - repeated.at < DUPLICATE_WINDOW_MS) {
        const seconds = Math.max(1, Math.round((Date.now() - repeated.at) / 1000))
        return {
          ...repeated.value,
          detail: `${repeated.value.detail}\n(An identical send was accepted ${seconds}s ago; it was not handed over twice.)`,
        }
      }

      /** Deliver to one peer, so each target owns its receipt and its state. */
      const deliver = async (peer, address) => {
        const delivered = await service.send(peer.id, {
          conversationId: address.conversationId,
          sessionId: address.sessionId,
          message: args.message,
          from: humanId,
          fromSession,
          ...(mode ? { mode } : {}),
          ...(typeof args.task_id === 'string' && args.task_id.trim() ? { taskId: args.task_id.trim() } : {}),
          ...(note ? { note } : {}),
          ...(typeof args.deadline === 'string' && args.deadline.trim() ? { deadline: args.deadline.trim() } : {}),
        })
        const receipt = delivered.task
        // A cancellation retires the item; there is nothing to route or to wait for.
        if (receipt?.intent === 'cancel') {
          return {
            detail: `Cancelled work item ${receipt.id} for ${peer.name} (${peer.id}); nothing was delivered.`,
            to: peer.id,
            conversationId: delivered.conversationId,
            sessionId: delivered.sessionId ?? '',
            accepted: false,
            finished: false,
            taskId: receipt.id,
            taskState: receipt.state,
            taskIntent: receipt.intent,
          }
        }
        // An outbound edge lets this Session find the thread again. The peer's name index
        // is not touched: neither side has to rewrite a label to keep routing true.
        if (fromSession && delivered.sessionId) {
          await service.noteEdge?.(humanId, {
            dir: 'out',
            selfSession: fromSession,
            peer: peer.id,
            peerSession: delivered.sessionId,
            conversation: delivered.conversationId,
          })
        }
        const wait = Math.min(Math.max(Number(args.wait_seconds) || 0, 0), WAIT_MAX_SECONDS)
        let finished = false
        // A queued item runs after the turn in front of it, so waiting here could only
        // report that turn — never the reply to this one.
        if (wait > 0 && receipt?.queued !== true) {
          const deadline = Date.now() + wait * 1000
          for (;;) {
            const state = await service.status(peer.id, delivered.sessionId ?? address.conversationId)
            if (!state.isGenerating) {
              finished = true
              break
            }
            if (Date.now() >= deadline) break
            await new Promise((resolve) => setTimeout(resolve, 2000))
          }
        }
        const taskLine = receipt
          ? receipt.intent === 'amend'
            ? ` Delivered as an amendment to ${receipt.id}.`
            : receipt.queued
              ? ` Queued as ${receipt.id} behind the turn in progress.`
              : ` Assigned as ${receipt.id}.`
          : ''
        return {
          detail: (finished
            ? `Delivered to ${peer.name} (${peer.id}) and its turn finished. Read the reply with digital_human_messages.`
            : `Delivered to ${peer.name} (${peer.id}). Its reply is not ready; poll with digital_human_status.`)
            + taskLine
            + ` It runs in ${delivered.sessionId}; record that id to reach the same Session again.`,
          to: peer.id,
          conversationId: delivered.conversationId,
          sessionId: delivered.sessionId,
          accepted: delivered.accepted,
          finished,
          ...(receipt ? { taskId: receipt.id, taskState: receipt.state, taskIntent: receipt.intent } : {}),
        }
      }

      const results: any[] = []
      for (const { peer, address } of addressed) results.push(await deliver(peer, address))
      const single = results.length === 1
      const first = results[0]
      const receipt = {
        detail: results.map((entry) => entry.detail).join('\n'),
        // One target keeps the flat receipt it always had. Several report per target
        // in `results`, and the flat address fields say so by staying empty.
        to: single ? first.to : results.map((entry) => entry.to).join(', '),
        conversationId: single ? first.conversationId : '',
        sessionId: single ? first.sessionId : '',
        accepted: results.every((entry) => entry.accepted),
        finished: results.every((entry) => entry.finished),
        results,
        ...(single && first.taskId
          ? { taskId: first.taskId, taskState: first.taskState, taskIntent: first.taskIntent }
          : {}),
      }
      // Keep the last minute only: the map exists for a retry storm, not as history.
      for (const [key, entry] of recentSends) {
        if (Date.now() - entry.at >= DUPLICATE_WINDOW_MS) recentSends.delete(key)
      }
      recentSends.set(fingerprint, { at: Date.now(), value: receipt })
      return receipt
    },
  }

  const status = {
    name: 'digital_human_status',
    description: 'Report whether another digital human is still working on a conversation, and the latest work item of it: its state, reason, end time, and note.',
    parameters: {
      to: { type: 'string', required: true, description: 'Target digital human id or display name.' },
      conversation_id: CONVERSATION_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          detail: { type: 'string', required: true },
          to: { type: 'string', required: true },
          conversationId: { type: 'string', required: true },
          exists: { type: 'boolean', required: true },
          isGenerating: { type: 'boolean', required: true },
          taskId: { type: 'string' },
          state: { type: 'string' },
          reason: { type: 'string' },
          endedAt: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const peer = await resolvePeer(service, await self(), args.to)
      const address = await addressOf(service, humanId, peer, {
        conversationId: args.conversation_id,
        exec,
      })
      const state = await service.status(peer.id, address.sessionId ?? address.conversationId)
      // The turn says whether someone is working; the ledger says what came of the
      // work. A failure is only visible there, long after the turn is gone.
      const conversation = state.conversationId ?? address.conversationId ?? address.sessionId
      const tasks = await service.tasks(peer.id, conversation)
      const latest = tasks[tasks.length - 1]
      const taskLine = latest
        ? ` Last work item ${latest.id}: ${latest.state}${latest.reason ? ` (${latest.reason})` : ''}`
          + `${latest.endedAt ? `, ended ${latest.endedAt}` : ''}${latest.note ? `. Note: ${latest.note}` : ''}.`
        : ''
      return {
        detail: (state.exists
          ? `${peer.name} (${peer.id}) ${state.isGenerating ? 'is still working' : 'is idle'} on conversation "${state.conversationId}".`
          : `${peer.name} (${peer.id}) has no conversation "${state.conversationId}" yet.`)
          + taskLine,
        to: peer.id,
        conversationId: state.conversationId,
        exists: state.exists,
        isGenerating: state.isGenerating,
        ...(latest
          ? {
            taskId: latest.id,
            state: latest.state,
            ...(latest.reason ? { reason: latest.reason } : {}),
            ...(latest.endedAt ? { endedAt: latest.endedAt } : {}),
            ...(latest.note ? { note: latest.note } : {}),
          }
          : {}),
      }
    },
  }

  const stop = {
    name: 'digital_human_stop',
    description: 'Stop the current turn of another digital human in one conversation. Use it to withdraw a handoff that was sent by mistake.',
    parameters: {
      to: { type: 'string', required: true, description: 'Target digital human id or display name.' },
      conversation_id: CONVERSATION_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          detail: { type: 'string', required: true },
          to: { type: 'string', required: true },
          conversationId: { type: 'string', required: true },
          stopped: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const peer = await resolvePeer(service, await self(), args.to)
      const address = await addressOf(service, humanId, peer, {
        conversationId: args.conversation_id,
        exec,
      })
      const conversationId = requireConversation(address.conversationId)
      const result = await service.stop(peer.id, address.sessionId ?? conversationId)
      return {
        detail: result.stopped
          ? `Stopped the current turn of ${peer.name} (${peer.id}) on conversation "${conversationId}".`
          : `${peer.name} (${peer.id}) had no running turn on conversation "${conversationId}".`,
        to: peer.id,
        conversationId,
        stopped: result.stopped,
      }
    },
  }

  const messages = {
    name: 'digital_human_messages',
    description: 'Read the recent messages of one conversation with another digital human. The last entry is usually its reply.',
    parameters: {
      to: { type: 'string', required: true, description: 'Target digital human id or display name.' },
      conversation_id: CONVERSATION_PARAM,
      limit: { type: 'number', description: 'How many recent messages to return. Defaults to 20.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          detail: { type: 'string', required: true },
          to: { type: 'string', required: true },
          conversationId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const peer = await resolvePeer(service, await self(), args.to)
      const address = await addressOf(service, humanId, peer, {
        conversationId: args.conversation_id,
        exec,
      })
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200)
      const read = await service.messages(peer.id, address.sessionId ?? address.conversationId, limit)
      if (read.items.length === 0) {
        return { detail: `No messages in "${read.conversationId}" with ${peer.name} (${peer.id}).`, to: peer.id, conversationId: read.conversationId }
      }
      const body = read.items
        .map((entry) => `[${entry.at}] ${entry.kind === 'outbound' ? peer.name : entry.from} → ${entry.kind === 'outbound' ? humanId : peer.name}\n${entry.text}`)
        .join('\n\n')
      return {
        detail: `Conversation "${read.conversationId}" with ${peer.name} (${peer.id}), last ${read.items.length} message(s):\n\n${body}`,
        to: peer.id,
        conversationId: read.conversationId,
      }
    },
  }

  /**
   * List the conversations already established with one peer.
   *
   * Inventing an id splits one subject across two Sessions — two contexts, two
   * histories, the same work done twice — and a caller that cannot see what exists
   * has no way to reuse it. This is the lookup that makes reuse possible.
   */
  const conversations = {
    name: 'digital_human_conversations',
    description:
      'List the conversation ids already established with another digital human. '
      + 'Check this before sending: reusing an existing conversation keeps one subject in one context, '
      + 'while a new id starts a second Session that knows nothing of the first.',
    parameters: {
      to: { type: 'string', required: true, description: 'Target digital human id or display name.' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const peer = await resolvePeer(service, await self(), args.to)
      const found = await service.chat.addresses(peer.id)
      if (found.length === 0) {
        return { detail: `No conversation with ${peer.name} (${peer.id}) yet.` }
      }
      return {
        detail: `${found.length} address(es) for ${peer.name} (${peer.id}). `
          + 'Send to one of these instead of inventing a new one:\n'
          + found.map((entry) => (entry.conversationId
            ? `- ${entry.conversationId} → ${entry.sessionId}`
            : `- (addressed by Session) ${entry.sessionId}`)).join('\n'),
      }
    },
  }

  const roster = {
    name: 'digital_human_list',
    description: 'List every digital human you can reach, with its bound IM bot and default IM target.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const me = await self()
      const all = await service.list()
      const lines = all.map((entry) => {
        const marks: string[] = []
        if (entry.id === me.id) marks.push('you')
        if (!entry.enabled) marks.push('disabled')
        if (entry.im.botId) marks.push(`bot ${entry.im.botId}`)
        if (entry.im.targetId) marks.push(`target ${entry.im.targetId}`)
        return `- ${entry.id} — ${entry.name}${marks.length ? ` (${marks.join(', ')})` : ''}`
      })
      return { detail: `Digital humans:\n${lines.join('\n')}` }
    },
  }

  /**
   * Aggregate token usage across one digital human's Sessions.
   *
   * The reading replays durable logs, so it can be asked at any time and costs no
   * model call. Nothing is written or cached: a saved usage table would be a second
   * truth that drifts from the logs it was derived from.
   */
  const usage = {
    name: 'digital_human_usage',
    description:
      'Report token usage for one digital human over a time window: the total and one line per session. '
      + 'Every figure replays the durable session log; no model is called and nothing is written. '
      + 'Defaults to you and to the last 7 days.',
    parameters: {
      days: { type: 'number', description: 'Days back to include. Defaults to 7, at most 365.' },
      since: {
        type: 'string',
        description: 'Start of the window as an ISO 8601 date or timestamp, for example 2026-10-01. Overrides days.',
      },
      to: { type: 'string', description: 'Digital human id or display name. Defaults to you.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          detail: { type: 'string', required: true },
          humanId: { type: 'string', required: true },
          since: { type: 'string', required: true },
          until: { type: 'string', required: true },
          measured: { type: 'boolean', required: true },
          sessions: { type: 'number', required: true },
          totalTokens: { type: 'number', required: true },
        },
      },
      render: (_args, value) => renderText(value),
    },
    async execute(args) {
      const target = await usageTarget(service, await self(), args.to)
      const window = usageWindow(args)
      const since = new Date(window.since).toISOString()
      const until = new Date(window.until).toISOString()
      // One shape for every answer that cannot measure: the caller still learns the
      // record and the window, and no tool call ever fails over a missing service.
      const unavailable = (detail: string) => ({
        detail, humanId: target.id, since, until, measured: false, sessions: 0, totalTokens: 0,
      })
      // A disabled record runs no Session, so there is nothing current to report;
      // saying so is the whole answer, and no measurement is attempted.
      if (target.enabled === false) {
        return unavailable(`Usage for ${target.name} (${target.id}) is not reported: the record is disabled.`)
      }
      const meter = ctx.get?.('tokenMeter')
      if (typeof meter?.measure !== 'function') {
        return unavailable('Usage is unavailable in this Host: the token meter is not mounted, so no session can be measured.')
      }
      const registry = ctx.get?.('sessions')
      if (typeof registry?.list !== 'function') {
        return unavailable('Usage is unavailable in this Host: the session registry is not mounted, so no session can be listed.')
      }
      let listed
      try {
        listed = (await registry.list()) ?? []
      } catch (error) {
        return unavailable(`Usage is unavailable in this Host: the session registry could not be read (${error.message}).`)
      }
      // A digital human's Sessions are the ones its generated preset composed, which
      // is the only mark a Session carries about whose work it holds.
      const watched = presetIdOf(target.id)
      const threads = await threadNames(service, target.id)
      const rows: UsageRow[] = []
      const skipped: string[] = []
      for (const session of listed) {
        if (session?.header?.agentPreset !== watched) continue
        const sessionId = session.header.id
        try {
          // The window decides which Sessions to read, not which events. A Session
          // that worked inside it is reported in full, and the note under the total
          // says so.
          const at = lastActivityOf(session)
          if (at !== undefined && (at < window.since || at > window.until)) continue
          rows.push({ sessionId, thread: threads.get(sessionId), tokens: meter.measure(session).totalTokens })
        } catch {
          // One unreadable log must not hide the others: name it and keep counting.
          skipped.push(sessionId)
        }
      }
      // Biggest first, so the line that matters is the one a person reads first.
      rows.sort((a, b) => b.tokens - a.tokens || a.sessionId.localeCompare(b.sessionId))
      return {
        detail: renderUsageReport({ name: target.name, id: target.id, window, rows, skipped }),
        humanId: target.id,
        since,
        until,
        measured: true,
        sessions: rows.length,
        totalTokens: rows.reduce((sum, row) => sum + row.tokens, 0),
      }
    },
  }

  /**
   * Let a front-of-house record name its own conversation.
   *
   * Only it knows both facts a title needs — which channel the person came from and
   * who they are — so the rule lives in its persona and the write happens here.
   */
  const setTitle = {
    name: 'set_session_title',
    description:
      'Rename this conversation once, right after it opens. Use it to give the session a '
      + 'readable title such as 企业微信-纯哥. A title set this way is pinned: automatic '
      + 'title generation stops for this conversation.',
    parameters: {
      title: { type: 'string', required: true, description: 'Title to show in the session list.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const sessionId = callerSession(exec)
      if (!sessionId) throw new Error('this conversation has no Session to name')
      const title = String(args.title ?? '').trim()
      if (!title) throw new Error('title must not be empty')
      const rename = ctx.sessionController?.rename
      if (typeof rename !== 'function') throw new Error('renaming is unavailable on this Host')
      await rename.call(ctx.sessionController, { sessionId, title })
      return { detail: 'Session title set to ' + title + '.' }
    },
  }

  const notify = {
    name: 'notify_bot',
    description:
      'Push a message to an IM contact (a person or a group) through the IM bot bound to you. '
      + 'Use this to report progress or results to a human, or to reach a chat that is not a digital human. '
      + '`to` is required and never defaulted: a target belongs to one conversation, so an omitted recipient is refused rather than guessed. '
      + 'Text only; use the tctp-send skill when you must attach a file, an image, or an @-mention.',
    parameters: {
      message: { type: 'string', required: true, description: 'Message text to send.' },
      to: {
        type: 'string',
        required: true,
        description: 'IM target id reported by list_bot_targets, or a raw platform chat id. '
          + 'A chat id the bot has not saved as a target is sent to directly, without saving one first.',
      },
      bot_id: { type: 'string', description: 'IM bot id. Defaults to the bot bound to you.' },
      kind: { type: 'string', enum: ['user', 'group'], description: 'Target kind used when to is a raw chat id. Defaults to user.' },
      format: { type: 'string', enum: ['plain', 'markdown'], description: 'Message format. Defaults to plain.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          detail: { type: 'string', required: true },
          botId: { type: 'string', required: true },
          targetId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => renderText(value),
    },
    async execute(args) {
      const dshIm = ctx.get('dshIm')
      if (!dshIm) throw new Error('the IM plugin is not active, so no bot can send')
      const im = await botOf()
      const botId = String(args.bot_id ?? im.botId ?? '').trim()
      const to = String(args.to ?? '').trim()
      if (!botId) throw new Error('no IM bot is bound to you and no bot_id was given')
      if (!to) {
        // No default: a record's own target belongs to one conversation, and a
        // message without an explicit recipient would be guessed into it. Fail with
        // the list, so the caller can pick or register the right one.
        throw new Error('notify_bot needs an explicit to. ' + await targetHelp(dshIm, botId))
      }
      const text = String(args.message ?? '').trim()
      if (!text) throw new Error('message must not be empty')
      const options = { format: args.format === 'markdown' ? 'markdown' : 'plain' }
      // `to` is checked against the saved targets first, and anything the bot
      // does not already report is taken as a raw platform chat id and sent to directly:
      // the IM delivery service accepts an unregistered draft target, so nobody has to
      // save a target before a message can reach that chat. An unreadable target list
      // keeps the original target-id behaviour instead of failing the send.
      let saved: string[] | null = null
      try {
        const known = await dshIm.listTargets(botId)
        if (Array.isArray(known)) saved = known.map((entry) => String(entry?.targetId ?? ''))
      } catch {
        saved = null
      }
      if (saved === null || saved.includes(to)) {
        try {
          await dshIm.send(botId, to, text, options)
        } catch (error) {
          // Fail with the options. A bare "Unknown target" leaves the model no way to
          // learn the right one.
          throw new Error(`${error.message} ${await targetHelp(dshIm, botId)} ${ADDRESS_HINT}`)
        }
        return { detail: `Sent to ${to} through bot ${botId}.`, botId, targetId: to }
      }
      const kind = args.kind === 'group' ? 'group' : 'user'
      try {
        await dshIm.send(botId, { kind, route: { chatId: to } }, text, options)
      } catch (error) {
        throw new Error(`${error.message} ${await targetHelp(dshIm, botId)} ${ADDRESS_HINT}`)
      }
      // Registering the address is a bonus, never a condition: an IM plugin without
      // the method still delivers, and a rejected registration must not turn a
      // delivered message into an error.
      const targetId = autoTargetId(to)
      let registered = ' It is not registered as a target yet; register it in the IM settings to reuse an alias.'
      if (targetId && typeof dshIm.createTarget === 'function') {
        try {
          await dshIm.createTarget(botId, { targetId, kind, route: { chatId: to } })
          registered = ` It is registered as target "${targetId}".`
        } catch {
          // Delivered is what matters; registration is a bonus.
        }
      }
      return {
        detail: `Sent to raw chat id ${to} as ${kind} through bot ${botId}.${registered}`,
        botId,
        targetId: to,
      }
    },
  }

  const targets = {
    name: 'list_bot_targets',
    description: 'List the IM targets the bot bound to you can send to. Use a target id with notify_bot.',
    parameters: {
      bot_id: { type: 'string', description: 'IM bot id. Defaults to the bot bound to you.' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const dshIm = ctx.get('dshIm')
      if (!dshIm) throw new Error('the IM plugin is not active, so no bot targets exist')
      const im = await botOf()
      const botId = String(args.bot_id ?? im.botId ?? '').trim()
      if (!botId) throw new Error('no IM bot is bound to you and no bot_id was given')
      const list = await dshIm.listTargets(botId)
      if (!Array.isArray(list) || list.length === 0) {
        return { detail: `Bot ${botId} reports no targets yet. ${WAIT_FOR_TARGET}` }
      }
      const lines = list.map((entry) => `- ${entry.targetId} — ${entry.name ?? entry.targetId} (${entry.kind ?? 'unknown'})`)
      return { detail: `Targets of bot ${botId}:\n${lines.join('\n')}` }
    },
  }

  const memoryStatus = {
    name: 'memory_status',
    description:
      'Report the structure of your own memory.md: size, headings, the bytes of each section, archives, and '
      + 'whether compaction is needed. Sections over the 16KB `# now` injection budget are marked. '
      + 'The `# now` block is already loaded into your prompt, so use this only to check structure after editing, '
      + 'or to decide whether to compact.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const me = await self()
      return { detail: renderSnapshot(buildSnapshot(memoryPaths(service.store, me.id))) }
    },
  }

  const memoryCompact = {
    name: 'memory_compact',
    description:
      'Archive memory.md into memory/<timestamp>.md. With scope "all" (the default) the whole file is '
      + 'archived and a fresh one started; with scope "history" only the `# History` entries move and '
      + '`# now` is left in place. Use "history" when the timeline is what grew, and "all" when memory_status '
      + 'reports that compaction is needed.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['all', 'history'],
        description: 'What to archive. Defaults to "all"; "history" keeps `# now` and moves only the timeline.',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const me = await self()
      const paths = memoryPaths(service.store, me.id)
      if (args.scope === 'history') {
        const archived = archiveHistory(paths, { keep: 0 })
        return {
          detail: archived
            ? `Archived ${archived.moved} \`# History\` entries to ${archived.archive}; \`# now\` is unchanged.`
            : 'There is no \`# History\` entry to archive yet.',
        }
      }
      const archived = compactMemory(paths)
      return {
        detail: archived
          ? `Archived to ${archived} and started a fresh memory.md. Read the archive and rewrite \`# now\` from it.`
          : 'There is no memory.md to archive yet.',
      }
    },
  }

  const tools: any[] = [send, status, stop, messages, conversations, roster, usage]
  // A digital human with no bot speaks to its peers only: the chat tools land in a
  // Session, while these two can only reach an IM contact. The title tool is not one
  // of them: naming a Session has nothing to do with an IM bot.
  if (im) tools.push(notify, targets)
  tools.push(setTitle)
  if (memory) tools.push(memoryStatus, memoryCompact)
  return tools.map(normalizeTool)
}

/**
 * Registry tool, registered globally. It is the conversational form of the
 * configuration page: deployment work rather than digital-human work.
 */
export function buildRegistryTool({ service }) {
  return normalizeTool({
    name: 'digital_human',
    description:
      'Manage the digital-human registry: list, show, create, update, or remove a digital human. '
      + 'A digital human is a configurable record (persona, workspace, skills, bound IM bot) and gets its own '
      + 'Agent preset named dh-<id>. Changes take effect immediately. '
      + 'Use action "create" once, then "update" to change single fields.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'show', 'create', 'update', 'remove'],
        description: 'Operation to perform.',
      },
      id: { type: 'string', description: 'Digital human id (slug). Required for show, create, update, and remove.' },
      name: { type: 'string', description: 'Display name.' },
      description: { type: 'string', description: 'One-line summary of the role.' },
      system_prompt: { type: 'string', description: 'The persona: this becomes the agent preset prefix.' },
      workspace: { type: 'string', description: 'Absolute working directory for its sessions.' },
      skills: { type: 'string', description: 'Comma-separated extra skill directories to mount.' },
      peers: { type: 'string', description: 'Comma-separated ids of digital humans it may message.' },
      bot_id: { type: 'string', description: 'IM bot id bound to it (dsh-im botId).' },
      target_id: { type: 'string', description: 'Default IM target id for notify_bot.' },
      enabled: { type: 'boolean', description: 'Whether the digital human may run. Defaults to true.' },
      memory: { type: 'boolean', description: 'Whether to give it a durable memory file. Defaults to true.' },
      icon: {
        type: 'string',
        description: 'Optional icon: a base64 data URI for png, jpeg, webp or svg+xml, at most 64KB. '
          + 'An empty string clears it. Rendered beside this human\'s session titles.',
      },
      session_mode: {
        type: 'string',
        enum: ['thread', 'single'],
        description: 'How peer conversations map to Sessions. "thread" (default) keeps one Session per '
          + 'conversation id and steers a busy turn; "single" keeps one standing Session whose tasks queue.',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const action = String(args.action ?? '')
      if (action === 'list') {
        const all = await service.list()
        if (all.length === 0) return { detail: 'No digital humans are configured.' }
        const lines = all.map((entry) => `- ${entry.id} — ${entry.name}${entry.enabled ? '' : ' (disabled)'}${entry.workspace ? ` @ ${entry.workspace}` : ''}`)
        return { detail: `Digital humans (${all.length}):\n${lines.join('\n')}` }
      }
      if (action === 'show') {
        const found = await service.resolve(args.id)
        if (!found) throw new Error(`unknown digital human: ${JSON.stringify(args.id)}`)
        return { detail: JSON.stringify(found, null, 2) }
      }
      if (action === 'remove') {
        if (!args.id) throw new Error('id is required to remove')
        const removed = await service.remove(String(args.id))
        if (!removed) throw new Error(`unknown digital human: ${JSON.stringify(args.id)}`)
        return { detail: `Removed digital human ${args.id} and unregistered its preset.` }
      }
      if (action !== 'create' && action !== 'update') {
        throw new Error(`unsupported action: ${JSON.stringify(args.action)}`)
      }
      if (!args.id) throw new Error('id is required')
      const patch: HumanPatch = { id: String(args.id) }
      for (const [key, value] of [
        ['name', args.name],
        ['description', args.description],
        ['systemPrompt', args.system_prompt],
        ['workspace', args.workspace],
      ]) {
        if (value !== undefined) patch[key] = value
      }
      if (args.skills !== undefined) patch.skills = String(args.skills).split(',').map((entry) => entry.trim()).filter(Boolean)
      if (args.peers !== undefined) patch.peers = String(args.peers).split(',').map((entry) => entry.trim()).filter(Boolean)
      if (args.bot_id !== undefined || args.target_id !== undefined) {
        patch.im = { botId: args.bot_id ?? '', targetId: args.target_id ?? '' }
      }
      if (args.enabled !== undefined) patch.enabled = args.enabled
      if (args.memory !== undefined) patch.memory = args.memory
      if (args.session_mode !== undefined) patch.sessionMode = args.session_mode === 'single' ? 'single' : 'thread'
      if (args.icon !== undefined) patch.icon = String(args.icon)
      const saved = await service.upsert(patch, { partial: action === 'update' })
      return {
        detail: `${action === 'create' ? 'Created' : 'Updated'} digital human ${saved.id} (${saved.name}); preset ${saved.presetId}.`,
      }
    },
  })
}
