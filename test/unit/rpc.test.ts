import { describe, expect, it, vi } from 'vitest'

import { RPC_ENDPOINT, RPC_PATH, registerRpc } from '../../src/lib/rpc'

/** A context whose `connection` may or may not be usable. */
const ctxWith = (connection?: unknown) => ({ get: (name: string) => (name === 'connection' ? connection : undefined) })

/** A connection stub that captures the one route it is handed. */
function connectionStub() {
  const routes: any[] = []
  return {
    routes,
    fetch: { register: (route: any) => { routes.push(route); return () => {} } },
  }
}

const body = (patch: Record<string, unknown> = {}) => ({
  type: 'client-request',
  rpcId: 'rpc-1',
  method: RPC_ENDPOINT,
  payload: { method: 'registry.list', payload: {}, ...patch },
})

const post = (value: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  new Request(`http://127.0.0.1:3080${RPC_PATH}`, {
    method: 'POST', headers, body: typeof value === 'string' ? value : JSON.stringify(value),
  })

/** Mount the route and return it with the handler. */
function mount(handler = vi.fn(async () => ({ ok: true, value: { humans: [] } }))) {
  const connection = connectionStub()
  const log = vi.fn()
  const dispose = registerRpc(ctxWith(connection), handler, log)
  return { connection, route: connection.routes[0], handler, log, dispose }
}

describe('registration', () => {
  it('owns one POST route on the shared channel', () => {
    const { route } = mount()
    expect(route.path).toBe('/api/digital-human')
    expect(route.methods).toEqual(['POST'])
    expect(route.requestBody).toBe('buffered')
  })

  it('returns the disposer', () => {
    const { dispose } = mount()
    expect(dispose).toBeTypeOf('function')
  })

  it('mounts nothing without a Connection, and says so', () => {
    // A headless or ACP profile has no Connection; the platform must still mount.
    const log = vi.fn()
    expect(registerRpc(ctxWith(undefined), vi.fn(), log)).toBeUndefined()
    expect(registerRpc({ get: () => undefined }, vi.fn(), vi.fn())).toBeUndefined()
    expect(registerRpc(ctxWith({ fetch: {} }), vi.fn(), log)).toBeUndefined()
    expect(String(log.mock.calls[0][0])).toContain('connection service is absent')
  })

  it('tolerates a context with no `get` at all', () => {
    expect(registerRpc({}, vi.fn(), vi.fn())).toBeUndefined()
  })
})

describe('request validation', () => {
  it('refuses a method other than POST', async () => {
    const { route } = mount()
    const answer = await route.fetch(new Request(`http://x${RPC_PATH}`, { method: 'GET' }))
    expect(answer.status).toBe(405)
  })

  it('refuses a content type other than JSON', async () => {
    const { route } = mount()
    const answer = await route.fetch(post(body(), { 'content-type': 'text/plain' }))
    expect(answer.status).toBe(415)
    const withCharset = await route.fetch(post(body(), { 'content-type': 'application/json; charset=utf-8' }))
    expect(withCharset.status).toBe(200)
  })

  it('refuses a body that is not JSON', async () => {
    const { route } = mount()
    expect((await route.fetch(post('{ not json'))).status).toBe(400)
  })

  it('refuses every malformed envelope shape', async () => {
    const { route, handler } = mount()
    const shapes = [
      { ...body(), type: 'server-response' },
      { ...body(), rpcId: 42 },
      { ...body(), method: 'another-plugin' },
      { ...body(), payload: 'nope' },
      { ...body(), payload: { method: 42, payload: {} } },
      { ...body(), payload: { method: 'registry.list' } },
    ]
    for (const shape of shapes) {
      const answer = await (await route.fetch(post(shape))).json()
      expect(answer.result.ok, JSON.stringify(shape)).toBe(false)
      expect(answer.result.error.code).toBe('bad-request')
      // The client requires `details` to be present even when the handler omits it.
      expect(answer.result.error.details).toEqual({})
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('keeps the rpcId it was given, and labels one it cannot read', async () => {
    const { route } = mount()
    const named = await (await route.fetch(post({ ...body(), method: 'other' }))).json()
    expect(named.rpcId).toBe('rpc-1')
    const unnamed = await (await route.fetch(post({ ...body(), rpcId: 42 }))).json()
    expect(unnamed.rpcId).toBe('invalid-request')
  })
})

describe('dispatch', () => {
  it('answers in the envelope the client validates', async () => {
    const { route, handler } = mount()
    const answer = await (await route.fetch(post(body({ payload: { limit: 5 } })))).json()
    expect(answer.type).toBe('server-response')
    expect(answer.rpcId).toBe('rpc-1')
    expect(answer.result).toEqual({ ok: true, value: { humans: [] } })
    expect(handler).toHaveBeenCalledWith('registry.list', { limit: 5 }, expect.anything())
  })

  it('passes the request signal so a cancelled page stops the work', async () => {
    const { route, handler } = mount()
    await route.fetch(post(body()))
    expect(handler.mock.calls[0][2]).toBeInstanceOf(AbortSignal)
  })

  it('contains a handler failure and reports it', async () => {
    const handler = vi.fn(async () => { throw new Error('registry is unreadable') })
    const { route, log } = mount(handler)
    const answer = await (await route.fetch(post(body()))).json()
    expect(answer.result.ok).toBe(false)
    expect(answer.result.error.code).toBe('handler-failed')
    expect(answer.result.error.message).toBe('registry is unreadable')
    expect(String(log.mock.calls[0][0])).toContain('registry is unreadable')
  })

  it('keeps the details a handler supplied', async () => {
    const handler = vi.fn(async () => ({ ok: false, error: { code: 'x', message: 'y', details: { at: 'z' } } }))
    const { route } = mount(handler)
    const answer = await (await route.fetch(post(body()))).json()
    expect(answer.result.error.details).toEqual({ at: 'z' })
  })

  it('fills in details a handler left out', async () => {
    const handler = vi.fn(async () => ({ ok: false, error: { code: 'x', message: 'y' } }))
    const { route } = mount(handler)
    expect((await (await route.fetch(post(body()))).json()).result.error.details).toEqual({})
  })
})
