/**
 * Validate every tool schema against the runtime's own assertion.
 *
 * The tool registry enforces a subset of standard JSON Schema and refuses a row
 * whose schema leaves it. Authoring by eye is not enough: this suite asks the very
 * assertion the registry calls, so a schema mistake fails here instead of at boot.
 *
 * `@deepseek-ai/dsh-tools` is a Harness package, so it resolves only from an
 * installation or a profile. When it is unavailable this suite reports SKIP and
 * exits 0 rather than failing a checkout that has no Harness nearby.
 *
 *   node test/schema.mjs
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { buildHumanTools, buildRegistryTool } from '../build/host/lib/tools.js'
import { apply as applyPlatform } from '../build/host/index.js'
import { SEED_HUMANS } from './fixtures/seed.mjs'

/** Roots that may hold `@deepseek-ai/dsh-tools`, most specific first. */
const ROOTS = [
  process.env.DSH_PROFILE_DIR,
  process.env.DSH_HOME ? join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? 'web') : undefined,
  join(homedir(), '.dsh', 'profiles', 'web'),
  join(homedir(), '.n', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
].filter(Boolean)

/** Resolve the runtime's schema assertion, or null when Harness is not installed here. */
async function loadAssertions() {
  const candidates = ['@deepseek-ai/dsh-tools', ...ROOTS.flatMap((root) => [
    join(root, 'node_modules', '@deepseek-ai', 'dsh-tools'),
    join(root, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools'),
  ])]
  for (const candidate of candidates) {
    try {
      const require = createRequire(join(candidate, 'noop.js'))
      const resolved = require.resolve(candidate.startsWith('@') && !candidate.includes('/') ? candidate : candidate)
      const module_ = await import(pathToFileURL(resolved).href)
      if (typeof module_.assertSupportedJsonSchema === 'function') return module_
    } catch {
      // Try the next root.
    }
  }
  return null
}

const assertions = await loadAssertions()
if (!assertions) {
  console.log('SKIP: @deepseek-ai/dsh-tools is not resolvable from here, so schemas were not validated.')
  process.exit(0)
}

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

/** Assert one tool definition against the registry's rules. */
function assertTool(tool) {
  let problem = ''
  try {
    assertions.assertSupportedJsonSchema(tool.parameters)
    assertions.assertObjectJsonSchema(tool.output.schema)
  } catch (error) {
    problem = error.message
  }
  check(`${tool.name}: parameters and output are supported`, problem === '', problem)
}

const home = await mkdtemp(join(tmpdir(), 'dh-schema-'))

const provided = new Map()
const dshIm = {
  send: async () => {},
  listBots: async () => [{ botId: 'bot-a', name: 'Bot A' }],
  listTargets: async () => [{ targetId: 'group-1', name: 'Group', kind: 'group' }],
}
const ctx = {
  logger: { warn: () => {} },
  effect: (fn) => fn(),
  provide: (key, value) => provided.set(key, value),
  get: (key) => (key === 'connection' ? undefined : key === 'dshIm' ? dshIm : provided.get(key)),
  on: () => () => {},
  tools: { register: () => () => {} },
  agentPresets: { register: async () => async () => {}, readDocument: async () => undefined },
  sessionController: {
    create: async () => ({ sessionId: 'session-1' }),
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
    list: async () => ({ items: [{ sessionId: 'session-1', running: false }] }),
    cancel: async () => {},
  },
}
await applyPlatform(ctx, { home, humans: SEED_HUMANS })
const service = provided.get('digitalHumans')

console.log('1) preset-scoped tools')
const scoped = buildHumanTools({ ctx, service, humanId: 'dev-assistant' })
check('every scoped tool is declared', scoped.length === 12, String(scoped.length))
check('the title tool is exposed to a record with a bot', scoped.some((tool) => tool.name === 'set_session_title'))
// Inventing a conversation id splits one subject across two Sessions, so the
// capability to see what already exists is what lets a caller reuse it.
check('a peer conversation list is offered',
  scoped.some((tool) => tool.name === 'digital_human_conversations'), scoped.map((t) => t.name).join(','))
check('the stop tool is exposed', scoped.some((tool) => tool.name === 'digital_human_stop'))
for (const tool of scoped) assertTool(tool)

console.log('2) registry tool')
const registry = buildRegistryTool({ service })
assertTool(registry)

console.log('3) required fields are enforced')
for (const tool of [...scoped, registry]) {
  const required = tool.parameters.required ?? []
  const names = Object.keys(tool.parameters.properties ?? {})
  check(`${tool.name}: required names are declared properties`, required.every((name) => names.includes(name)), required.join(','))
  check(`${tool.name}: required is an array`, Array.isArray(required))
  check(`${tool.name}: no per-property required flag survives`, Object.values(tool.parameters.properties ?? {}).every((field) => !Object.hasOwn(field, 'required')))
}

console.log('4) arguments validate against the declared parameters')
for (const tool of [...scoped, registry]) {
  const sample = {}
  for (const name of tool.parameters.required ?? []) {
    const field = tool.parameters.properties[name]
    sample[name] = field.enum ? field.enum[0] : field.type === 'number' ? 1 : field.type === 'boolean' ? true : 'x'
  }
  let problem = ''
  try {
    assertions.validateJsonSchemaValue(tool.parameters, sample)
  } catch (error) {
    problem = error.message
  }
  check(`${tool.name}: a minimal valid call is accepted`, problem === '', problem)
}

console.log('5) real outputs satisfy their declared schema')
const calls = [
  ['digital_human_list', {}],
  ['digital_human_status', { to: 'pm-assistant' }],
  ['digital_human_messages', { to: 'pm-assistant' }],
  // An address, because the tool refuses a send that names none.
  ['digital_human_send', { to: 'pm-assistant', message: 'schema probe', conversation_id: 'schema-probe' }],
  ['memory_status', {}],
  ['memory_compact', {}],
  ['list_bot_targets', { bot_id: 'bot-a' }],
]
const byName = new Map(scoped.map((tool) => [tool.name, tool]))
for (const [name, args] of calls) {
  const tool = byName.get(name)
  let value = null
  let problem = ''
  try {
    value = await tool.execute(args)
    assertions.validateJsonSchemaValue(tool.output.schema, value)
  } catch (error) {
    problem = error.message
  }
  check(`${name}: its own result validates`, problem === '', problem)
}
for (const [args, label] of [[{ action: 'list' }, 'list'], [{ action: 'show', id: 'dev-assistant' }, 'show']]) {
  let problem = ''
  try {
    assertions.validateJsonSchemaValue(registry.output.schema, await registry.execute(args))
  } catch (error) {
    problem = error.message
  }
  check(`digital_human ${label}: its own result validates`, problem === '', problem)
}

await rm(home, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
