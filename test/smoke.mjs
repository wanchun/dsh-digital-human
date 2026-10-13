/**
 * Standalone checks for the pure parts of the platform: registry validation and
 * preset projection. No Harness runtime is involved, so this runs with plain node.
 *
 *   node test/smoke.mjs
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HumanStore, normalizeHuman } from '../build/host/lib/store.js'
import { buildPresetDefinition, presetIdOf } from '../build/host/lib/presets.js'
import { SEED_HUMANS } from '../build/host/lib/seed.js'

const home = await mkdtemp(join(tmpdir(), 'dh-'))
const store = new HumanStore(home)
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

console.log('1) seed on first load')
const seeded = await store.list(SEED_HUMANS)
check('two humans seeded', seeded.length === 2, JSON.stringify(seeded.map((h) => h.id)))
check('file written', (await readFile(store.file, 'utf8')).includes('dev-assistant'))

console.log('2) normalization')
const dev = await store.get('dev-assistant', SEED_HUMANS)
check('id and name', dev.id === 'dev-assistant' && dev.name === '开发助手')
check('peers parsed', JSON.stringify(dev.peers) === '["pm-assistant"]')
check('skills parsed', JSON.stringify(dev.skills) === JSON.stringify(['qs-end-to-end-fast','qs-assistant','dpms-cli-helper','pace-cli-helper']))
check('the retired skill is gone', !dev.skills.includes('halo-agent-collab'))
check('no Halo transport term survives', !/halo_token|halo_port|collab_space_id|collab_peer_app_id/.test(dev.systemPrompt))
check('persona is the Halo one', dev.systemPrompt.length > 5000 && !/\{[a-z_]+\}/.test(dev.systemPrompt))
check('im defaults', dev.im.botId === '' && dev.im.targetId === '')
check('enabled defaults true', dev.enabled === true)
const pm = await store.get('研发PM助手', SEED_HUMANS)
check('resolve by display name', pm?.id === 'pm-assistant')
check('dev subscription parsed', dev.subscriptions.length === 1 && dev.subscriptions[0].cron === '0 22 * * *')
check('pm declares no subscription', pm.subscriptions.length === 0)

console.log('3) invalid records rejected')
const rejects = (input, label) => {
  try {
    normalizeHuman(input)
    check(label, false, 'accepted')
  } catch {
    check(label, true)
  }
}
rejects({ id: '../escape' }, 'path-escape id rejected')
rejects({ id: 'ok', im: { botId: 'a:b' } }, 'bad botId rejected')
rejects({ id: 'ok', subscriptions: [{}] }, 'cronless subscription rejected')

console.log('4) upsert and remove')
await store.upsert({ id: 'temp-one', name: 'Temp' }, SEED_HUMANS)
check('created', (await store.get('temp-one', SEED_HUMANS))?.name === 'Temp')
await store.upsert({ id: 'temp-one', name: 'Temp 2', enabled: false }, SEED_HUMANS)
const updated = await store.get('temp-one', SEED_HUMANS)
check('updated in place', updated.name === 'Temp 2' && updated.enabled === false)
check('count stable after update', (await store.list(SEED_HUMANS)).length === 3)
check('removed', (await store.remove('temp-one', SEED_HUMANS)) === true)
check('count after remove', (await store.list(SEED_HUMANS)).length === 2)

console.log('4b) the Halo conversation id round-trips')
// The Halo specification names a per-requirement session
// `app-chat:dev-assistant:http:direct:{slug}`. A colon must be accepted, and the
// log filename must still be safe.
const HALO_CONVERSATION = 'app-chat:dev-assistant:http:direct:aiep-pdfexport-v2-20260918'
const haloPath = store.conversationPath('dev-assistant', HALO_CONVERSATION)
check('the Halo conversation id is accepted', haloPath.includes('app-chat%3Adev-assistant'))
check('the log filename carries no colon', !haloPath.split('/').pop().includes(':'))
check('a plain conversation id keeps its name', store.conversationPath('dev-assistant', 'main').endsWith('/main.jsonl'))
check('a colon-free id is unchanged by encoding', store.conversationPath('dev-assistant', 'ping-pong-check').endsWith('/ping-pong-check.jsonl'))

console.log('5) preset projection')
const definition = buildPresetDefinition(dev, {
  store,
  toolsPluginName: '@local/dsh-digital-human/tools',
  order: 100,
})
check('preset id', definition.id === presetIdOf('dev-assistant') && definition.id === 'dh-dev-assistant')
check('name and order', definition.name === '开发助手' && definition.order === 100)
check('persona first', definition.plugins[0].id === 'persona' && definition.plugins[0].name === '@deepseek-ai/dsh-persona')
check('persona carries prompt', definition.plugins[0].config.prefix.includes('开发助手'))
check('persona carries memory path', definition.plugins[0].config.prefix.includes(store.memoryPath('dev-assistant')))
check('persona carries peer guidance', definition.plugins[0].config.prefix.includes('digital_human_send'))
check('tools row last', definition.plugins.at(-1).id === 'digital-human-tools')
check('tools row binds the human', definition.plugins.at(-1).config.human === 'dev-assistant')
const ids = definition.plugins.map((row) => row.id)
check('unique row ids', new Set(ids).size === ids.length, ids.join(','))
const bashRow = definition.plugins.find((row) => row.id === 'tool-bash')
const pwshRow = definition.plugins.find((row) => row.id === 'tool-pwsh')
if (process.platform === 'win32') {
  check('bash disabled on win32', bashRow.disabled === true)
  check('pwsh enabled on win32', !pwshRow.disabled)
} else {
  check('bash enabled off win32', !bashRow.disabled)
  check('pwsh disabled off win32', pwshRow.disabled === true)
}

console.log('6) every isolated service has a provider in its own group')
// A group's `isolate` key names a service that the group must supply. A row that
// waits on one nobody provides strands the whole preset at "waiting for X" and
// the Agent fails to load — the exact failure `tool-workflow` produced before
// `workflow-ptc` was added beside it.
const ISOLATED_SERVICES = {
  compaction: '@deepseek-ai/dsh-compaction-basic',
  toolResultPruner: '@deepseek-ai/dsh-compaction-tool-result-pruner',
  workflowEngine: '@deepseek-ai/dsh-workflow-ptc',
}
const rows = definition.plugins
const groups = rows.filter((row) => row.group === true)
check('the baseline has groups', groups.length >= 2)
for (const group of groups) {
  const inner = Array.isArray(group.config) ? group.config : []
  const innerIds = inner.map((row) => row.id)
  check(`group ${group.id} carries rows`, inner.length > 0)
  check(`group ${group.id} row ids are unique`, new Set(innerIds).size === innerIds.length)
  for (const [service, provider] of Object.entries(group.isolate ?? {})) {
    const expected = ISOLATED_SERVICES[service]
    check(`isolated service ${service} is a known one`, expected !== undefined, `unmapped: ${service}`)
    if (expected === undefined) continue
    check(`group ${group.id} provides ${service} via ${expected}`, inner.some((row) => row.name === expected),
      `rows: ${inner.map((row) => `${row.id}=${row.name}`).join(', ')}`)
  }
}
check('every row names a plugin or is a group', rows.every((row) => row.group === true || typeof row.name === 'string'))
check('only the platform-conditional shells are disabled', rows.every((row) => row.disabled !== true
  || row.id === 'tool-bash' || row.id === 'tool-pwsh'))

await rm(home, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
