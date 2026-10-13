/**
 * Preset-scoped half of the digital-human platform.
 *
 * Mounted by each generated `dh-<id>` preset, so every tool below closes over the
 * calling digital human's identity. That is why the tools never have to infer who
 * is calling: a preset cannot mount the Host row itself, and this row is the only
 * way a preset gets its own tool surface.
 *
 * This module imports nothing beyond node builtins, so it resolves from a profile
 * whose dependency tree the package does not own.
 */

import { buildHumanTools } from './lib/tools.js'
import { memoryPaths, renderMemoryContext } from './lib/memory.js'
import { loadSkills } from './lib/skills.js'
import type { Config, Ctx } from './lib/types.js'

/** Cordis plugin name. */
export const name = 'digital-human-tools'

/**
 * Mount this digital human's own skills.
 *
 * Registered from the preset scope, so they land in this preset's layer alone: the
 * plugin's skill space is shared by every digital human, and the record's list is
 * what makes a skill visible to one of them. A runtime registration outranks a
 * user (global) entry of the same name, so a private skill can replace a global one
 * for this digital human without touching the deployment's directory.
 *
 * A name with no skill behind it is reported rather than skipped: a record that
 * mounts a skill nobody uploaded is a mistake worth seeing.
 */
function mountSkills(ctx: Ctx, human: string, config: Config): void {
  const wanted = Array.isArray(config.skills) ? config.skills.filter((entry) => typeof entry === 'string') : []
  if (wanted.length === 0) return
  const register = ctx.skills?.register
  if (typeof register !== 'function') {
    ctx.logger?.warn?.(`digital human ${human} mounts ${wanted.length} skill(s), but the skill registry is absent`)
    return
  }
  const home = ctx.digitalHumans?.home
  if (typeof home !== 'string') return
  const { skills, missing } = loadSkills(home, wanted)
  for (const skill of skills) {
    register.call(ctx.skills, {
      name: skill.name,
      description: skill.description || skill.name,
      ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
      content: skill.content,
      ...(skill.path ? { path: skill.path } : {}),
    })
  }
  if (missing.length > 0) {
    ctx.logger?.warn?.(`digital human ${human} mounts skill(s) that are not in the library: ${missing.join(', ')}`)
  }
}

/** Services this plugin reads: the registry, the tool registry, and prompt assembly. */
export const inject = ['digitalHumans', 'tools', 'systemPrompt', 'skills']

/**
 * Prompt-context order of the memory block. Below the repository-owned context
 * orders (sandbox policy is 110), so a digital human reads its own memory before
 * it reads deployment policy.
 */
const MEMORY_CONTEXT_ORDER = 50

/**
 * Register the chat, IM, and memory surface of one digital human.
 * @param ctx - the preset scope context.
 * @param config - `human` names the owning digital human; validated here because
 *   the package exports no schema.
 */
export function apply(ctx: Ctx, config: Config = {}): void {
  const human = typeof config.human === 'string' ? config.human.trim() : ''
  if (!human) throw new Error('digital-human-tools requires a non-empty config.human')
  // Carried on the row, not read back from the registry: `apply` is synchronous and
  // the registry is not, so an awaited lookup here would never have been awaited —
  // which is exactly how the switch came to be ignored.
  const memory = config.memory !== false
  for (const tool of buildHumanTools({ ctx, service: ctx.digitalHumans, humanId: human, memory })) {
    ctx.tools.register(tool)
  }
  mountSkills(ctx, human, config)
  if (!memory) return
  const paths = memoryPaths(ctx.digitalHumans.store, human)
  // The provider re-reads on every assembly, so an edit the model made during a
  // turn is already visible on its next step. `# now` stays small by construction.
  ctx.systemPrompt.context({
    name: 'digital-human-memory',
    order: MEMORY_CONTEXT_ORDER,
    text: () => renderMemoryContext(paths),
  })
}
