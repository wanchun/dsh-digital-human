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
import { buildSnapshot, compactMemory, memoryPaths, renderSnapshot } from './memory.js'
import type { HumanPatch } from './types.js'

/** Longest a `send` call waits for the peer's turn to finish. */
const WAIT_MAX_SECONDS = 120

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
  return peer
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
 */
export function buildHumanTools({ ctx, service, humanId, memory = true }) {
  const self = () => service.require(humanId)
  const botOf = async () => (await self()).im

  const send = {
    name: 'digital_human_send',
    description:
      'Send a message to another digital human and start a turn in its conversation. '
      + 'Delivery is asynchronous, like handing over a task. Set wait_seconds to wait for its reply, '
      + 'then read it with digital_human_messages, or poll with digital_human_status.',
    parameters: {
      to: { type: 'string', required: true, description: 'Target digital human id or display name.' },
      message: { type: 'string', required: true, description: 'Message body. State the task, the acceptance criteria, and how to report back.' },
      // Required here, unlike on the reading tools: a send with no address would put
      // every subject into one shared thread.
      conversation_id: {
        type: 'string',
        description: 'Conversation id that isolates one thread, for example a requirement or version name. '
          + 'Required unless session_id is given.',
      },
      // The other form of the same address, for answering the Session that asked.
      session_id: { type: 'string', description: 'The target Session id to deliver into, as reported by a <dsh_peer_source> block. Use this to answer the Session that asked for the work. One of session_id and conversation_id is required.' },
      wait_seconds: {
        type: 'number',
        description: `Wait up to this many seconds for the target to finish its turn, at most ${WAIT_MAX_SECONDS}. Defaults to 0 (return as soon as the message is accepted).`,
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
        },
      },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const peer = await resolvePeer(service, await self(), args.to)
      const conversationId = args.conversation_id
      const sessionId = typeof args.session_id === 'string' ? args.session_id : undefined
      // Omitting both would pour every subject into one shared `main` thread, which is
      // silent and permanent. An explicit `conversation_id: "main"` still works; a
      // missing address does not.
      if (typeof conversationId !== 'string' && !sessionId) {
        throw new Error(
          'conversation_id or session_id is required. A digital human is reached in a named '
          + 'conversation, and sending without one would put every requirement into the same '
          + 'shared thread. Use this requirement\'s conversation_id, or the session_id reported '
          + 'by the <dsh_peer_source> block of the message being answered.',
        )
      }
      const delivered = await service.send(peer.id, {
        conversationId,
        sessionId,
        message: args.message,
        from: humanId,
        // Its own Session travels with the message, so the reply can come back to the
        // Session that asked for the work rather than to a shared thread name.
        fromSession: callerSession(exec),
      })
      const wait = Math.min(Math.max(Number(args.wait_seconds) || 0, 0), WAIT_MAX_SECONDS)
      let finished = false
      if (wait > 0) {
        const deadline = Date.now() + wait * 1000
        for (;;) {
          const state = await service.status(peer.id, conversationId)
          if (!state.isGenerating) {
            finished = true
            break
          }
          if (Date.now() >= deadline) break
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
      return {
        detail: (finished
          ? `Delivered to ${peer.name} (${peer.id}) and its turn finished. Read the reply with digital_human_messages.`
          : `Delivered to ${peer.name} (${peer.id}). Its reply is not ready; poll with digital_human_status.`)
          + ` It runs in ${delivered.sessionId}; record that id to reach the same Session again.`,
        to: peer.id,
        conversationId: delivered.conversationId,
        sessionId: delivered.sessionId,
        accepted: delivered.accepted,
        finished,
      }
    },
  }

  const status = {
    name: 'digital_human_status',
    description: 'Report whether another digital human is still working on a conversation.',
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
        },
      },
      render: (_args, value) => renderText(value),
    },
    async execute(args) {
      const peer = await resolvePeer(service, await self(), args.to)
      const state = await service.status(peer.id, args.conversation_id)
      return {
        detail: state.exists
          ? `${peer.name} (${peer.id}) ${state.isGenerating ? 'is still working' : 'is idle'} on conversation "${state.conversationId}".`
          : `${peer.name} (${peer.id}) has no conversation "${state.conversationId}" yet.`,
        to: peer.id,
        conversationId: state.conversationId,
        exists: state.exists,
        isGenerating: state.isGenerating,
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
    async execute(args) {
      const peer = await resolvePeer(service, await self(), args.to)
      const conversationId = requireConversation(args.conversation_id)
      const result = await service.stop(peer.id, conversationId)
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
    async execute(args) {
      const peer = await resolvePeer(service, await self(), args.to)
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200)
      const read = await service.messages(peer.id, args.conversation_id, limit)
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

  const notify = {
    name: 'notify_bot',
    description:
      'Push a message to an IM contact (a person or a group) through the IM bot bound to you. '
      + 'Use this to report progress or results to a human, or to reach a chat that is not a digital human. '
      + 'Defaults to your configured target. Text only; use the tctp-send skill when you must attach a file, an image, or an @-mention.',
    parameters: {
      message: { type: 'string', required: true, description: 'Message text to send.' },
      to: { type: 'string', description: 'IM target id. Defaults to the target configured on you.' },
      bot_id: { type: 'string', description: 'IM bot id. Defaults to the bot bound to you.' },
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
      const targetId = String(args.to ?? im.targetId ?? '').trim()
      if (!botId) throw new Error('no IM bot is bound to you and no bot_id was given')
      if (!targetId) throw new Error('no IM target is configured on you and no to was given')
      const text = String(args.message ?? '').trim()
      if (!text) throw new Error('message must not be empty')
      try {
        await dshIm.send(botId, targetId, text, { format: args.format === 'markdown' ? 'markdown' : 'plain' })
      } catch (error) {
        // Fail with the options. A bare "Unknown target" leaves the model no way to
        // learn the right one, and a chat id is not a target: the IM plugin
        // addresses targets by the names it reports, not by the chat's own id.
        throw new Error(`${error.message} ${await targetHelp(dshIm, botId)}`)
      }
      return { detail: `Sent to ${targetId} through bot ${botId}.`, botId, targetId }
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
      'Report the structure of your own memory.md: size, headings, archives, and whether compaction is needed. '
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
      'Archive your memory.md into memory/<timestamp>.md and start a fresh one. '
      + 'Call this only when memory_status reports that compaction is needed, then rewrite `# now` from the archive.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const me = await self()
      const archived = compactMemory(memoryPaths(service.store, me.id))
      return {
        detail: archived
          ? `Archived to ${archived} and started a fresh memory.md. Read the archive and rewrite \`# now\` from it.`
          : 'There is no memory.md to archive yet.',
      }
    },
  }

  const tools = [send, status, stop, messages, conversations, roster, notify, targets]
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
      const saved = await service.upsert(patch, { partial: action === 'update' })
      return {
        detail: `${action === 'create' ? 'Created' : 'Updated'} digital human ${saved.id} (${saved.name}); preset ${saved.presetId}.`,
      }
    },
  })
}
