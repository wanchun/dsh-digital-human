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

/** Body of a global skill the record did not enable. */
const DISABLED_SKILL_BODY = '该技能未在本数字人启用'

/**
 * Hide every global skill the record did not enable.
 *
 * Skills live only in the deployment's shared `~/.agents/skills` root, where the
 * skill provider mounts them for every agent. `config.skills` is this digital
 * human's whitelist: the nearest layer wins a duplicate name, so contributing a
 * same-name shadow candidate with `modelInvocable: false` is what turns "not
 * checked" into "not offered to this digital human". The catalog is read, never
 * listed by name.
 *
 * Registered from the preset scope, so the shadows land in this preset's layer
 * alone; the bodies themselves stay where the operator installed them.
 */
function whitelistSkills(ctx: Ctx, human: string, config: Config): void {
  const wanted = Array.isArray(config.skills) ? config.skills.filter((entry) => typeof entry === 'string') : []
  shadowUncheckedSkills(ctx, human, new Set(wanted))
}

/**
 * Provider label of the whitelist shadows; unique inside one skill registry.
 *
 * A provider, not a runtime registration: a preset's own skill provider supplies
 * the catalog this whitelist has to compare against, and a runtime registration
 * cannot read that catalog (a scoped `list()` needs the scope key, which is not
 * exposed to a plugin). A provider is handed the same lookup options the caller
 * used — including the scope — so it can read the merged catalog and contribute
 * the shadows in the same pass.
 */
const SHADOW_PROVIDER = 'digital-human-whitelist'

/** Marks the provider's own nested read, so it cannot recurse into itself. */
const SHADOW_PROBE = Symbol('digital-human-shadow-probe')

/**
 * Hide every catalog skill the record did not enable.
 *
 * `config.skills` is a whitelist: a skill the record did not name is replaced by a
 * same-name candidate whose `modelInvocable` is false and whose body is one
 * sentence. A rank of 0 wins the name inside this preset's layer, and the layer
 * wins the global one, so the real body never reaches this digital human.
 *
 * The shadow is computed on every catalog read, which keeps it in step with a
 * provider that registers after this preset is mounted. A skill the catalog
 * already hides is skipped: overriding it would replace a real user-invocable body
 * with the sentence for no gain.
 */
function shadowUncheckedSkills(ctx: Ctx, human: string, enabled: Set<string>): void {
  const skills = ctx.skills
  const registerProvider = skills?.registerProvider
  const snapshot = skills?.snapshot
  if (typeof registerProvider !== 'function' || typeof snapshot !== 'function') return
  try {
    registerProvider.call(skills, () => ({
      name: SHADOW_PROVIDER,
      /**
       * Read the merged catalog and report one shadow per enabled-missing name.
       *
       * The nested read is marked, so this provider answers it with no candidates;
       * otherwise the read would call itself forever.
       */
      async list(options: any) {
        if (options?.[SHADOW_PROBE] === true) return []
        const catalog = await snapshot.call(skills, { ...(options ?? {}), [SHADOW_PROBE]: true })
        const shadows: any[] = []
        for (const entry of Array.isArray(catalog?.skills) ? catalog.skills : []) {
          const name = entry?.name
          if (typeof name !== 'string' || name === '') continue
          if (enabled.has(name)) continue
          if (entry.invocation?.modelInvocable === false) continue
          shadows.push({
            name,
            description: entry.description || name,
            // Neither surface offers a skill this record did not enable.
            invocation: { modelInvocable: false, userInvocable: false },
            source: 'digital-human',
            provider: SHADOW_PROVIDER,
            rank: 0,
            locator: name,
          })
        }
        return shadows
      },
      /** The disabled sentence is the whole body a shadow ever loads. */
      async get(candidate: any) {
        return {
          name: candidate.name,
          description: candidate.description,
          invocation: candidate.invocation,
          source: candidate.source,
          provider: SHADOW_PROVIDER,
          content: DISABLED_SKILL_BODY,
          ...(candidate.path ? { path: candidate.path } : {}),
        }
      },
    }))
  } catch (error) {
    ctx.logger?.warn?.(`digital human ${human} could not register the skill whitelist: ${error.message}`)
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
  // Carried on the row for the same reason: a record with no bot has no outbound
  // channel, so the IM tools are not offered at all.
  const im = config.im !== false
  // Same reason again: choosing a file per conversation needs the record's scope,
  // and `apply` cannot await the registry to read it.
  const memoryScope = config.memoryScope === 'session' ? 'session' : 'record'
  // Same reason again: which records may archive a requirement is decided from the
  // record, and this row cannot await the registry to read it.
  const canArchive = config.canArchive !== false
  for (const tool of buildHumanTools({
    ctx, service: ctx.digitalHumans, humanId: human, memory, im, memoryScope, canArchive,
  })) {
    ctx.tools.register(tool)
  }
  whitelistSkills(ctx, human, config)
  if (!memory) return
  // A session-scoped record cannot name its file here: the assembly context exposes
  // an opaque scope key, not the Session id, so the per-conversation memory is
  // injected by the Host's pre-step hook instead, where the Agent is known.
  if (memoryScope === 'session') return
  const paths = memoryPaths(ctx.digitalHumans.store, human)
  // The provider re-reads on every assembly, so an edit the model made during a
  // turn is already visible on its next step. `# now` stays small by construction.
  ctx.systemPrompt.context({
    name: 'digital-human-memory',
    order: MEMORY_CONTEXT_ORDER,
    text: () => renderMemoryContext(paths),
  })
}
