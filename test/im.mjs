/**
 * The IM alignment path.
 *
 * A bound bot must follow its digital human's Workspace and preset without a
 * restart. That is only possible through IM's own RPC endpoints, so these checks
 * pin the envelope, the namespace, and the failure handling.
 */

import { syncBotToHuman } from '../build/host/lib/im.js'

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** A Connection stub that records every dispatched request. */
function connectionStub({ answer } = {}) {
  const seen = []
  return {
    seen,
    createSharedFetchHandler(channel) {
      return {
        async fetch(request) {
          const body = await request.json()
          seen.push({ channel, url: request.url, body })
          if (answer) return answer(body)
          return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } })
        },
      }
    },
  }
}

console.log('1) both endpoints are called, in order')
{
  const connection = connectionStub()
  const ctx = { get: (name) => (name === 'connection' ? connection : undefined) }
  const logs = []
  const results = await syncBotToHuman(ctx, {
    botId: 'wecom_571e4e3104d704d7e99bcf79',
    workspace: '/Users/harrywan',
    presetId: 'dh-pm-assistant',
    log: (message) => logs.push(message),
  })
  check('three endpoints were called', results.length === 3, String(results.length))
  check('both succeeded', results.every((entry) => entry.ok === true))
  check('the shared /api channel is used', connection.seen.every((entry) => entry.channel === '/api'))
  check('the namespace is derived from the bot id',
    connection.seen.every((entry) => entry.url === 'http://localhost/api/dsh-im/wecom'), connection.seen[0]?.url)
  check('the envelope carries the namespace as its method',
    connection.seen.every((entry) => entry.body.method === 'dsh-im/wecom'))
  check('the envelope is a client-request',
    connection.seen.every((entry) => entry.body.type === 'client-request' && typeof entry.body.rpcId === 'string'))
  check('the Workspace endpoint carries botId and workspace',
    JSON.stringify(connection.seen[0].body.payload)
      === JSON.stringify({ method: 'bot.workspace.set', payload: { botId: 'wecom_571e4e3104d704d7e99bcf79', workspace: '/Users/harrywan' } }),
    JSON.stringify(connection.seen[0].body.payload))
  check('the preset endpoint carries botId and agentPreset',
    JSON.stringify(connection.seen[1].body.payload)
      === JSON.stringify({ method: 'bot.preset.set', payload: { botId: 'wecom_571e4e3104d704d7e99bcf79', agentPreset: 'dh-pm-assistant' } }),
    JSON.stringify(connection.seen[1].body.payload))
  check('the source block is switched on, since it is off by default',
    JSON.stringify(connection.seen[2].body.payload)
      === JSON.stringify({
        method: 'bot.context-enhancement.set',
        payload: {
          botId: 'wecom_571e4e3104d704d7e99bcf79',
          config: {
            group: connection.seen[2].body.payload.payload.config.group,
            direct: connection.seen[2].body.payload.payload.config.direct,
          },
        },
      }), JSON.stringify(connection.seen[2].body.payload))
  const scope = connection.seen[2].body.payload.payload.config
  check('both scopes are enabled', scope.group.enabled === true && scope.direct.enabled === true)
  check('the config carries exactly group and direct',
    JSON.stringify(Object.keys(scope).sort()) === JSON.stringify(['direct', 'group']), JSON.stringify(Object.keys(scope)))
  check('each scope carries exactly enabled, fields, guidance',
    JSON.stringify(Object.keys(scope.group).sort()) === JSON.stringify(['enabled', 'fields', 'guidance']),
    JSON.stringify(Object.keys(scope.group)))
  check('the caller name and id are injected',
    ['senderId', 'senderName'].every((field) => scope.group.fields.includes(field)), JSON.stringify(scope.group.fields))
  check('chatId is injected, so the persona can reply',
    scope.group.fields.includes('chatId'), JSON.stringify(scope.group.fields))
  check('the fields are all known to IM',
    scope.group.fields.every((field) => ['channel', 'conversationType', 'senderId', 'senderName',
      'conversationTitle', 'chatId', 'threadId', 'botId', 'sentAt'].includes(field)),
    JSON.stringify(scope.group.fields))
  check('the guidance is not empty', scope.group.guidance.length > 0)
  check('each call gets its own rpcId',
    new Set(connection.seen.map((entry) => entry.body.rpcId)).size === connection.seen.length)
  check('the outcome is logged', logs.length === 3, String(logs.length))
}

console.log('2) an unbound bot is a no-op')
{
  const connection = connectionStub()
  const ctx = { get: () => connection }
  const results = await syncBotToHuman(ctx, { botId: '', workspace: '/x', presetId: 'dh-x' })
  check('nothing is called', connection.seen.length === 0)
  check('no result is reported', results.length === 0)
}

console.log('3) a missing Connection is reported, not thrown')
{
  const ctx = { get: () => undefined }
  const results = await syncBotToHuman(ctx, { botId: 'wecom_1', workspace: '/x', presetId: 'dh-x' })
  check('one failure is reported', results.length === 1 && results[0].ok === false)
  check('the reason names the absent service', results[0].reason.includes('connection service'), results[0].reason)
}

console.log('4) a 404 means the route is not mounted')
{
  const connection = connectionStub({ answer: () => new Response('not found', { status: 404 }) })
  const ctx = { get: () => connection }
  const results = await syncBotToHuman(ctx, { botId: 'wecom_1', workspace: '/x', presetId: 'dh-x' })
  check('the failure is reported', results.every((entry) => entry.ok === false))
  check('the reason names the route', results[0].reason.includes('no IM route'), results[0].reason)
}

console.log('5) an IM-side refusal carries its code')
{
  const connection = connectionStub({
    answer: (body) => Response.json({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: false, error: { code: 'agent-preset-unavailable', message: 'no such preset', details: {} } },
    }),
  })
  const ctx = { get: () => connection }
  const results = await syncBotToHuman(ctx, { botId: 'wecom_1', workspace: '/x', presetId: 'dh-missing' })
  check('the refusal is reported', results.every((entry) => entry.ok === false))
  check('the code is preserved', results[0].code === 'agent-preset-unavailable', String(results[0].code))
}

console.log('6) a bot id without a channel is refused before any call')
{
  const connection = connectionStub()
  const ctx = { get: () => connection }
  const results = await syncBotToHuman(ctx, { botId: '1234', workspace: '/x', presetId: 'dh-x' })
  check('nothing is dispatched', connection.seen.length === 0)
  check('the reason names the channel', results[0].reason.includes('names no channel'), results[0].reason)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
