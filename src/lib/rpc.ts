import type { Ctx } from './types.js'
/**
 * Management channel for the settings page.
 *
 * The browser half needs to read and write the registry, and the only transport
 * that already carries browser authentication and Host/Origin trust is the
 * Connection service's shared `/api` channel. So this module owns one exact Fetch
 * route there, and `client.js` calls it with `connection.rpc.call`.
 *
 * The service is read optionally: a headless or ACP profile has no Connection, and
 * the platform must still mount there. Only the settings page is lost.
 */

/** Channel-relative endpoint of the management route. */
export const RPC_ENDPOINT = 'digital-human'

/** Absolute Fetch path owned by this plugin. */
export const RPC_PATH = `/api/${RPC_ENDPOINT}`

/** Whether a decoded JSON value is a plain object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Wrap one handler result in the envelope Connection's client validates. */
function reply(rpcId, result) {
  // The client requires `error.details` to be present even when the handler omits it.
  const value = result?.ok === false
    ? { ...result, error: { ...result.error, details: result.error?.details ?? {} } }
    : result
  return Response.json({ type: 'server-response', rpcId, result: value })
}

/** One failure envelope. */
function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * Register the management route.
 * @param ctx - Host context; `connection` is read optionally.
 * @param handler - `(method, payload, signal) => Promise<result>`.
 * @param log - sink for the absent-service note.
 * @returns the disposer, or undefined when the profile has no Connection service.
 */
export function registerRpc(
  ctx: Ctx,
  handler: (method: string, payload: any, signal?: AbortSignal) => Promise<unknown>,
  log: (message: string) => void = () => {},
) {
  const connection = ctx.get?.('connection')
  if (typeof connection?.fetch?.register !== 'function') {
    log('the connection service is absent, so the settings page cannot reach the registry')
    return undefined
  }
  return connection.fetch.register({
    path: RPC_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      // Connection has already applied browser authentication and trust checks here.
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (type !== 'application/json') return new Response('content type must be application/json', { status: 415 })
      let message
      try {
        message = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message?.payload
      if (!isRecord(message) || message.type !== 'client-request' || typeof message.rpcId !== 'string'
        || message.method !== RPC_ENDPOINT || !isRecord(call) || typeof call.method !== 'string'
        || !Object.hasOwn(call, 'payload')) {
        return reply(rpcId, failure('bad-request', 'Invalid digital-human management request.'))
      }
      try {
        return reply(rpcId, await handler(call.method, call.payload, request.signal))
      } catch (error) {
        log(`management call ${call.method} failed: ${error.message}`)
        return reply(rpcId, failure('handler-failed', error.message))
      }
    },
  })
}
