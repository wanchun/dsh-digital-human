/**
 * End-to-end checks of the platform against a stub Harness context.
 *
 * This exercises the real `apply()` of both halves — the Host platform row and the
 * preset-scoped tools row — so a failure here is a wiring failure, not a test
 * artifact. It needs no running Harness.
 *
 *   node test/apply.mjs
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyPlatform } from '../build/host/index.js'
import { apply as applyTools } from '../build/host/tools.js'
import { presetIdOf } from '../build/host/lib/presets.js'
import { SEED_HUMANS } from './fixtures/seed.mjs'

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
      // Mirrors the Host's contract, because both of its rules shape this plugin:
      // a Workspace and a cwd together are refused, an unknown id is created under
      // that id, and a named Session that has started a turn — or can no longer carry
      // the record — is left alone while a *new* one is minted and returned. Adoption
      // is `resolveAgent`, which is why the plugin no longer adopts through create.
      create: async (options) => {
        if (options?.workspaceId !== undefined && options?.cwd !== undefined) {
          throw new Error('session.create accepts workspaceId or cwd, not both')
        }
        const mint = () => {
          counter += 1
          const sessionId = `session-${counter}`
          sessions.push({ sessionId, running: false, agentAvailable: true, started: false, agentPreset: options?.agentPreset, cwd: options?.cwd, workspaceId: options?.workspaceId })
          return { sessionId, agentPreset: options?.agentPreset }
        }
        if (options?.sessionId !== undefined) {
          const known = sessions.find((entry) => entry.sessionId === options.sessionId)
          if (known === undefined) {
            sessions.push({ sessionId: options.sessionId, running: false, agentAvailable: true, started: false, agentPreset: options.agentPreset, cwd: options.cwd, workspaceId: options.workspaceId })
            return { sessionId: options.sessionId, agentPreset: options.agentPreset }
          }
          const samePreset = options.agentPreset === undefined || known.agentPreset === undefined || known.agentPreset === options.agentPreset
          const samePlace = options.cwd === undefined || known.cwd === undefined || known.cwd === options.cwd
          if (known.started || !samePreset || !samePlace) return mint()
          return { sessionId: known.sessionId, agentPreset: known.agentPreset }
        }
        return mint()
      },
      resolveAgent: async (sessionId) => {
        const known = sessions.find((entry) => entry.sessionId === sessionId)
        if (known === undefined) return { error: { message: `session "${sessionId}" not found` } }
        return { agent: { session: { header: { cwd: known.cwd, agentPreset: known.agentPreset } } } }
      },
      prompt: async (request, signal) => {
        // The real controller is prompt(request, signal); a stub that ignores the
        // signal would hide the omission that once kept every turn from starting.
        if (!(signal instanceof AbortSignal)) throw new TypeError('prompt requires an AbortSignal')
        prompts.push(request)
        const found = sessions.find((item) => item.sessionId === request.sessionId)
        if (found) {
          found.running = true
          found.started = true
        }
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
await applyPlatform(platform.ctx, { home, humans: SEED_HUMANS })
const service = platform.provided.get('digitalHumans')
check('provides the digitalHumans service', typeof service === 'object' && service !== null)
check('registers the global registry tool', platform.tools.has('digital_human'))
check('registers one preset per seeded human', platform.presets.size === 2, [...platform.presets.keys()].join(','))
check('preset ids are prefixed', platform.presets.has(presetIdOf('dev-assistant')) && platform.presets.has(presetIdOf('pm-assistant')))
check('subscribes to the session event feed', platform.listeners.some((entry) => entry.event === 'session/event' && entry.options?.global === true))
check('lists both humans', (await service.list()).length === 2)

console.log('2) chat system')
const delivered = await service.send('dev-assistant', { message: 'please review requirement 12345', from: 'pm-assistant', fromSession: 'session-sender-1' })
check('send creates a session', typeof delivered.sessionId === 'string' && delivered.sessionId.startsWith('session-'))
check('send is accepted', delivered.accepted === true)
check('the created session carries the digital-human preset', platform.sessions[0].agentPreset === 'dh-dev-assistant', String(platform.sessions[0].agentPreset))
// The delivery also names the conversation it arrived in, so the receiver can reply
// on the same one instead of trusting an id it remembered.
check('the prompt carries the message', platform.prompts[0].content[0].text.endsWith('please review requirement 12345'))
check('the prompt names the sender and the conversation it arrived in',
  platform.prompts[0].content[0].text.includes('<dsh_peer_source')
  && platform.prompts[0].content[0].text.includes('from="pm-assistant"')
  && platform.prompts[0].content[0].text.includes('conversation="main"'))
// The Session the message came from travels with it, so the reply can go back to
// the Session that asked for the work rather than to a shared thread name.
check('the prompt names the sending Session',
  platform.prompts[0].content[0].text.includes('session="session-sender-1"'))
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

// The incident this guards: a requirement is dispatched by conversation, answered by
// Session, and topped up twice more. Every delivery must stay in the two Sessions it
// started in — the Host mints a new one for a named Session that already has a turn.
console.log('3c) one requirement keeps one Session in each direction')
const devSessionsBefore = platform.sessions.filter((entry) => entry.agentPreset === 'dh-dev-assistant').length
const kickoff = await service.send('dev-assistant', { message: '【新需求】REQ-E2E', from: 'pm-assistant', conversationId: 'REQ-E2E' })
const answer = await service.send('pm-assistant', { message: 'progress', from: 'dev-assistant', sessionId: 'session-pm-e2e', conversationId: 'REQ-E2E' })
const topUp = await service.send('dev-assistant', { message: '【确认+派发】REQ-E2E', from: 'pm-assistant', conversationId: 'REQ-E2E' })
const receipt = await service.send('dev-assistant', { message: '【PM 回执】REQ-E2E', from: 'pm-assistant', sessionId: kickoff.sessionId, conversationId: 'REQ-E2E' })
check('the top-up lands in the Session the kickoff opened', topUp.sessionId === kickoff.sessionId, topUp.sessionId)
check('the reply back to the sender keeps its Session', answer.sessionId === 'session-pm-e2e', answer.sessionId)
check('a Session-addressed top-up lands in that Session', receipt.sessionId === kickoff.sessionId, receipt.sessionId)
check('the dev side opened exactly one Session for the requirement',
  platform.sessions.filter((entry) => entry.agentPreset === 'dh-dev-assistant').length === devSessionsBefore + 1,
  String(platform.sessions.filter((entry) => entry.agentPreset === 'dh-dev-assistant').length))
check('the mailbox keeps the whole requirement in one thread',
  (await service.messages('dev-assistant', kickoff.sessionId, 10)).items.map((entry) => entry.text).join('|')
    .includes('【PM 回执】REQ-E2E'))
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
const outbound = await scope.tools.get('digital_human_send')
  .execute({ to: 'pm-assistant', message: 'status please', conversation_id: 'main' })
check('send resolves the peer by id', outbound.to === 'pm-assistant' && outbound.accepted === true)
check('send reports the conversation', outbound.conversationId === 'main')
const byName = await scope.tools.get('digital_human_send')
  .execute({ to: '研发PM助手', message: 'ping', conversation_id: 'main' })
check('send resolves the peer by display name', byName.to === 'pm-assistant')
// A send with no address at all would pour every requirement into one shared thread,
// so the tool refuses it rather than defaulting.
check('send refuses a missing address',
  await scope.tools.get('digital_human_send').execute({ to: 'pm-assistant', message: 'x' }).then(() => false, () => true))
check('send refuses itself', await scope.tools.get('digital_human_send').execute({ to: 'dev-assistant', message: 'x', conversation_id: 'main' }).then(() => false, () => true))
check('send refuses an unknown peer', await scope.tools.get('digital_human_send').execute({ to: 'nobody', message: 'x', conversation_id: 'main' }).then(() => false, () => true))
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

console.log('11) a digital-human session gets its permission preset')
{
  // The deployment default asks for approval, and an IM turn composes no
  // answerer, so a digital human would stall on its first confined call. The
  // override must reach its own sessions only.
  const calls = []
  platform.ctx.provide('permissionPresets', { set: (session, name) => { calls.push({ session, name }) } })
  const created = platform.listeners.find((entry) => entry.event === 'session/created').handler
  const mine = { id: 'session-dh', header: { agentPreset: presetIdOf('dev-assistant') } }
  created(mine)
  check('the preset is applied', calls.length === 1, String(calls.length))
  check('the created session is the one changed', calls[0].session === mine)
  check('full access is the default', calls[0].name === 'danger-full-access', String(calls[0].name))
  created(mine)
  check('a repeat applies nothing twice', calls.length === 1, String(calls.length))
  created({ id: 'session-foreign', header: { agentPreset: 'standard' } })
  check('a foreign session is left alone', calls.length === 1, String(calls.length))
  created({ id: 'session-bare', header: {} })
  check('a session with no preset is left alone', calls.length === 1, String(calls.length))

  // A record that names its own preset must win over the default.
  await service.upsert({ id: 'ro-one', name: 'RO', permissionPreset: 'read-only' })
  created({ id: 'session-ro', header: { agentPreset: presetIdOf('ro-one') } })
  check('a named preset is honoured', calls[1]?.name === 'read-only', String(calls[1]?.name))

  // A preset chosen after creation is the other way in.
  const onEvent = platform.listeners.find((entry) => entry.event === 'session/event').handler
  onEvent({ id: 'session-late', header: {} }, { type: 'agent-preset/selected', data: { agentPreset: presetIdOf('dev-assistant') } })
  check('a late preset selection is caught', calls.length === 3, String(calls.length))

  // An absent service is a report, never a throw: a headless profile has none.
  const bare = makeCtx()
  await applyPlatform(bare.ctx, { home: join(home, 'noperm'), humans: SEED_HUMANS })
  const bareCreated = bare.listeners.find((entry) => entry.event === 'session/created').handler
  bareCreated({ id: 'session-x', header: { agentPreset: presetIdOf('dev-assistant') } })
  check('an absent permissionPresets service is survivable', true)
}

console.log('12) an unclaimed owner is claimed at startup')
{
  // The claim must not wait for a save: a record that is already bound and
  // already written to would otherwise run without an owner until someone
  // happened to open and save it.
  const root = await mkdtemp(join(tmpdir(), 'dh-startup-claim-'))
  const claimHome = join(root, 'digital-human')
  await mkdir(claimHome, { recursive: true })
  await writeFile(join(claimHome, 'humans.json'), JSON.stringify([{
    id: 'claimer',
    name: 'Claimer',
    description: '',
    enabled: true,
    systemPrompt: 'You claim things.',
    workspace: '/tmp',
    skills: [],
    peers: [],
    im: { botId: 'wecom_571e4e3104d704d7e99bcf79' },
    subscriptions: [],
    memory: false,
    escalation: { enabled: false, timeoutHours: 24 },
  }]))
  const botDir = join(root, 'integrations', 'dsh-wecom', 'bots', 'wecom_571e4e3104d704d7e99bcf79')
  await mkdir(botDir, { recursive: true })
  await writeFile(join(botDir, 'state.json'), JSON.stringify({
    version: 1,
    sessions: { 'direct:wohR_owner': 'session-a' },
  }))

  const claimed = makeCtx()
  await applyPlatform(claimed.ctx, { home: claimHome })
  const stored = await claimed.provided.get('digitalHumans').resolve('claimer')
  check('the first direct caller is stored as the owner', stored.im.owner === 'wohR_owner', String(stored.im.owner))
  const definition = claimed.presets.get(presetIdOf('claimer'))
  const persona = definition.plugins.find((row) => row.id === 'persona')
  check('the persona names the owner', persona.config.prefix.includes('wohR_owner'))
  check('the owner survives a re-read', (await claimed.provided.get('digitalHumans').resolve('claimer')).im.owner === 'wohR_owner')

  await rm(root, { recursive: true, force: true })
}

console.log('13) bound bots are aligned at startup, without a save')
{
  // IM holds these settings in memory, so a restart leaves it unaligned until
  // something pushes them again. Waiting for a save would mean every restart
  // silently drops the source block, the workspace, and the preset.
  const root = await mkdtemp(join(tmpdir(), 'dh-startup-align-'))
  const alignHome = join(root, 'digital-human')
  await mkdir(alignHome, { recursive: true })
  await writeFile(join(alignHome, 'humans.json'), JSON.stringify([{
    id: 'aligned',
    name: 'Aligned',
    description: '',
    enabled: true,
    systemPrompt: 'You are aligned.',
    workspace: '/tmp',
    skills: [],
    peers: [],
    im: { botId: 'wecom_571e4e3104d704d7e99bcf79' },
    subscriptions: [],
    memory: false,
    escalation: { enabled: false, timeoutHours: 24 },
  }]))
  const botDir = join(root, 'integrations', 'dsh-wecom', 'bots', 'wecom_571e4e3104d704d7e99bcf79')
  await mkdir(botDir, { recursive: true })
  await writeFile(join(botDir, 'state.json'), JSON.stringify({
    version: 1,
    sessions: { 'direct:wohR_owner': 'session-a' },
  }))

  const seen = []
  const connection = {
    createSharedFetchHandler: (channel) => ({
      async fetch(request) {
        const body = await request.json()
        seen.push({ channel, method: body.payload.method, payload: body.payload.payload })
        return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } })
      },
    }),
  }
  const aligned = makeCtx()
  aligned.ctx.provide('connection', connection)
  await applyPlatform(aligned.ctx, { home: alignHome })

  check('the workspace is pushed at startup', seen.some((entry) => entry.method === 'bot.workspace.set'))
  check('the preset is pushed at startup', seen.some((entry) => entry.method === 'bot.preset.set'))
  check('the source block is pushed at startup', seen.some((entry) => entry.method === 'bot.context-enhancement.set'))
  const context = seen.find((entry) => entry.method === 'bot.context-enhancement.set')
  check('the startup claim reaches the pushed guidance',
    context.payload.config.group.guidance.includes('wohR_owner'), context.payload.config.group.guidance.slice(-90))
  check('the pushed workspace is the digital human\'s',
    seen.find((entry) => entry.method === 'bot.workspace.set').payload.workspace === '/tmp')

  await rm(root, { recursive: true, force: true })
}

console.log('14) an alignment that found no connection recovers on a later refresh')
{
  // The live failure this pins: this plugin does not depend on the Connection
  // service, so the loader can run its apply() first. The first alignment then
  // has nothing to send through, and the record must be pushed once it exists.
  const root = await mkdtemp(join(tmpdir(), 'dh-late-conn-'))
  const lateHome = join(root, 'digital-human')
  await mkdir(lateHome, { recursive: true })
  await writeFile(join(lateHome, 'humans.json'), JSON.stringify([{
    id: 'late',
    name: 'Late',
    description: '',
    enabled: true,
    systemPrompt: 'You start without a connection.',
    workspace: '/tmp',
    skills: [],
    peers: [],
    im: { botId: 'wecom_571e4e3104d704d7e99bcf79' },
    subscriptions: [],
    memory: false,
    escalation: { enabled: false, timeoutHours: 24 },
  }]))

  const logs = []
  const late = makeCtx()
  late.ctx.logger = { warn: (message) => logs.push(message), info: () => {} }
  await applyPlatform(late.ctx, { home: lateHome })
  check('the absent service is reported, not thrown',
    logs.some((line) => line.includes('connection service is absent')))
  check('the wait is reported', logs.some((line) => line.includes('waiting on a service')))

  const seen = []
  late.ctx.provide('connection', {
    createSharedFetchHandler: (channel) => ({
      async fetch(request) {
        const body = await request.json()
        seen.push({ channel, method: body.payload.method })
        return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } })
      },
    }),
  })
  await late.provided.get('digitalHumans').refresh()
  check('the later refresh pushes the workspace', seen.some((entry) => entry.method === 'bot.workspace.set'))
  check('the later refresh pushes the preset', seen.some((entry) => entry.method === 'bot.preset.set'))
  check('the later refresh pushes the source block', seen.some((entry) => entry.method === 'bot.context-enhancement.set'))

  await rm(root, { recursive: true, force: true })
}

console.log('15) an owner no sender can match is reported, not obeyed silently')
{
  // The live failure this pins: the WeCom channel sends no display name, so an
  // owner written as a name can never equal the senderId the persona receives.
  // The persona then serves the owner as a stranger — and nothing says so.
  const root = await mkdtemp(join(tmpdir(), 'dh-owner-mismatch-'))
  const mismatchHome = join(root, 'digital-human')
  await mkdir(mismatchHome, { recursive: true })
  await writeFile(join(mismatchHome, 'humans.json'), JSON.stringify([{
    id: 'named',
    name: 'Named',
    description: '',
    enabled: true,
    systemPrompt: 'You answer to a name.',
    workspace: '/tmp',
    skills: [],
    peers: [],
    im: { botId: 'wecom_571e4e3104d704d7e99bcf79', owner: 'harrywan' },
    subscriptions: [],
    memory: false,
    escalation: { enabled: false, timeoutHours: 24 },
  }]))
  const botDir = join(root, 'integrations', 'dsh-wecom', 'bots', 'wecom_571e4e3104d704d7e99bcf79')
  await mkdir(botDir, { recursive: true })
  await writeFile(join(botDir, 'state.json'), JSON.stringify({
    version: 1,
    sessions: { 'direct:wohR_KCgAANNc-oBb9Z8h20IdfWja3lA': 'session-a' },
  }))

  const logs = []
  const mismatch = makeCtx()
  mismatch.ctx.logger = { warn: (message) => logs.push(message), info: () => {} }
  await applyPlatform(mismatch.ctx, { home: mismatchHome })
  check('the mismatch is reported', logs.some((line) => line.includes('cannot match')), logs.join(' | ').slice(0, 200))
  check('the report names the id the bot has seen',
    logs.some((line) => line.includes('wohR_KCgAANNc-oBb9Z8h20IdfWja3lA')))
  check('a configured owner is never silently replaced',
    (await mismatch.provided.get('digitalHumans').resolve('named')).im.owner === 'harrywan')

  await rm(root, { recursive: true, force: true })
}

console.log('16) a delivered session is filed under its Workspace')
{
  // A `cwd` alone puts the session in the right directory but leaves it out of the
  // Workspace's session list, which is what the UI groups by — the session then
  // shows as ungrouped even though it runs in the right place.
  const root = await mkdtemp(join(tmpdir(), 'dh-ws-'))
  const wsHome = join(root, 'digital-human')
  await mkdir(wsHome, { recursive: true })
  const target = join(wsHome, 'workspace')
  await writeFile(join(wsHome, 'humans.json'), JSON.stringify([{
    id: 'ws-one',
    name: 'Ws',
    description: '',
    enabled: true,
    systemPrompt: 'x',
    workspace: target,
    skills: [],
    peers: [],
    im: { botId: '' },
    subscriptions: [],
    memory: false,
    escalation: { enabled: false, timeoutHours: 24 },
  }]))

  const items = [{ workspaceId: 'ws-digital-human', path: target, title: '数字人' }]
  const filed = makeCtx()
  filed.ctx.provide('workspaceController', {
    follow: () => ({
      async *[Symbol.asyncIterator]() { yield { type: 'baseline', value: { items } } },
    }),
    create: async () => ({ workspace: items[0] }),
    rename: async () => ({ workspace: items[0] }),
  })
  await applyPlatform(filed.ctx, { home: wsHome })
  const sent = await filed.provided.get('digitalHumans').send('ws-one', { message: 'hi', conversationId: 'main' })
  const row = filed.sessions.find((entry) => entry.sessionId === sent.sessionId)
  check('the session carries the Workspace id', row.workspaceId === 'ws-digital-human', String(row.workspaceId))
  // The directory is not sent with the id: the Host resolves it from the Workspace,
  // and naming both is refused. So the id is the whole filing instruction.
  check('the session names no directory of its own', row.cwd === undefined, String(row.cwd))

  // Without a Workspace roster there is no id to file under, but the directory the
  // record names must still be passed: an unfiled session is a display problem, a
  // session in the wrong directory is a working one.
  const bare = makeCtx()
  await applyPlatform(bare.ctx, { home: join(root, 'bare') })
  await bare.provided.get('digitalHumans').upsert({ id: 'ws-two', name: 'W2', workspace: target, memory: false })
  const bareSent = await bare.provided.get('digitalHumans').send('ws-two', { message: 'hi' })
  const bareRow = bare.sessions.find((entry) => entry.sessionId === bareSent.sessionId)
  check('no roster means no Workspace id', bareRow.workspaceId === undefined)
  check('no roster still passes the named directory', bareRow.cwd === target, String(bareRow.cwd))

  await rm(root, { recursive: true, force: true })
}

console.log('17) disposal')
const platformForDisposal = makeCtx()
let disposeAll = null
platformForDisposal.ctx.effect = (fn) => { disposeAll = fn(); return () => {} }
await applyPlatform(platformForDisposal.ctx, { home: join(home, 'dispose'), humans: SEED_HUMANS })
check('two presets before disposal', platformForDisposal.presets.size === 2)
await disposeAll()
await new Promise((resolve) => setTimeout(resolve, 20))
check('disposal drops every preset', platformForDisposal.presets.size === 0)

await rm(home, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
