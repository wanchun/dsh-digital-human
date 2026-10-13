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
import type { Config, Ctx } from './lib/types.js'

/** Cordis plugin name. */
export const name = 'digital-human-tools'

/** Services this plugin reads: the registry, the tool registry, and prompt assembly. */
export const inject = ['digitalHumans', 'tools', 'systemPrompt']

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
  for (const tool of buildHumanTools({ ctx, service: ctx.digitalHumans, humanId: human })) {
    ctx.tools.register(tool)
  }
  if (ctx.digitalHumans.require(human)?.memory === false) return
  const paths = memoryPaths(ctx.digitalHumans.store, human)
  // The provider re-reads on every assembly, so an edit the model made during a
  // turn is already visible on its next step. `# now` stays small by construction.
  ctx.systemPrompt.context({
    name: 'digital-human-memory',
    order: MEMORY_CONTEXT_ORDER,
    text: () => renderMemoryContext(paths),
  })
}
