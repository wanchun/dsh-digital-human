/**
 * End-to-end checks of the platform against a stub Harness context.
 *
 * This exercises the real `apply()` of both halves — the Host platform row and the
 * preset-scoped tools row — so a failure here is a wiring failure, not a test
 * artifact. It needs no running Harness.
 *
 *   node test/apply.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyPlatform } from '../build/host/index.js'
import { apply as applyTools } from '../build/host/tools.js'
import { presetIdOf } from '../build/host/lib/presets.js'

let pass = 0
let fail = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    pass += 1
    console.log(`  ok   ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label} ${extra}`)
  }
}

/** A minimal stand-in for the Harness Host context. */
function makeCtx({ dshIm } = {}) {
  const presets = new Map()
  const tools = new Map()
  const provided = new Map()
  const contexts = []
  const listeners = []
  const sessions = []
  const prompts = []
  let counter = 0

  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    effect: (fn) => fn(),
    provide: (key, value) => provided.set(key, value),
    get: (key) => (key === 'dshIm' ? dshIm : provided.get(key)),
    on: (event, handler, options) => {
      listeners.push({ event, handler, options })
      return () => {}
    },
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    agentPresets: {
      register: async (definition) => {
        presets.set(definition.id, definition)
        return async () => { presets.delete(definition.id) }
      },
      readDocument: async () => undefined,
      list: async () => [...presets.values()],
    },
    sessionController: {
      create: async (options) => {
        counter += 1
        const sessionId = `session-${counter}`
        sessions.push({ sessionId, running: false, agentAvailable: true, agentPreset: options?.agentPreset, cwd: options?.cwd })
        return { sessionId, agentPreset: options?.agentPreset }
      },
      prompt: async (request, signal) => {
        // The real controller is prompt(request, signal); a stub that ignores the
        // signal would hide the omission that once kept every turn from starting.
        if (!(signal instanceof AbortSignal)) throw new TypeError('prompt requires an AbortSignal')
        prompts.push(request)
        const found = sessions.find((item) => item.sessionId === request.sessionId)
        if (found) found.running = true
        return { accepted: true }
      },
      list: async () => ({ items: sessions.map((item) => ({ ...item })) }),
      cancel: async ({ sessionId }) => {
        const found = sessions.find((item) => item.sessionId === sessionId)
        if (found) found.running = false
      },
    },
    systemPrompt: {
      context: (entry) => { contexts.push(entry); return () => {} },
    },
  }
  return { ctx, presets, tools, provided, contexts, listeners, sessions, prompts }
}

const home = await mkdtemp(join(tmpdir(), 'dh-apply-'))

console.log('1) platform row mounts')
const platform = makeCtx()
await applyPlatform(platform.ctx, { home, seed: true })
const service = platform.provided.get('digitalHumans')
check('provides the digitalHumans service', typeof service === 'object' && service !== null)
check('registers the global registry tool', platform.tools.has('digital_human'))
check('registers one preset per seeded human', platform.presets.size === 2, [...platform.presets.keys()].join(','))
check('preset ids are prefixed', platform.presets.has(presetIdOf('dev-assistant')) && platform.presets.has(presetIdOf('pm-assistant')))
check('subscribes to the session event feed', platform.listeners.some((entry) => entry.event === 'session/event' && entry.options?.global === true))
check('lists both humans', (await service.list()).length === 2)

console.log('2) chat system')
const delivered = await service.send('dev-assistant', { message: 'please review requirement 12345', from: 'pm-assistant' })
check('send creates a session', typeof delivered.sessionId === 'string' && delivered.sessionId.startsWith('session-'))
check('send is accepted', delivered.accepted === true)
check('the created session carries the digital-human preset', platform.sessions[0].agentPreset === 'dh-dev-assistant', String(platform.sessions[0].agentPreset))
check('the prompt carries the message', platform.prompts[0].content[0].text === 'please review requirement 12345')
check('status reports it is working', (await service.status('dev-assistant', 'main')).isGenerating === true)

console.log('3) one session per conversation, reused')
const again = await service.send('dev-assistant', { message: 'and 12346', from: 'pm-assistant' })
check('the same conversation reuses its session', again.sessionId === delivered.sessionId)
const other = await service.send('dev-assistant', { message: 'separate thread', conversationId: 'REQ-999' })
check('a different conversation gets its own session', other.sessionId !== delivered.sessionId)
check('a conversation id cannot escape its directory', await service.send('dev-assistant', { message: 'x', conversationId: '../evil' }).then(() => false, () => true))

// An inbound IM turn creates its own Session, and a record that gained a preset
// later leaves one behind. Either way the stored Session does not carry the
// digital human's mode, and reusing it would run without its persona and tools.
console.log('3b) a session without the digital-human preset is not reused')
const foreign = await service.send('dev-assistant', { message: 'from a foreign session', conversationId: 'REQ-FOREIGN' })
const foreignRow = platform.sessions.find((entry) => entry.sessionId === foreign.sessionId)
foreignRow.agentPreset = 'standard'
const reopened = await service.send('dev-assistant', { message: 'again', conversationId: 'REQ-FOREIGN' })
check('a mismatched session is replaced, not adopted', reopened.sessionId !== foreign.sessionId)
check('the replacement carries the digital-human preset',
  platform.sessions.find((entry) => entry.sessionId === reopened.sessionId).agentPreset === 'dh-dev-assistant')
check('the replacement is stable on the next send',
  (await service.send('dev-assistant', { message: 'third', conversationId: 'REQ-FOREIGN' })).sessionId === reopened.sessionId)
check('a disabled human refuses delivery', await service.upsert({ id: 'off-one', name: 'Off', enabled: false })
  .then(() => service.send('off-one', { message: 'x' }))
  .then(() => false, () => true))
check('a disabled human gets no preset', !platform.presets.has(presetIdOf('off-one')))

console.log('4) outbound turns reach the mailbox')
const fire = platform.listeners.find((entry) => entry.event === 'session/event').handler
fire({ id: delivered.sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Reviewed 12345: looks correct.' }] } } })
await new Promise((resolve) => setTimeout(resolve, 20))
const read = await service.messages('dev-assistant', 'main', 10)
check('mailbox holds both inbound messages and the reply', read.items.length === 3, JSON.stringify(read.items.map((item) => item.kind)))
check('the first entries are inbound', read.items.slice(0, 2).every((item) => item.kind === 'inbound'))
check('the reply is recorded last', read.items.at(-1).kind === 'outbound')
check('the reply text is recorded', read.items.at(-1).text.includes('looks correct'))
check('the reply is marked outbound', read.items.at(-1).kind === 'outbound')
check('an unrelated session is ignored', platform.listeners.length > 0 && (await service.messages('pm-assistant', 'main', 10)).items.length === 0)

console.log('5) registry mutations re-register presets')
const created = await service.upsert({ id: 'temp-human', name: 'Temp', peers: ['dev-assistant'] })
check('create returns the preset id', created.presetId === 'dh-temp-human')
check('create registers a preset', platform.presets.has('dh-temp-human'))
check('create appears in the list', (await service.list()).some((entry) => entry.id === 'temp-human'))
await service.upsert({ id: 'temp-human', name: 'Temp Renamed', enabled: false }, { partial: true })
check('disabling drops the preset', !platform.presets.has('dh-temp-human'))
check('disabling keeps the record', (await service.resolve('temp-human')).name === 'Temp Renamed')
check('resolve works by display name', (await service.resolve('开发助手'))?.id === 'dev-assistant')
check('remove drops the record', (await service.remove('temp-human')) === true)
check('remove of an unknown id reports false', (await service.remove('temp-human')) === false)

console.log('6) preset-scoped tools')
const sent = []
const dshIm = {
  send: async (botId, targetId, text, options) => { sent.push({ botId, targetId, text, options }) },
  listTargets: async () => [{ targetId: 'group-1', name: 'Dev Group', kind: 'group' }],
  listBots: async () => [],
}
const scope = makeCtx({ dshIm })
scope.ctx.digitalHumans = service
applyTools(scope.ctx, { human: 'dev-assistant' })
check('registers the chat tools', ['digital_human_send', 'digital_human_status', 'digital_human_messages'].every((toolName) => scope.tools.has(toolName)))
check('registers the IM tools', scope.tools.has('notify_bot') && scope.tools.has('list_bot_targets'))
check('registers the memory tools', scope.tools.has('memory_status') && scope.tools.has('memory_compact'))
check('registers one memory prompt context', scope.contexts.length === 1 && scope.contexts[0].name === 'digital-human-memory')
check('the memory context renders the rules', scope.contexts[0].text().includes('## Memory'))
check('refuses an empty human id', (() => { try { applyTools(makeCtx().ctx, {}) ; return false } catch { return true } })())

console.log('7) tools drive the chat system')
const outbound = await scope.tools.get('digital_human_send').execute({ to: 'pm-assistant', message: 'status please' })
check('send resolves the peer by id', outbound.to === 'pm-assistant' && outbound.accepted === true)
check('send reports the conversation', outbound.conversationId === 'main')
const byName = await scope.tools.get('digital_human_send').execute({ to: '研发PM助手', message: 'ping' })
check('send resolves the peer by display name', byName.to === 'pm-assistant')
check('send refuses itself', await scope.tools.get('digital_human_send').execute({ to: 'dev-assistant', message: 'x' }).then(() => false, () => true))
check('send refuses an unknown peer', await scope.tools.get('digital_human_send').execute({ to: 'nobody', message: 'x' }).then(() => false, () => true))
const listed = await scope.tools.get('digital_human_list').execute({})
check('list names the caller as you', listed.detail.includes('you'))
const mail = await scope.tools.get('digital_human_messages').execute({ to: 'pm-assistant', limit: 5 })
check('messages reads the peer mailbox', mail.detail.includes('status please'))

console.log('8) IM binding')
check('notify_bot refuses without a bound bot', await scope.tools.get('notify_bot').execute({ message: 'x' }).then(() => false, () => true))
await service.upsert({ id: 'dev-assistant', im: { botId: 'bot-a', targetId: 'group-1' } }, { partial: true })
const notified = await scope.tools.get('notify_bot').execute({ message: 'daily report' })
check('notify_bot uses the bound bot and target', notified.botId === 'bot-a' && notified.targetId === 'group-1')
check('notify_bot reached the IM plugin', sent.length === 1 && sent[0].text === 'daily report')
check('notify_bot defaults to plain text', sent[0].options.format === 'plain')
const marked = await scope.tools.get('notify_bot').execute({ message: '**bold**', format: 'markdown' })
check('notify_bot honours markdown', sent.at(-1).options.format === 'markdown' && marked.botId === 'bot-a')
const targetList = await scope.tools.get('list_bot_targets').execute({})
check('list_bot_targets renders the IM targets', targetList.detail.includes('group-1'))
check('notify_bot fails loud with no IM plugin', await (async () => {
  const bare = makeCtx()
  bare.ctx.digitalHumans = service
  applyTools(bare.ctx, { human: 'dev-assistant' })
  return bare.tools.get('notify_bot').execute({ message: 'x', bot_id: 'b', to: 't' }).then(() => false, () => true)
})())

console.log('9) memory tools')
const statusTool = scope.tools.get('memory_status')
const first = await statusTool.execute({})
check('memory_status reports no file at first', first.detail.includes('no file yet'))
check('memory_status names the file', first.detail.includes(service.store.dir('dev-assistant')))
const compacted = await scope.tools.get('memory_compact').execute({})
check('memory_compact reports nothing to archive', compacted.detail.includes('no memory.md'))
check('the memory context reflects the same file', scope.contexts[0].text().includes(service.store.dir('dev-assistant')))

console.log('10) registry tool')
const registry = platform.tools.get('digital_human')
const listDetail = await registry.execute({ action: 'list' })
check('registry lists humans', listDetail.detail.includes('dev-assistant'))
const shown = await registry.execute({ action: 'show', id: 'pm-assistant' })
check('registry shows one human', JSON.parse(shown.detail).id === 'pm-assistant')
const made = await registry.execute({ action: 'create', id: 'reg-one', name: 'Reg', peers: 'dev-assistant, pm-assistant', skills: 'qs-assistant' })
check('registry creates', made.detail.includes('dh-reg-one'))
check('registry parsed the peer list', (await service.resolve('reg-one')).peers.length === 2)
const patched = await registry.execute({ action: 'update', id: 'reg-one', name: 'Reg Two' })
check('registry updates one field', patched.detail.includes('reg-one') && (await service.resolve('reg-one')).name === 'Reg Two')
check('registry keeps untouched fields on update', (await service.resolve('reg-one')).peers.length === 2)
check('registry removes', (await registry.execute({ action: 'remove', id: 'reg-one' })).detail.includes('Removed'))
check('registry rejects an unknown action', await registry.execute({ action: 'explode', id: 'x' }).then(() => false, () => true))
check('registry requires an id', await registry.execute({ action: 'create' }).then(() => false, () => true))

console.log('11) disposal')
const platformForDisposal = makeCtx()
let disposeAll = null
platformForDisposal.ctx.effect = (fn) => { disposeAll = fn(); return () => {} }
await applyPlatform(platformForDisposal.ctx, { home: join(home, 'dispose'), seed: true })
check('two presets before disposal', platformForDisposal.presets.size === 2)
await disposeAll()
await new Promise((resolve) => setTimeout(resolve, 20))
check('disposal drops every preset', platformForDisposal.presets.size === 0)

await rm(home, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
