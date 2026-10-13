/**
 * Regenerate src/lib/seed.ts from the Halo specifications.
 *
 * Halo keeps each digital human in `installed_apps.spec_json` of its SQLite
 * database. Run this after Halo's specifications change, so the seed stays a
 * faithful copy instead of a hand-written paraphrase.
 *
 * Usage: node tools/import-halo-specs.mjs [path/to/halo.db]
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DB = process.argv[2] ?? join(homedir(), '.halo-webank', 'halo.db')
const HERE = dirname(fileURLToPath(import.meta.url))
const NAMES = { '开发助手': 'dev-assistant', '研发PM助手': 'pm-assistant' }
const SUB_PROMPT = '定时唤醒：按技能里的轮询与汇报纪律巡检在跟踪的需求，推进并汇报。'

/** The skill this platform retires; the native tools replace it. */
const RETIRED_SKILL = 'halo-agent-collab'

const NATIVE = '`digital_human_send`（发消息）、`digital_human_messages`（取回复）、'
  + '`digital_human_status`（查状态）、`digital_human_stop`（中止）'

/**
 * Halo drives digital-human messaging through its own REST bridge and ships the
 * `halo-agent-collab` skill to teach it. This platform has no such bridge: the
 * `digital_human_*` tools replace it. The rewrites below retarget the Halo
 * wording onto those tools, so the personas stay otherwise verbatim and no
 * reference survives to a skill that does not exist.
 *
 * `shared` applies to every persona; the per-id lists apply to one only. Every
 * entry must match, so a Halo wording change fails the import instead of
 * silently leaving stale text behind.
 */
const REWRITES = {
  shared: [
    ['、pace-cli-helper、halo-agent-collab。', '、pace-cli-helper。'],
    ['REST 通道', '协作通道'],
    ['REST 协作通道', '协作通道'],
  ],
  'dev-assistant': [
    ['- `collab_peer_app_id`：研发PM助手（PM）的应用 ID，协作通道的目标。',
     '- `peer`：研发PM助手（PM）的同伴 id，固定为 `pm-assistant`。'],
    ['- `collab_space_id`：研发PM助手 所在空间 ID。',
     '- `conversation_id`：协作会话 id，按需求版本命名（见核心准则）。'],
    ['- `halo_token`：Halo 远程访问密码；**为空时数字人协作通道不可用**（见「与 PM 的协作通信」）。\n', ''],
    ['- `halo_port`：Halo HTTP 端口，默认 `3456`。\n', ''],
    ['- **`halo_token` 为空或发送失败**：协作通道不可用——把待上报事项记入 memory（含需求名/事件/材料路径），在 progress.md 留痕，下次运行重试；同时在本地继续推进不受影响。连续 2 次仍失败时，用 notify_channel 群发一条运维提醒（注明「数字人协作通道不可用，请检查 Halo 远程访问与 halo_token 配置」）。',
     '- **`digital_human_send` 发送失败**：把待上报事项记入 memory（含需求名/事件/材料路径），在 progress.md 留痕，下次运行重试；同时在本地继续推进不受影响。连续 2 次仍失败时，用 notify_channel 群发一条运维提醒（注明「数字人协作通道发送失败」）。'],
    ['- **halo-agent-collab**：**与 PM 通信的唯一通道**——发消息、取 PM 回复都通过它完成。调用它时传入目标（collab_peer_app_id）、空间（collab_space_id）、认证（halo_token）与端口（halo_port）。',
     `- **内置协作工具**：**与 PM 通信的唯一通道**——${NATIVE}。同伴 id：研发PM助手 为 \`pm-assistant\`。`],
    ['研发PM助手 建档完成后通过 halo-agent-collab（chat/send）给你发',
     '研发PM助手 建档完成后通过 `digital_human_send` 给你发'],
    ['**不存在 get_automation_status / trigger_automation_app 等内置工具，不要尝试使用它们。与 研发PM助手 的一切通信都通过 halo-agent-collab 技能**：PM 应用 ID 读配置 `collab_peer_app_id`，空间 ID 读 `collab_space_id`，认证 `halo_token`，端口 `halo_port`（默认 3456）。',
     `**与 研发PM助手 的一切通信都通过内置协作工具**：${NATIVE}。同伴 id 为 \`pm-assistant\`，会话用 \`conversation_id\` 指定。`],
    ['**立即通过 halo-agent-collab 给 研发PM助手 发完成消息**',
     '**立即通过 `digital_human_send` 给 研发PM助手 发完成消息**'],
    ['**通过 halo-agent-collab 给 研发PM助手 发阻塞消息**',
     '**通过 `digital_human_send` 给 研发PM助手 发阻塞消息**'],
    ['- **不使用内置数字人管理工具**：与 PM 通信一律走 halo-agent-collab 技能（REST）。',
     `- **通信一律走内置协作工具**：${NATIVE}。`],
  ],
  'pm-assistant': [
    ['通信机制（REST API、conversationId 等）', '通信机制（digital_human_send、conversationId 等）'],
    ['敏感信息包括但不限于：`halo_token` 等一切配置项实际值（密码/密钥/端口/协作目标数字人 ID 与空间 ID）',
     '敏感信息包括但不限于：`conversation_id` 等一切配置项实际值（密码/密钥/协作目标同伴 id）'],
    ['| `collab_peer_app_id` | 开发助手 的应用 ID，协作通道的目标 |',
     '| `peer` | 开发助手 的同伴 id，固定为 `dev-assistant` |'],
    ['| `collab_space_id` | 开发助手 所在空间 ID（chat/send 时必填） |',
     '| `conversation_id` | 协作会话 id（见核心准则第 4 条），发送时传入 |'],
    ['| `halo_token` | Halo 远程访问密码。**为空时数字人协作通道不可用**，提示用户在设置 → 远程访问开启后填入 |\n', ''],
    ['| `halo_port` | Halo HTTP 端口，默认 `3456` |\n', ''],
    ['4. **halo_token 为空或发送失败**：协作通道不可用——告知用户「需求已建档，但数字人协作通道未启用/失败」，请用户检查远程访问与 halo_token 配置；同时把待通知事项记入 memory，下次运行重试。不得静默失败。',
     '4. **`digital_human_send` 发送失败**：告知用户「需求已建档，但数字人协作通道发送失败」；同时把待通知事项记入 memory，下次运行重试。不得静默失败。'],
    ['| **halo-agent-collab** | **数字人协作的唯一通道**——与 开发助手 的一切通信（发消息、取回复）都通过它完成。调用时传入目标（collab_peer_app_id）、空间（collab_space_id）、认证（halo_token）与端口（halo_port）。支持 body 传自定义 `conversationId` 定向会话（见核心准则第 4 条与职责六的版本隔离规则）；对 开发助手 的等待只做**有界短确认**（见职责六），不做长时间监听 |',
     `| **内置协作工具** | **数字人协作的唯一通道**——与 开发助手 的一切通信都通过 ${NATIVE} 完成。同伴 id 为 \`dev-assistant\`。用 \`conversation_id\` 定向会话（见核心准则第 4 条与职责六的版本隔离规则）；对 开发助手 的等待只做**有界短确认**（见职责六），不做长时间监听 |`],
    ['**halo-agent-collab 技能是与 开发助手 通信的唯一方式——不存在 get_automation_status / trigger_automation_app 等内置工具，也不要尝试使用它们。**开发助手 应用 ID 读配置 `collab_peer_app_id`，空间 ID 读 `collab_space_id`，认证 `halo_token`，端口 `halo_port`。',
     `**内置协作工具是与 开发助手 通信的唯一方式——${NATIVE}。**开发助手 的同伴 id 为 \`dev-assistant\`，会话用 \`conversation_id\` 指定。`],
    ['需求建档完成后，调用 halo-agent-collab 技能前**先过两道门禁**：',
     '需求建档完成后，调用 `digital_human_send` 前**先过两道门禁**：'],
  ],
}

function applyRewrites(id, prompt) {
  let out = prompt
  for (const [find, replace] of [...REWRITES.shared, ...REWRITES[id]]) {
    if (!out.includes(find)) throw new Error(`${id}: rewrite target not found: ${find.slice(0, 60)}`)
    out = out.split(find).join(replace)
  }
  if (out.includes(RETIRED_SKILL)) throw new Error(`${id}: a ${RETIRED_SKILL} reference survived`)
  for (const term of ['halo_token', 'halo_port', 'collab_space_id', 'collab_peer_app_id']) {
    if (out.includes(term)) throw new Error(`${id}: a ${term} reference survived`)
  }
  return out
}

const rows = execFileSync('sqlite3', [DB, "SELECT spec_id, spec_json FROM installed_apps WHERE spec_id IN ('开发助手','研发PM助手');"], { encoding: 'utf8' })
const specs = {}
for (const line of rows.split('\n')) {
  const at = line.indexOf('|')
  if (at < 0) continue
  const name = line.slice(0, at)
  specs[NAMES[name] ?? name] = JSON.parse(line.slice(at + 1))
}

const records = []
for (const [id, spec] of Object.entries(specs)) {
  const peer = id === 'dev-assistant' ? 'pm-assistant' : 'dev-assistant'
  const values = Object.fromEntries((spec.config_schema ?? []).map((entry) => [entry.key, entry.default ?? '']))
  values.collab_peer_app_id = peer
  values.collab_space_id = '~/.dsh/digital-human'
  values.halo_token = ''
  values.halo_port = ''
  const subscriptions = []
  for (const entry of spec.subscriptions ?? []) {
    const cron = entry?.source?.config?.cron
    if (cron) subscriptions.push({ cron, prompt: SUB_PROMPT, enabled: true })
  }
  const filled = String(spec.system_prompt).replace(/\{([a-z_]+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole))
  records.push({
    id,
    name: spec.name,
    description: spec.description,
    enabled: true,
    systemPrompt: applyRewrites(id, filled),
    workspace: '',
    skills: (spec.requires?.skills ?? []).map((entry) => entry.id).filter((skill) => skill !== RETIRED_SKILL),
    peers: [peer],
    im: { botId: '', targetId: '' },
    subscriptions,
    memory: true,
    escalation: { enabled: true, timeoutHours: 24 },
  })
}

writeFileSync(join(HERE, '..', 'src', 'lib', 'seed.ts'), `/**
 * Seed records for the two digital humans.
 *
 * Generated by tools/import-halo-specs.mjs from the Halo 1.4 specifications.
 * Do not edit by hand.
 */

/** Records created when the registry file does not exist yet. */
export const SEED_HUMANS = ${JSON.stringify(records, null, 2)}
`, 'utf8')
console.log(`wrote ${records.length} records: ${records.map((r) => r.id).join(', ')}`)
