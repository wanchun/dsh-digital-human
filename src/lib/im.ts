import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Ctx } from './types.js'
/**
 * Push a digital human's mode onto its bound IM bot.
 *
 * The IM plugin keeps each bot's Workspace and Agent Preset in memory, loaded
 * once at start. Writing its `workspaces.json` therefore does not reach the
 * running plugin, and the plugin overwrites the file from stale memory on its
 * next write. Its own RPC endpoints are the only safe path, so this module calls
 * them instead.
 *
 * The endpoints live on the Connection service's shared `/api` channel, next to
 * this plugin's own route. `createSharedFetchHandler` dispatches a request that
 * has already passed authentication, so no HTTP round trip and no token is
 * needed.
 *
 * Both endpoints are optional to the caller: a headless profile has no
 * Connection, and an unbound bot has nothing to push.
 */

/** Connection channel that carries every plugin's routes. */
const SHARED_CHANNEL = '/api'

/** Endpoint that sets one bot's Workspace. */
const SET_WORKSPACE = 'bot.workspace.set'

/** Endpoint that sets one bot's Agent Preset. Accepts null to clear it. */
const SET_PRESET = 'bot.preset.set'

/**
 * Endpoint that controls the source block prefixed to every inbound message.
 *
 * The block is off by default, and without it a session never learns who is
 * writing — so a persona that classifies callers against a member table cannot
 * tell the maintainer from a stranger.
 */
const SET_CONTEXT = 'bot.context-enhancement.set'

/**
 * Fields the injected source block must carry.
 *
 * `senderName` and `senderId` identify the caller, `chatId` is what a persona
 * needs to reach them, and `conversationType` separates a direct message from a
 * group. The other two give the block its own context.
 */
const CONTEXT_FIELDS = Object.freeze([
  'channel', 'conversationType', 'senderId', 'senderName', 'chatId', 'botId',
])

/**
 * Instruction shipped with the source block.
 *
 * These are facts about the platform's own fields, nothing more. What a persona
 * does with an identified caller — which table to match it against, what
 * authority to grant, whether a stranger may be served — is that persona's
 * business, and a plugin that spelled it out here would only fit one of them.
 */
const CONTEXT_GUIDANCE = [
  '仅依据当前消息的 <dsh_im_source> 中实际提供的字段理解来源；没有提供的字段不要猜测或补全。',
  'senderId 与 senderName 是来话人身份字段；渠道实际提供哪些字段以块内出现的为准。',
  'chatId 是回复与定向通知该来话人的地址。',
].join('\n')

/**
 * The direct sender a session belongs to.
 *
 * The channel state keys every conversation as `<type>:<id>`. A direct conversation
 * names the person talking, so this is how a session is attributed to whoever reached
 * the bot. A group has no single sender, and a session IM does not map answers null.
 *
 * @param home - the registry root; the integration data sits one level up.
 * @param botId - the bound bot.
 * @param sessionId - the session to attribute.
 * @returns the sender id, or null when no direct conversation owns the session.
 */
export function directSenderOf(home: string, botId: string | undefined, sessionId: string): string | null {
  if (!botId || !sessionId) return null
  const store = channelStore(botId)
  if (!store) return null
  const file = join(dirname(home), 'integrations', store, 'bots', botId, 'state.json')
  let state: unknown
  try {
    state = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!isRecord(state) || !isRecord(state.sessions)) return null
  const wanted = sessionId.replace(/^session-/, '')
  for (const [key, value] of Object.entries(state.sessions)) {
    if (typeof value !== 'string' || value.replace(/^session-/, '') !== wanted) continue
    const senderId = key.startsWith('direct:') ? key.slice('direct:'.length).trim() : ''
    return senderId || null
  }
  return null
}

/**
 * The owner clause appended when this digital human has a claimed owner.
 *
 * The IM platform injects a fixed field set, so it can never hand the model a
 * precomputed `isOwner` flag. It does hand over the sender, and this clause
 * hands over the owner — so the model has both operands and can compare them.
 *
 * The clause stops at the comparison. How the owner is then served is the
 * persona's decision, not this plugin's.
 */
function ownerGuidance(owner: string): string {
  return [
    '',
    `本数字人的负责人是 \`${owner}\`。`,
    '当前消息的 senderId 或 senderName 等于该值时，来话人就是负责人。',
  ].join('\n')
}

/**
 * The source-block setting this plugin installs.
 *
 * IM requires exactly the keys `group` and `direct`, and each scope exactly
 * `enabled`, `fields`, and `guidance`.
 */
function contextConfig(owner?: string): Record<string, unknown> {
  const guidance = owner ? `${CONTEXT_GUIDANCE}${ownerGuidance(owner)}` : CONTEXT_GUIDANCE
  const scope = { enabled: true, fields: [...CONTEXT_FIELDS], guidance }
  return { group: { ...scope }, direct: { ...scope } }
}

/**
 * The directory one channel keeps its per-bot state in.
 *
 * A bot id carries its channel as a prefix — `wecom_571e…` belongs to `wecom` —
 * and each channel gets its own directory under the integrations root. Deriving
 * it, rather than naming a channel here, is what keeps this plugin working for
 * every channel instead of the one it was written against.
 *
 * @param botId - the bound bot.
 * @returns the directory name, or undefined when the id names no channel.
 */
function channelStore(botId: string): string | undefined {
  const channel = botId.split('_', 1)[0]
  return /^[a-z][a-z0-9-]*$/.test(channel) ? `dsh-${channel}` : undefined
}

/**
 * Every sender that has opened a direct conversation with one bot.
 *
 * Read-only, and the same file `claimOwner` reads. The IM platform never returns
 * the caller's identity when a bot is created, so this is the only place an
 * operator can learn it. A channel may also send no display name — WeCom sends
 * only `from.userid` — in which case the opaque id is the only value a persona
 * can match on.
 *
 * @param home - the registry root; the integration data sits one level up.
 * @param botId - the bound bot.
 * @returns the sender ids, in first-contact order.
 */
export function directSenders(home: string, botId?: string): string[] {
  if (!botId) return []
  const store = channelStore(botId)
  if (!store) return []
  const file = join(dirname(home), 'integrations', store, 'bots', botId, 'state.json')
  let state: unknown
  try {
    state = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  if (!isRecord(state) || !isRecord(state.sessions)) return []
  const senders: string[] = []
  for (const key of Object.keys(state.sessions)) {
    const senderId = key.startsWith('direct:') ? key.slice('direct:'.length).trim() : ''
    if (senderId) senders.push(senderId)
  }
  return senders
}

/**
 * Claim an owner from the IM integration's own session state.
 *
 * The IM platform never returns the caller's identity when a bot is created, so
 * there is nothing to configure up front. It does record a session per direct
 * conversation, keyed `direct:<senderId>` — so the first direct conversation is
 * the first person who wrote to the bot, and that is the owner by the same
 * reasoning Halo uses: a freshly created bot is visible only to its creator.
 *
 * Key order is insertion order in practice, which is what makes "first" mean
 * "first".
 *
 * @param home - the registry root; the integration data sits one level up.
 * @param botId - the bound bot, or empty for "nothing to claim".
 * @returns the claimed sender id, or undefined when there is nothing to claim.
 */
export function claimOwner(home: string, botId?: string): string | undefined {
  return directSenders(home, botId)[0]
}

/** One RPC result, or the reason the call could not be made. */
export interface ImSyncResult {
  endpoint: string
  ok: boolean
  /** Host-side failure code, when the plugin answered with an error. */
  code?: string
  /** Why the call was not attempted or did not reach the plugin. */
  reason?: string
}

/** Whether a decoded JSON value is a plain object. */
function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The RPC namespace one bot's channel is served on.
 *
 * The IM plugin mounts each channel at `/api/dsh-im<mount>`, and the bot id
 * carries its channel as a prefix — `wecom_571e…` belongs to `wecom`.
 */
function channelMount(botId: string): string | undefined {
  const channel = botId.split('_', 1)[0]
  return /^[a-z][a-z0-9-]*$/.test(channel) ? `/${channel}` : undefined
}

/** Call one IM endpoint and normalise its answer. */
async function call(
  handler: { fetch: (request: Request) => Promise<Response> },
  namespace: string,
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<ImSyncResult> {
  const rpcId = `digital-human-${endpoint}-${Date.now()}`
  let response: Response
  try {
    response = await handler.fetch(new Request(`http://localhost${SHARED_CHANNEL}/${namespace}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: namespace,
        payload: { method: endpoint, payload },
      }),
    }))
  } catch (error) {
    return { endpoint, ok: false, reason: error?.message ?? String(error) }
  }
  if (response.status === 404) {
    return { endpoint, ok: false, reason: `no IM route at ${SHARED_CHANNEL}/${namespace}` }
  }
  if (!response.ok) {
    return { endpoint, ok: false, reason: `IM route answered ${response.status}` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { endpoint, ok: false, reason: 'the IM route did not answer with JSON' }
  }
  const result = isRecord(body) ? body.result : undefined
  if (!isRecord(result)) return { endpoint, ok: false, reason: 'the IM route answered without a result' }
  if (result.ok === true) return { endpoint, ok: true }
  const error = isRecord(result.error) ? result.error : undefined
  return { endpoint, ok: false, code: error?.code, reason: error?.message ?? 'the IM plugin refused the change' }
}

/**
 * Align one bound bot with its digital human.
 *
 * The digital human owns both values: its Workspace decides where the bot's
 * sessions run, and its preset decides how they behave. A failure is reported,
 * never thrown — a binding must still save when IM is absent.
 *
 * @param ctx - Host context; `connection` is read optionally.
 * @param options.botId - the bound bot.
 * @param options.workspace - the digital human's Workspace, if it has one.
 * @param options.presetId - the digital human's preset id.
 * @param options.owner - the claimed owner, injected into the source block.
 * @param options.log - sink for the per-endpoint outcome.
 * @returns one result per attempted endpoint.
 */
export async function syncBotToHuman(
  ctx: Ctx,
  { botId, workspace, presetId, owner, log = () => {} }: {
    botId?: string
    workspace?: string
    presetId?: string
    owner?: string
    log?: (message: string) => void
  },
): Promise<ImSyncResult[]> {
  if (!botId) return []
  const connection = ctx.get?.('connection')
  if (typeof connection?.createSharedFetchHandler !== 'function') {
    log('the connection service is absent, so the bound bot cannot be aligned')
    return [{ endpoint: '-', ok: false, reason: 'the connection service is absent' }]
  }
  const mount = channelMount(botId)
  if (!mount) {
    log(`bot id ${botId} names no channel, so it cannot be aligned`)
    return [{ endpoint: '-', ok: false, reason: `bot id ${botId} names no channel` }]
  }
  const handler = connection.createSharedFetchHandler(SHARED_CHANNEL)
  const namespace = `dsh-im${mount}`

  const results: ImSyncResult[] = []
  if (workspace) results.push(await call(handler, namespace, SET_WORKSPACE, { botId, workspace }))
  if (presetId) results.push(await call(handler, namespace, SET_PRESET, { botId, agentPreset: presetId }))
  // Always on: a persona that classifies callers is useless without knowing who
  // is writing, and the block is off by default.
  results.push(await call(handler, namespace, SET_CONTEXT, { botId, config: contextConfig(owner) }))
  for (const result of results) {
    log(result.ok
      ? `aligned ${botId}: ${result.endpoint}`
      : `could not align ${botId}: ${result.endpoint} — ${result.code ?? result.reason}`)
  }
  return results
}
