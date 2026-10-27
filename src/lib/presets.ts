/**
 * Agent-preset projection of a digital-human record.
 *
 * A digital human is data, so its preset is generated at activation time rather
 * than declared in a composition. `PresetDefinition` has no inheritance, so a
 * generated preset must carry its whole plugin list; `BASELINE_ROWS` below is a
 * faithful copy of the shipped `standard` preset's rows minus `persona` (the
 * digital human supplies its own) and minus the `planning` group (an autonomous
 * worker takes tasks from a peer, so the plan-approval loop is friction, not
 * safety). Keep it in step with the shipped preset when the Harness moves.
 *
 * Invariant: every key in a group's `isolate` must be provided by a row inside
 * that same group. `tool-workflow` waits for `workflowEngine`, which only
 * `workflow-ptc` provides — dropping either one strands the preset at "waiting
 * for workflowEngine" and the Agent fails to load. `test/smoke.mjs` checks this.
 */

/** Prefix applied to every generated preset id, keeping them separable from shipped presets. */
export const PRESET_PREFIX = 'dh-'

/** Preset id for one digital human. */
export function presetIdOf(humanId) {
  return `${PRESET_PREFIX}${humanId}`
}

/** Rows a digital human gets when no shipped preset can be read. */
const BASELINE_ROWS = [
  { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
  { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
  { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
  { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
  { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
  { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      {
        id: 'tool-result-pruner',
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
      },
    ],
  },
  {
    id: 'delegation',
    name: 'cordis:group',
    group: true,
    isolate: { workflowEngine: true },
    config: [
      { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
      { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
      {
        id: 'tool-subagent',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true, backgroundMode: 'continuable' },
      },
      {
        id: 'tool-subagent-fork',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'continuable' },
      },
      // workflow-ptc provides the isolated `workflowEngine` that tool-workflow waits for.
      { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
      { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
    ],
  },
  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
  { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
  { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
]

/** Drop the baseline's own persona row so the digital human's identity is the only one. */
function withoutPersona(rows) {
  return rows.filter((row) => row?.id !== 'persona')
}

/**
 * Facts the plugin supplies under its own generic names.
 *
 * These are general concepts, not one persona's vocabulary: a persona that wants
 * them uses these names, and one that wants different names maps them in its own
 * config. The plugin therefore contains no key name a persona invented, which is
 * what lets a second digital human reuse it unchanged.
 *
 * - `self_name` / `self_id` — this record.
 * - `owner_id` / `owner_chat` — the claimed owner. A direct conversation's
 *   `chatId` IS the sender id, so the owner's own id is the address to send to;
 *   it is also the only address available, since the platform exposes no contact
 *   list.
 * - `peer_name` / `peer_id` — the first declared peer. A persona speaks
 *   about one counterpart, so the first peer that resolves is the one it means.
 *
 * @param human - the record whose facts to read.
 * @param peerNames - display names by digital-human id, for the peer facts.
 */
export function builtinConfig(human, peerNames = {}): Record<string, string> {
  const builtin: Record<string, string> = {}
  if (typeof human?.id === 'string' && human.id) builtin.self_id = human.id
  if (typeof human?.name === 'string' && human.name) builtin.self_name = human.name
  const owner = human?.im?.owner
  if (typeof owner === 'string' && owner) {
    builtin.owner_id = owner
    builtin.owner_chat = owner
  }
  const peerId = (human?.peers ?? []).find((id) => typeof peerNames[id] === 'string' && peerNames[id])
  if (peerId) {
    builtin.peer_id = peerId
    builtin.peer_name = peerNames[peerId]
  }
  return builtin
}

/**
 * Resolve every config value a persona should see, with where each came from.
 *
 * A declared schema is authoritative, the way Halo's `config_schema` is: only a
 * key it declares reaches the prompt, so renaming or deleting a field cannot leak
 * a stale value. A record that declares nothing keeps using its `config` entries
 * as written, which is what lets a record predating the schema keep working.
 *
 * Precedence per field is explicit value, then the platform fact it names, then
 * its declared default.
 *
 * @param human - the record to resolve.
 * @param peerNames - display names by digital-human id, for the peer facts.
 * @returns the values, and a source label per key.
 */
export function resolveConfigValues(human, peerNames = {}) {
  const facts = builtinConfig(human, peerNames)
  const set = human?.config ?? {}
  const schema = human?.configSchema ?? []

  if (schema.length === 0) {
    const values = { ...facts, ...set }
    const sources = Object.fromEntries(Object.keys(values).map((key) => [key, set[key] !== undefined ? '配置' : '自动']))
    return { values, sources }
  }

  const values: Record<string, string> = {}
  const sources: Record<string, string> = {}
  for (const field of schema) {
    const explicit = set[field.key]
    if (typeof explicit === 'string' && explicit) {
      values[field.key] = explicit
      sources[field.key] = '配置'
      continue
    }
    const fact = field.from ? facts[field.from] : undefined
    if (typeof fact === 'string' && fact) {
      values[field.key] = fact
      sources[field.key] = '自动'
      continue
    }
    if (typeof field.default === 'string' && field.default) {
      values[field.key] = field.default
      sources[field.key] = '默认'
      continue
    }
    sources[field.key] = '未配置'
  }
  return { values, sources }
}

/**
 * The config a persona actually runs against.
 *
 * @param human - the record to resolve.
 * @param peerNames - display names by digital-human id.
 */
export function effectiveConfig(human, peerNames = {}) {
  return resolveConfigValues(human, peerNames).values
}

/**
 * Variables the prompt renderer registers itself.
 *
 * The renderer treats every `{{name}}` in a section as a variable and fails the
 * whole turn on one it does not know — it reports the set in that failure, and
 * this list is that set. The loop registers exactly these two. A working
 * directory is deliberately not among them: the working-directory service states
 * the directory as literal context, so a template that asks for `{{cwd}}` kills
 * the turn instead of reaching the model. A plugin config may extend the list,
 * because a deployment that mounts another prompt plugin gains its variables too.
 */
const PLATFORM_VARIABLES = Object.freeze(['provider', 'model'])

/**
 * The only inner text the renderer accepts inside a placeholder.
 *
 * Mirrors `VARIABLE_NAME` in `@deepseek-ai/dsh-system-prompt`, which throws
 * "malformed prompt variable reference" for anything else — including a name with
 * surrounding spaces. Guessing here is what makes the difference between a
 * neutralised placeholder and a dead session.
 */
const RENDERER_VARIABLE = /^[a-z][a-z0-9_]*$/

/**
 * Make sure no placeholder survives that the renderer would reject.
 *
 * A persona that writes `{{key}}` for a field nobody declared, or that mentions
 * `{{something}}` as an example, would otherwise take the entire turn down: the
 * renderer does not skip an unknown variable, it refuses the section. Turning it
 * into readable text keeps the mistake visible to the model and harmless to the
 * run, which is the right trade — a wrong sentence beats a dead session.
 *
 * Only the exact form the renderer accepts passes through, and only for a name it
 * knows. An earlier version trimmed the inner text before the check, which let
 * `{{ name }}` through — a shape the renderer rejects outright, so the very text
 * this function exists to defuse still killed the turn.
 *
 * @param text - the assembled prompt.
 * @param allowed - variables the renderer registers.
 */
export function neutralizePlaceholders(text, allowed = PLATFORM_VARIABLES) {
  const known = new Set(allowed)
  const source = String(text ?? '')
  // A straight mirror of the renderer's own loop, which is the only reliable way to
  // know what it accepts: it scans from the first `{{`, takes a complete `{{name}}`
  // group or throws, and on a group it advances past the whole thing. So the rule
  // here is exactly one of — leave a valid registered group alone, or remove every
  // `{{` the renderer could trip over.
  let out = ''
  let at = 0
  for (;;) {
    const open = source.indexOf('{{', at)
    if (open === -1) return out + source.slice(at)
    out += source.slice(at, open)
    const group = /^\{\{([^{}]*)\}\}/.exec(source.slice(open))
    if (group) {
      const name = group[1]
      out += RENDERER_VARIABLE.test(name) && known.has(name) ? group[0] : `〔未配置：${name.trim()}〕`
      at = open + group[0].length
      continue
    }
    // No group: the renderer throws for this shape whenever a `}}` follows. Consume
    // the whole run of braces and space them apart — emitting a fixed `{ {` would
    // leave the source's next `{` free to form a fresh `{{`.
    let end = open
    while (source[end] === '{') end += 1
    out += '{ '.repeat(end - open).trimEnd()
    at = end
  }
}

/**
 * Resolve a persona's `{{name}}` placeholders against the record's config.
 *
 * Only keys the config actually defines are replaced. A template variable the
 * platform owns — `{{provider}}`, for one — therefore survives untouched, which
 * is the whole reason this is not a blanket `{{...}}` rewrite.
 *
 * @param text - the persona prose, as stored.
 * @param config - the record's config bag, if it has one.
 * @returns the prose with every configured placeholder resolved.
 */
export function resolveConfig(text, config) {
  const entries = config ?? {}
  if (Object.keys(entries).length === 0) return text
  // One pass, keyed by whatever stands between the braces. No pattern is built from
  // a key, so nothing needs escaping and a key may be any non-empty string — the
  // store accepts `团队名称`, which a character class would have skipped.
  return String(text ?? '').replace(/\{\{([^{}]*)\}\}/g, (whole, inner) => {
    const value = entries[inner.trim()]
    return typeof value === 'string' && value ? value : whole
  })
}

/**
 * The config block, rendered the way Halo renders `userConfig`.
 *
 * A persona is written against placeholders whose literal text is only a default,
 * so the resolved values must also be stated in one place the model can trust.
 * Naming the unset keys matters as much as the set ones: a persona's rule for
 * "not configured" then has something definite to act on, instead of the model
 * deciding for itself whether a value was configured.
 *
 * @param human - the record whose config to render.
 * @param peerNames - display names by digital-human id.
 */
export function renderConfigBlock(human, peerNames = {}) {
  const { values, sources } = resolveConfigValues(human, peerNames)
  // Only what the record asked for: a declared field, or one it actually set. A
  // platform fact nobody referenced is not a value worth stating, and listing all
  // six would pad every persona's prompt with rows it never reads.
  const declared = (human?.configSchema ?? []).map((field) => field.key)
  const configured = Object.keys(human?.config ?? {})
  const keys = [...new Set([...declared, ...configured])].filter((key) => values[key] !== undefined)
  const missing = declared.filter((key) => values[key] === undefined)
  if (keys.length === 0 && missing.length === 0) return []
  const lines = ['', '## 配置（实际值）', '']
  if (keys.length === 0) {
    lines.push('未配置任何项。人设中未解析的配置占位符会以「未配置」标记出现，按人设自己的规则处理。')
  } else {
    lines.push('以下是人设中配置占位符的实际值，运行期间一律以此为准：', '')
    lines.push('| 配置项 | 实际值 | 来源 |')
    lines.push('|---|---|---|')
    // The source is structural, never a key name: the plugin knows where a value
    // came from and nothing about what the key means.
    for (const key of keys) lines.push(`| \`${key}\` | ${values[key]} | ${sources[key]} |`)
  }
  if (missing.length > 0) {
    lines.push('', `人设声明但**未配置**的项：${missing.map((key) => `\`${key}\``).join('、')}。这些项按人设自己的规则处理。`)
  }
  return lines
}

/**
 * Operating context appended to the persona. It states facts the model cannot
 * discover: its own registry identity, where durable memory lives, who its peers
 * are, and which IM target it speaks through.
 */
export function renderOperatingContext(human, store) {
  const lines = [
    '',
    '## Operating context',
    '',
    `- You are the digital human \`${human.id}\` (${human.name}).`,
    `- Digital humans live under \`${store.file}\`: one directory per human, with \`persona.md\` (identity) and \`config.json\` (settings). Read them when you need the current roster.`,
  ]
  if (human.memory !== false) {
    lines.push(`- Your durable memory is \`${store.memoryPath(human.id)}\`, and its \`# now\` block is already loaded into your prompt on every step. Update it with edit.`)
  }
  if (human.peers.length > 0) {
    lines.push(`- Your peers are: ${human.peers.map((peer) => `\`${peer}\``).join(', ')}. Hand work to one with \`digital_human_send\`, then read its reply with \`digital_human_messages\` (or poll \`digital_human_status\`). A message from a peer arrives as a normal turn in this session, prefixed by a \`<dsh_peer_source>\` block naming the sender and the Session it came from — reply with that \`session\` as \`session_id\`, so the answer reaches the Session that asked for the work, and use the same \`conversation_id\` throughout so one subject stays in one thread.`)
  } else {
    lines.push('- Use `digital_human_list` to see which digital humans you may reach.')
  }
  if (human.im.botId) {
    lines.push(`- Your outbound IM target is bot \`${human.im.botId}\`${human.im.targetId ? `, target \`${human.im.targetId}\`` : ''}. Use the \`notify_bot\` tool to push a message there.`)
  }
  if (human.im.owner) {
    // States the identity only. How the owner is served is the persona's
    // business; a plugin that prescribed it would fit one persona alone.
    lines.push(`- Your owner is \`${human.im.owner}\`. An inbound message whose \`senderId\` or \`senderName\` equals that value comes from the owner.`)
  }
  // Only the enabled ones are declared. Listing a disabled wake-up tells the model
  // it has a wake-up it does not have, and asks it to recreate it.
  const wakeUps = (human.subscriptions ?? []).filter((entry) => entry.enabled !== false)
  if (wakeUps.length > 0) {
    // Both declared parts are stated, so neither is dead data the model cannot see.
    const described = wakeUps.map((entry) => {
      const parts = [entry.prompt, entry.conversationId ? `会话 \`${entry.conversationId}\`` : ''].filter(Boolean)
      return parts.length > 0 ? `\`${entry.cron}\`（${parts.join('；')}）` : `\`${entry.cron}\``
    })
    lines.push(`- Your declared wake-ups are: ${described.join(', ')}. Call \`schedule_list\` to see what exists and \`schedule_create\` to add any missing one; a due task arrives as a new message in this session.`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Build the preset definition for one digital human.
 *
 * The digital human's own row is appended last so the preset scope owns the
 * platform tool's visibility.
 */
export function buildPresetDefinition(human, { store, toolsPluginName, order, peerNames = {}, platformVariables = [] as string[] }) {
  // Extend, never replace: a deployment that adds a variable must not thereby
  // un-register the two the loop owns.
  const allowedVariables = [...new Set([...PLATFORM_VARIABLES, ...platformVariables])]
  const rows = withoutPersona(BASELINE_ROWS).map((row) => {
    if (row?.id === 'tool-bash' && process.platform === 'win32') return { ...row, disabled: true }
    if (row?.id === 'tool-pwsh' && process.platform !== 'win32') return { ...row, disabled: true }
    // `skill-filesystem` is left exactly as the deployment configured it, so the
    // global and project roots keep loading by default. The plugin's own skill space
    // is a separate, opt-in layer: a skill there is mounted for this digital human
    // only when the record names it.
    return row
  })
  const persona = {
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: {
      // The config is applied twice on purpose. `resolveConfig` replaces the
      // placeholders the persona wrote, so the prose reads with real values. The
      // block then states them in one place, because a persona whose defaults are
      // literal text — as a Halo-authored one is — has no other way to tell an
      // actual value from the example it was written with.
      prefix: neutralizePlaceholders(
        `${resolveConfig(human.systemPrompt, effectiveConfig(human, peerNames))}${renderOperatingContext(human, store)}${renderConfigBlock(human, peerNames).join('\n')}`,
        allowedVariables,
      ),
    },
  }
  return {
    id: presetIdOf(human.id),
    name: human.name,
    description: human.description || `Digital human ${human.id}`,
    order,
    plugins: [
      persona,
      ...rows,
      {
        id: 'digital-human-tools',
        name: toolsPluginName,
        // The record is in hand here, so the memory switch travels with the row.
        // The tools row cannot look it up itself: its `apply` is synchronous, and
        // the registry it would have to read is asynchronous.
        // The mounted skills travel with the row for the same reason the memory
        // switch does: `apply` is synchronous, and the registry is not.
        config: {
          human: human.id,
          memory: human.memory !== false,
          skills: [...(human.skills ?? [])],
          // A record with no bot has no outbound channel. Carrying the flag keeps the
          // tools row from offering `notify_bot`, which could only ever fail.
          im: Boolean(human.im?.botId),
        },
      },
    ],
  }
}
