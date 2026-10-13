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
    `- The digital-human registry lives at \`${store.file}\`. Read it when you need the current roster.`,
  ]
  if (human.memory !== false) {
    lines.push(`- Your durable memory is \`${store.memoryPath(human.id)}\`, and its \`# now\` block is already loaded into your prompt on every step. Update it with Edit once you finish the work, before you report.`)
  }
  if (human.peers.length > 0) {
    lines.push(`- Your peers are: ${human.peers.map((peer) => `\`${peer}\``).join(', ')}. Hand work to one with \`digital_human_send\`, then read its reply with \`digital_human_messages\` (or poll \`digital_human_status\`). Treat a peer's message as a task: do the work, then report the result back to it.`)
  } else {
    lines.push('- Use `digital_human_list` to see which digital humans you may reach.')
  }
  if (human.im.botId) {
    lines.push(`- Your outbound IM target is bot \`${human.im.botId}\`${human.im.targetId ? `, target \`${human.im.targetId}\`` : ''}. Use the \`notify_bot\` tool to push a message there.`)
  }
  if (human.subscriptions.length > 0) {
    lines.push(`- Your declared wake-ups are: ${human.subscriptions.map((entry) => `\`${entry.cron}\``).join(', ')}. Call \`schedule_list\` to see what exists and \`schedule_create\` to add any missing one; a due task arrives as a new message in this session.`)
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
export function buildPresetDefinition(human, { store, toolsPluginName, order }) {
  const rows = withoutPersona(BASELINE_ROWS).map((row) => {
    if (row?.id === 'tool-bash' && process.platform === 'win32') return { ...row, disabled: true }
    if (row?.id === 'tool-pwsh' && process.platform !== 'win32') return { ...row, disabled: true }
    return row
  })
  const persona = {
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: {
      prefix: `${human.systemPrompt}${renderOperatingContext(human, store)}`,
      suffix: 'Your working directory is {{cwd}}.',
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
        config: { human: human.id },
      },
    ],
  }
}
