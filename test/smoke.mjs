/**
 * Standalone checks for the pure parts of the platform: registry validation and
 * preset projection. No Harness runtime is involved, so this runs with plain node.
 *
 *   node test/smoke.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HumanStore, normalizeHuman } from '../build/host/lib/store.js'
import { buildPresetDefinition, builtinConfig, effectiveConfig, neutralizePlaceholders, presetIdOf, renderConfigBlock, resolveConfig, resolveConfigValues } from '../build/host/lib/presets.js'
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
check('record directory written', existsSync(store.personaPath('dev-assistant')))

console.log('2) normalization')
// The persona file is prose people edit by hand, so a read always goes to disk.
{
  const personaPath = store.personaPath(seeded[0].id)
  const original = await readFile(personaPath, 'utf8')
  await writeFile(personaPath, original.replace(/^name: .*$/m, 'name: Hand Edited'), 'utf8')
  const reread = await store.list(SEED_HUMANS)
  check('an edit on disk is picked up', reread[0].name === 'Hand Edited', reread[0].name)
  await writeFile(personaPath, original, 'utf8')
  check('the edit is reversible', (await store.list(SEED_HUMANS))[0].name === SEED_HUMANS[0].name)
}

const dev = await store.get('dev-assistant', SEED_HUMANS)
check('id and name', dev.id === 'dev-assistant' && dev.name === '开发助手')
check('peers parsed', JSON.stringify(dev.peers) === '["pm-assistant"]')
check('skills parsed', JSON.stringify(dev.skills) === JSON.stringify(['task-end-to-end','task-assistant','req-cli-helper','pipe-cli-helper']))
check('the retired skill is gone', !dev.skills.includes('halo-agent-collab'))
check('no Halo transport term survives', !/halo_token|halo_port|collab_space_id|collab_peer_app_id/.test(dev.systemPrompt))
// The shipped examples are placeholders now: a short persona that keeps the
// placeholders the renderer substitutes, not one team's business text.
check('the example persona is short and placeholder-driven',
  dev.systemPrompt.length > 200 && dev.systemPrompt.includes('{{peer_name}}'))
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

console.log('7) the config bag and its placeholders')
{
  // A persona names its own keys — a team name, the lead's name and honorific —
  // so the bag is free-form. What matters is that "unset" stays distinguishable
  // from "set to empty", because that is the difference a persona's fallback rule
  // turns on.
  const kept = normalizeHuman({
    id: 'cfg-one',
    name: 'Cfg',
    config: { team_name: ' TCTP开发一室 ', leader_name: '万纯', blank: '   ', '': 'orphan' },
  })
  check('config is kept', kept.config?.team_name === 'TCTP开发一室', JSON.stringify(kept.config))
  check('values are trimmed', kept.config?.leader_name === '万纯')
  check('an empty value is dropped', kept.config?.blank === undefined)
  check('a key with no name is dropped', Object.keys(kept.config ?? {}).length === 2)
  check('a record without config has none', normalizeHuman({ id: 'cfg-two', name: 'No' }).config === undefined)
  check('an all-empty config is dropped', normalizeHuman({ id: 'cfg-three', name: 'E', config: { a: '' } }).config === undefined)
  check('a non-object config is rejected',
    await Promise.resolve().then(() => normalizeHuman({ id: 'cfg-four', name: 'B', config: 'nope' })).then(() => false, () => true))

  // Only configured names are replaced, so a platform variable survives.
  check('a configured placeholder is replaced',
    resolveConfig('组长为 {{leader_name}}。', { leader_name: '万纯' }) === '组长为 万纯。')
  check('spacing inside the braces is tolerated',
    resolveConfig('{{ leader_name }}', { leader_name: '万纯' }) === '万纯')
  check('an unconfigured placeholder is left alone',
    resolveConfig('{{provider}} 与 {{leader_name}}', { leader_name: '万纯' }) === '{{provider}} 与 万纯')
  check('a platform variable survives untouched', resolveConfig('{{provider}}', { leader_name: '万纯' }) === '{{provider}}')
  check('no config means no rewriting', resolveConfig('{{a}}', undefined) === '{{a}}')

  // The declaration is authoritative, so a key the record declares but leaves
  // empty is reported — while a placeholder the prose merely mentions is not,
  // which is what keeps a platform variable like {{provider}} out of the report.
  const block = renderConfigBlock({
    systemPrompt: '称呼 {{leader_name}}，通知 {{leader_chatid}}。',
    config: { leader_name: '万纯' },
    configSchema: [{ key: 'leader_name' }, { key: 'leader_chatid' }],
  }).join('\n')
  check('the block states the actual value', block.includes('| `leader_name` | 万纯 |'), block.slice(0, 200))
  check('the block names the unset declared key', block.includes('leader_chatid'))
  check('the block calls the unset ones unconfigured', block.includes('未配置'))

  const built = buildPresetDefinition(
    normalizeHuman({ id: 'cfg-five', name: 'Cfg', systemPrompt: '组长 {{leader_name}}。', config: { leader_name: '万纯' } }),
    { store, toolsPluginName: '@local/dsh-digital-human/tools', order: 900 },
  )
  const prefix = built.plugins[0].config.prefix
  check('the persona prefix carries the resolved value', prefix.includes('组长 万纯。'))
  check('the placeholder itself is gone', !prefix.includes('{{leader_name}}'))
  check('no suffix names the working directory', built.plugins[0].config.suffix === undefined)
  check('the prefix carries the config block', prefix.includes('## 配置（实际值）'))
}

console.log('8) platform facts are offered under generic names')
{
  // These names are general concepts, not one persona's vocabulary: a record maps
  // its own key onto one of them, so the plugin never recognises a business key.
  const owned = normalizeHuman({
    id: 'own-one',
    name: '研发PM助手',
    systemPrompt: '通知 {{leader_chatid}}。',
    peers: ['dev-assistant'],
    im: { botId: 'wecom_1', owner: 'wohR_KCgAANNc-oBb9OpaqueIdValueHere' },
  })
  const facts = builtinConfig(owned, { 'dev-assistant': '开发助手' })
  check('the record names itself', facts.self_name === '研发PM助手' && facts.self_id === 'own-one', JSON.stringify(facts))
  check('the owner yields both id and address',
    facts.owner_id === 'wohR_KCgAANNc-oBb9OpaqueIdValueHere' && facts.owner_chat === facts.owner_id)
  check('the peer yields both id and name', facts.peer_id === 'dev-assistant' && facts.peer_name === '开发助手')
  check('no owner yields no owner facts', builtinConfig({ im: { botId: 'x' } }).owner_chat === undefined)
  check('an unresolvable peer yields no peer facts',
    builtinConfig(normalizeHuman({ id: 'p', name: 'P', peers: ['gone'] })).peer_name === undefined)
  check('a fact resolves without any declaration',
    resolveConfig('通知 {{owner_chat}}', effectiveConfig(owned)) === '通知 wohR_KCgAANNc-oBb9OpaqueIdValueHere')
}

console.log('9) a declared schema decides what a persona sees')
{
  const declared = normalizeHuman({
    id: 'schema-one',
    name: '研发PM助手',
    systemPrompt: '你是「{{bot_name}}」，{{team_name}} 的一员。通知组长用 {{leader_chatid}}。',
    peers: ['dev-assistant'],
    im: { botId: 'wecom_1', owner: 'wohR_owner' },
    config: { team_name: 'TCTP开发一室', stale_key: 'should not leak' },
    configSchema: [
      { key: 'team_name', label: '团队名称', type: 'text' },
      { key: 'bot_name', from: 'self_name' },
      { key: 'peer_name', from: 'peer_name' },
      { key: 'leader_chatid', from: 'owner_chat' },
      { key: 'e2e_dir', default: 'docs/end-to-end' },
      { key: 'default_project', type: 'select', options: [{ label: '不指定', value: 'none' }] },
    ],
  })
  const peerNames = { 'dev-assistant': '开发助手' }
  const { values, sources } = resolveConfigValues(declared, peerNames)
  check('a declared key takes the configured value', values.team_name === 'TCTP开发一室' && sources.team_name === '配置')
  check('a declared fact resolves', values.bot_name === '研发PM助手' && sources.bot_name === '自动')
  check('a peer fact resolves from the registry', values.peer_name === '开发助手')
  check('the owner address resolves', values.leader_chatid === 'wohR_owner')
  check('a declared default is used', values.e2e_dir === 'docs/end-to-end' && sources.e2e_dir === '默认')
  check('an undeclared key never leaks into the prompt', values.stale_key === undefined, JSON.stringify(values))
  check('an unfilled optional key is reported as unconfigured', sources.default_project === '未配置')
  check('a fact the schema omits is not offered', values.self_id === undefined)

  const overridden = normalizeHuman({
    id: 'schema-two',
    name: 'X',
    im: { botId: 'wecom_1', owner: 'wohR_owner' },
    config: { leader_chatid: 'explicit-target' },
    configSchema: [{ key: 'leader_chatid', from: 'owner_chat' }],
  })
  check('an explicit value wins over the fact', effectiveConfig(overridden).leader_chatid === 'explicit-target')

  const block = renderConfigBlock(declared, peerNames).join('\n')
  check('the block states a configured value', block.includes('| `team_name` | TCTP开发一室 | 配置 |'))
  check('the block states an automatic value', block.includes('| `bot_name` | 研发PM助手 | 自动 |'))
  check('the block states a default', block.includes('| `e2e_dir` | docs/end-to-end | 默认 |'))
  check('the block names what is still unconfigured', block.includes('default_project') && block.includes('未配置'))
  check('the block never leaks an undeclared key', !block.includes('stale_key'))

  const built = buildPresetDefinition(declared, {
    store, toolsPluginName: '@local/dsh-digital-human/tools', order: 901, peerNames,
  })
  const prefix = built.plugins[0].config.prefix
  check('the prose carries the resolved values',
    prefix.includes('你是「研发PM助手」，TCTP开发一室 的一员。'), prefix.slice(0, 90))
  check('no declared placeholder survives', !/\{\{(team_name|bot_name|peer_name|leader_chatid)\}\}/.test(prefix))
  check('no suffix names the working directory', built.plugins[0].config.suffix === undefined)
}

console.log('10) an invalid declaration is refused, not ignored')
{
  const bad = (schema) => normalizeHuman({ id: 'bad-one', name: 'B', configSchema: schema })
  const refuses = (fn) => { try { fn(); return false } catch { return true } }
  check('a non-array schema is refused', refuses(() => bad('nope')))
  check('a field with no key is refused', refuses(() => bad([{ label: 'x' }])))
  check('an unknown type is refused', refuses(() => bad([{ key: 'a', type: 'color' }])))
  check('an unknown source is refused', refuses(() => bad([{ key: 'a', from: 'owner_email' }])))
  check('a malformed option is refused', refuses(() => bad([{ key: 'a', options: [{ label: 'x' }] }])))
  check('a valid field is kept', bad([{ key: 'a', type: 'select', options: [{ label: 'A', value: 'a' }] }]).configSchema.length === 1)
  // Hidden is presentation only: the field must still resolve and reach the prompt.
  const hidden = normalizeHuman({
    id: 'hidden-one',
    name: 'H',
    im: { botId: 'wecom_1', owner: 'wohR_owner' },
    configSchema: [{ key: 'owner_where', from: 'owner_chat', hidden: true }],
  })
  check('a hidden field is recorded', hidden.configSchema[0].hidden === true)
  check('a hidden field still resolves', effectiveConfig(hidden).owner_where === 'wohR_owner')
  check('a hidden field still reaches the block', renderConfigBlock(hidden).join('\n').includes('owner_where'))
  check('hidden is opt-in', normalizeHuman({ id: 'h2', name: 'H', configSchema: [{ key: 'a' }] }).configSchema[0].hidden === undefined)
}


console.log('11) no placeholder survives that the renderer would reject')
{
  // The renderer fails the WHOLE turn on a variable it does not know, so one stray
  // placeholder in a persona costs a session. A visible marker is the right trade.
  check('a registered variable survives', neutralizePlaceholders('dir {{provider}}') === 'dir {{provider}}')
  check('every registered name survives',
    neutralizePlaceholders('{{provider}} {{model}}') === '{{provider}} {{model}}')
  // The loop registers no `cwd`: the working-directory service states the directory
  // as literal context. A template asking for it must be defused, not passed through.
  check('cwd is not a platform variable', neutralizePlaceholders('{{cwd}}') === '〔未配置：cwd〕')
  check('an unknown name becomes a marker', neutralizePlaceholders('{{nope}}') === '〔未配置：nope〕')
  // A Chinese name is what a hand-written example looks like, and it is exactly
  // what a persona author writes without meaning it as a variable.
  check('a non-ASCII name is neutralised too', neutralizePlaceholders('{{名称}}') === '〔未配置：名称〕')
  check('surrounding text is kept', neutralizePlaceholders('用 {{x}} 表示') === '用 〔未配置：x〕 表示')
  check('a deployment can extend the set',
    neutralizePlaceholders('{{tenant}}', ['model', 'tenant']) === '{{tenant}}')
  check('an empty or missing text is safe',
    neutralizePlaceholders(undefined) === '' && neutralizePlaceholders('') === '')

  // And the assembled prompt must be clean for every real record.
  const humans = JSON.parse(readFileSync('/Users/harrywan/.dsh/digital-human/humans.json', 'utf8'))
  const peerNames = Object.fromEntries(humans.map((entry) => [entry.id, entry.name]))
  for (const human of humans) {
    const config = buildPresetDefinition(normalizeHuman(human), {
      store, toolsPluginName: '@local/dsh-digital-human/tools', order: 902, peerNames,
    }).plugins[0].config
    const left = config.prefix.match(/\{\{[^}]*\}\}/g) ?? []
    check(`${human.id} leaves only platform variables`,
      left.every((token) => ['{{provider}}', '{{model}}'].includes(token)), left.join(' '))
    check(`${human.id} resolves every declared field`,
      !left.some((token) => token.includes('team_name') || token.includes('peer_name') || token.includes('bot_name')))
  }
}

await rm(home, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
