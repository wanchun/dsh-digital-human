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

/** Instruction shipped with the source block. */
const CONTEXT_GUIDANCE = [
  '仅依据当前消息的 <dsh_im_source> 中实际提供的字段理解来源；没有提供的字段不要猜测或补全。',
  'senderId / senderName 是来话人身份：先用它匹配成员登记表，再决定服务方式与权限；匹配不到时按新成员流程处理。',
  'chatId 是回复与定向通知该来话人的地址。',
].join('\n')

/**
 * The source-block setting this plugin installs.
 *
 * IM requires exactly the keys `group` and `direct`, and each scope exactly
 * `enabled`, `fields`, and `guidance`.
 */
function contextConfig(): Record<string, unknown> {
  const scope = { enabled: true, fields: [...CONTEXT_FIELDS], guidance: CONTEXT_GUIDANCE }
  return { group: { ...scope }, direct: { ...scope } }
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
 * @param options.log - sink for the per-endpoint outcome.
 * @returns one result per attempted endpoint.
 */
export async function syncBotToHuman(
  ctx: Ctx,
  { botId, workspace, presetId, log = () => {} }: {
    botId?: string
    workspace?: string
    presetId?: string
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
  results.push(await call(handler, namespace, SET_CONTEXT, { botId, config: contextConfig() }))
  for (const result of results) {
    log(result.ok
      ? `aligned ${botId}: ${result.endpoint}`
      : `could not align ${botId}: ${result.endpoint} — ${result.code ?? result.reason}`)
  }
  return results
}
