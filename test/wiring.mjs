/**
 * Checks for the two wiring seams that no other suite covers: the Host management
 * route the settings page calls, and the browser bundle's slot registrations.
 *
 *   node test/wiring.mjs
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyPlatform } from '../build/host/index.js'
import { RPC_ENDPOINT, RPC_PATH } from '../build/host/lib/rpc.js'

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

/** A context carrying just enough for the platform row to mount. */
function makeCtx({ connection, dshIm, skills, workspaceController } = {}) {
  const provided = new Map()
  const tools = new Map()
  const presets = new Map()
  const sessions = []
  let counter = 0
  return {
    logger: { warn: () => {} },
    effect: (fn) => fn(),
    provide: (key, value) => provided.set(key, value),
    get: (key) => {
      if (key === 'connection') return connection
      if (key === 'dshIm') return dshIm
      if (key === 'skills') return skills
      if (key === 'workspaceController') return workspaceController
      return provided.get(key)
    },
    on: () => () => {},
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    agentPresets: { register: async (d) => { presets.set(d.id, d); return async () => { presets.delete(d.id) } }, readDocument: async () => undefined },
    sessionController: {
      create: async (request) => { counter += 1; const sessionId = `session-${counter}`; sessions.push({ sessionId, running: false, agentPreset: request?.agentPreset }); return { sessionId } },
      // The real controller is prompt(request, signal). Requiring the signal
      // here makes a missing one fail loudly instead of silently.
      prompt: async (request, signal) => {
        if (!(signal instanceof AbortSignal)) throw new TypeError('prompt requires an AbortSignal')
        if (typeof request?.requestId !== 'string' || typeof request?.sessionId !== 'string') {
          throw new TypeError('prompt requires requestId and sessionId')
        }
        if (request?.mode !== 'queue' && request?.mode !== 'steer') throw new TypeError('prompt requires a mode')
        if (!Array.isArray(request?.content) || request.content.length === 0) throw new TypeError('prompt requires content')
        return { accepted: true }
      },
      list: async () => ({ items: sessions }),
      cancel: async () => {},
    },
    _provided: provided,
    _tools: tools,
    _presets: presets,
  }
}

/** One client request as Connection's carrier would deliver it. */
function request(body, { method = 'POST', contentType = 'application/json', path = RPC_PATH } = {}) {
  return new Request(`http://127.0.0.1:3080${path}`, {
    method,
    headers: contentType ? { 'content-type': contentType } : {},
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })
}

/** A well-formed call envelope. */
function call(method, payload, rpcId = 'rpc-1') {
  return { type: 'client-request', rpcId, method: RPC_ENDPOINT, payload: { method, payload } }
}

const home = await mkdtemp(join(tmpdir(), 'dh-wiring-'))
// The IM integration keeps bot aliases and served directories beside its
// credentials. One bot carries both; the other carries neither. Every scenario
// gets its own copy, because each runs against its own home.
const BOT_META = JSON.stringify({
  version: 2,
  workspaces: { 'bot-a': '/Users/harrywan/company/git/fes-design' },
  aliases: { 'bot-a': '万纯研发PM-DSH' },
})
// Each scenario's registry home is `<root>/<scenario>`, and the integration
// data sits one level above it, so a single copy serves them all.
await mkdir(join(home, 'integrations', 'dsh-wecom'), { recursive: true })
await writeFile(join(home, 'integrations', 'dsh-wecom', 'workspaces.json'), BOT_META, 'utf8')
// A second channel proves the scan is not hardcoded to WeCom.
await mkdir(join(home, 'integrations', 'dsh-feishu'), { recursive: true })
await writeFile(join(home, 'integrations', 'dsh-feishu', 'workspaces.json'), JSON.stringify({
  version: 2,
  workspaces: { 'bot-b': '/Users/harrywan/company/project/utms-tumss' },
  aliases: { 'bot-b': '飞书研发助手' },
}), 'utf8')

console.log('1) the route mounts only when Connection exists')
const bare = makeCtx()
await applyPlatform(bare, { home: join(home, 'bare'), seed: true })
check('mounts without a Connection service', bare._provided.has('digitalHumans'))
check('still registers the registry tool', bare._tools.has('digital_human'))

let route = null
const routes = []
const connection = {
  fetch: {
    register: (registered) => {
      routes.push(registered)
      // The plugin registers a second, binary route beside the management one, so the
      // management route is picked by its path rather than by being registered last.
      if (registered.path === RPC_PATH) route = registered
      return async () => {}
    },
  },
}
const dshIm = {
  send: async () => {},
  listBots: async () => [{ botId: 'bot-a', name: 'Bot A' }, { botId: 'bot-b', name: 'Bot B' }],
  listTargets: async (botId) => (botId === 'bot-a' ? [{ targetId: 'group-1', name: 'Dev Group', kind: 'group' }] : []),
}
const skills = { list: async () => [
  { name: 'qs-assistant', description: '千手平台助手', source: 'filesystem' },
  { name: 'dpms-cli', description: 'DPMS 需求平台', source: 'filesystem' },
] }
const workspaceController = {
  follow: async function* () {
    yield { type: 'baseline', value: { items: [
      { workspaceId: 'ws-1', title: '数字人', path: '/Users/harrywan/.dsh/digital-human/workspace' },
      { workspaceId: 'ws-2', title: 'harrywan', path: '/Users/harrywan' },
    ] } }
  },
  create: async ({ path }) => ({ workspace: { workspaceId: 'ws-new', title: path, path }, created: true }),
  rename: async ({ workspaceId, title }) => ({ workspace: { workspaceId, title, path: '/x' } }),
}
const wired = makeCtx({ connection, dshIm, skills, workspaceController })
await applyPlatform(wired, { home: join(home, 'wired'), seed: true })
// `route` is overwritten every time another ctx mounts on the same connection,
// so keep this one under its own name for the checks that follow.
const wiredRoute = route
check('registers the management route', route !== null)
check('registers the bundle route beside it',
  routes.some((entry) => entry.path === RPC_PATH + '/bundle'), routes.map((entry) => entry.path).join(','))
check('route owns the documented path', route.path === RPC_PATH && RPC_PATH === '/api/digital-human')
check('route is POST-only and buffered', JSON.stringify(route.methods) === '["POST"]' && route.requestBody === 'buffered')

console.log('2) request validation')
// Path matching belongs to Connection's dispatcher, which invokes this handler only
// for the registered path; the handler itself never inspects the URL.
const wrongMethod = await route.fetch(request(null, { method: 'GET' }))
check('a non-POST is refused', wrongMethod.status === 405)
const wrongType = await route.fetch(request(call('registry.list', {}), { contentType: 'text/plain' }))
check('a non-JSON content type is refused', wrongType.status === 415)
const notJson = await route.fetch(new Request('http://127.0.0.1:3080/api/digital-human', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }))
check('a malformed body is refused', notJson.status === 400)
const badEnvelope = await route.fetch(request({ type: 'client-request', rpcId: 'x', method: 'other', payload: { method: 'registry.list', payload: {} } }))
check('a mismatched endpoint is a bad request', (await badEnvelope.json()).result.ok === false)

console.log('3) registry methods')
const listed = await (await route.fetch(request(call('registry.list', {})))).json()
check('list answers ok', listed.result.ok === true && listed.result.value.humans.length === 2)
check('list names the registry file', listed.result.value.file.endsWith('humans.json'))
// The page cannot resolve the config itself — the peer facts need every record's
// name — so the Host attaches what the persona will actually see.
const listedPm = listed.result.value.humans.find((entry) => entry.id === 'pm-assistant')
check('list reports the resolved config', typeof listedPm.resolved?.values === 'object', JSON.stringify(listedPm.resolved))
check('the resolved config carries a source per key',
  Object.keys(listedPm.resolved.sources).length === Object.keys(listedPm.resolved.values).length,
  JSON.stringify(listedPm.resolved.sources))
const gotPm = await (await route.fetch(request(call('registry.get', { id: 'pm-assistant' })))).json()
check('get reports the resolved config too', typeof gotPm.result.value.human.resolved?.values === 'object')
// A failed push is otherwise invisible: the bot simply runs without its source
// block or preset, and the only other trace is a log line on someone's terminal.
check('list reports the last alignment per record',
  Array.isArray(listedPm.alignment), JSON.stringify(listedPm.alignment))
check('the envelope carries the rpcId', listed.rpcId === 'rpc-1' && listed.type === 'server-response')
const got = await (await route.fetch(request(call('registry.get', { id: 'pm-assistant' })))).json()
check('get resolves by id', got.result.value.human.name === '研发PM助手')
const missing = await (await route.fetch(request(call('registry.get', { id: 'nobody' })))).json()
check('get fails loud on an unknown id', missing.result.ok === false && missing.result.error.details !== undefined)

const saved = await (await route.fetch(request(call('registry.save', { id: 'ui-made', patch: { name: 'UI 建的', peers: ['dev-assistant'] } })))).json()
check('save creates', saved.result.ok === true && saved.result.value.presetId === 'dh-ui-made')
check('save registered a live preset', wired._presets.has('dh-ui-made'))
const patched = await (await route.fetch(request(call('registry.save', { id: 'ui-made', patch: { name: 'UI 改的' }, partial: true })))).json()
check('save with partial merges', patched.result.value.human.name === 'UI 改的' && patched.result.value.human.peers.length === 1)
const noId = await (await route.fetch(request(call('registry.save', { patch: { name: 'x' } })))).json()
check('save requires an id', noId.result.ok === false)
const removed = await (await route.fetch(request(call('registry.remove', { id: 'ui-made' })))).json()
check('remove deletes', removed.result.value.removed === true)
check('remove dropped the preset', !wired._presets.has('dh-ui-made'))
check('remove of an unknown id reports false', (await (await route.fetch(request(call('registry.remove', { id: 'ui-made' })))).json()).result.value.removed === false)
check('an unsupported method is refused', (await (await route.fetch(request(call('nope.nope', {})))).json()).result.ok === false)

console.log('4) IM discovery')
const bots = await (await route.fetch(request(call('im.bots', {})))).json()
check('im.bots lists the bound bots', bots.result.value.bots[0].botId === 'bot-a')
check('im.bots merges the alias and the served directory',
  bots.result.value.bots[0].alias === '万纯研发PM-DSH'
  && bots.result.value.bots[0].workspace === '/Users/harrywan/company/git/fes-design')
check('im.bots reads a second channel too',
  bots.result.value.bots[1].alias === '飞书研发助手'
  && bots.result.value.bots[1].workspace === '/Users/harrywan/company/project/utms-tumss')
const targets = await (await route.fetch(request(call('im.targets', { botId: 'bot-a' })))).json()
check('im.targets lists one bot targets', targets.result.value.targets[0].targetId === 'group-1')
check('im.targets without a bot id is empty', (await (await route.fetch(request(call('im.targets', {})))).json()).result.value.targets.length === 0)
const noIm = makeCtx({ connection })
await applyPlatform(noIm, { home: join(home, 'no-im'), seed: true })
const noImBots = await (await route.fetch(request(call('im.bots', {})))).json()
check('im.bots degrades to empty without the IM plugin', noImBots.result.value.bots.length === 0)

console.log('4a) the workspace roster')
const wsList = await (await wiredRoute.fetch(request(call('workspaces.list', {})))).json()
check('workspaces.list returns the roster', wsList.result.value.workspaces.length === 2)
check('workspaces.list names the default title', wsList.result.value.defaultTitle === '数字人')
check('workspaces.list projects id, title, path',
  wsList.result.value.workspaces[1].workspaceId === 'ws-2'
  && wsList.result.value.workspaces[1].title === 'harrywan'
  && wsList.result.value.workspaces[1].path === '/Users/harrywan')

console.log('4b) the skill catalog')
const skillList = await (await wiredRoute.fetch(request(call('skills.list', {})))).json()
check('skills.list returns the catalog', skillList.result.value.skills.length === 2)
check('skills.list projects name, description, source', skillList.result.value.skills[0].name === 'qs-assistant'
  && skillList.result.value.skills[0].description === '千手平台助手'
  && skillList.result.value.skills[0].source === 'filesystem')
const noSkills = makeCtx({ connection })
await applyPlatform(noSkills, { home: join(home, 'no-skills'), seed: true })
check('skills.list degrades to empty without the skill plugin',
  (await (await route.fetch(request(call('skills.list', {})))).json()).result.value.skills.length === 0)

console.log('5) the browser bundle registers its slots')
let loaded = null
global.window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }
await import('../client.js')
check('the factory id equals the package name', loaded?.id === '@harrywan/dsh-digital-human')
const React = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}
// The page renders through the same component library the schedule and plugin
// pages use, so the stub must answer for it too.
const Primitives = new Proxy({}, { get: (_target, name) => name })
// Vite emits the automatic JSX runtime, so the bundle requires `react/jsx-runtime`
// as well. Every shipped client bundle does the same, which is how the loader is
// known to provide it.
const JsxRuntime = { jsx: () => null, jsxs: () => null, Fragment: null }
const module_ = loaded.factory((name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return JsxRuntime
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return Primitives
  throw new Error(`unexpected require: ${name}`)
})
check('the client loads the shared component library',
  loaded.factory.toString().includes('@deepseek-ai/dsh-client-ui-primitives'))
// A coarse guard, but it is the only one available here: the React stub renders
// nothing, so the config editor can only be checked for being in the bundle. A
// build that dropped it — or a style comment that ended the template literal and
// took the control with it — fails this.
check('the bundle carries the config editor', loaded.factory.toString().includes('添加一项'))
check('the config editor is laid out as rows', loaded.factory.toString().includes('dh-row-name'))
check('the bundle renders declared fields', loaded.factory.toString().includes('SchemaFields'))
check('the bundle shows a fact field as read-only', loaded.factory.toString().includes('平台自动提供'))
check('the client injects slots and connection', JSON.stringify(module_.inject) === '["slots","connection"]')

const registrations = []
const calls = []
const clientCtx = {
  effect: (fn) => fn(),
  slots: {
    inject: (name, factory) => factory(),
    register: (options, Component) => {
      registrations.push({ options, Component })
      return () => {}
    },
  },
  connection: { rpc: { call: (...args) => { calls.push(args); return Promise.resolve({ ok: true, value: {} }) } } },
}
module_.apply(clientCtx)
const byName = (name) => registrations.filter((entry) => entry.options.name === name)
// The settings page carries no entry: the sidebar panel beside 自动化任务 is
// the only way in, so there is one place to reach the page rather than two.
check('registers no settings section', byName('settings.section').length === 0)
check('registers one sidebar panel entry', byName('sidebar.panellist').length === 1)
check('the panel entry comes after 自动化任务', byName('sidebar.panellist')[0].options.order === 20)
check('the panel key matches the sidebar id', byName('main')[0].options.key === byName('sidebar.panellist')[0].options.id)
check('registers the main panel', byName('main').length === 1)
check('the panel receives the rpc caller', typeof byName('main')[0].options.inject().rpc === 'function')

const rpc = byName('main')[0].options.inject().rpc
await rpc('registry.list', {}, undefined)
check('the client calls the shared channel', calls[0][0] === '/api' && calls[0][1] === RPC_ENDPOINT)
check('the client sends the method and payload', calls[0][2].method === 'registry.list' && typeof calls[0][2].payload === 'object')
const refused = await rpc('nope', {}, undefined).then(() => null, () => null)
check('a business refusal is unwrapped by the page, not the caller', refused === null)
await clientCtx.connection.rpc.call('/api', RPC_ENDPOINT, {}, undefined)
check('every call uses the same endpoint', calls.every((entry) => entry[1] === RPC_ENDPOINT))

await rm(home, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
