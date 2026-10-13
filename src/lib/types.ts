/**
 * Domain and host-boundary types for the digital-human platform.
 *
 * A digital human is a record, not a composition row. These types are the single
 * description of that record, shared by the registry, the tools, and the presets.
 */

/** One declared wake-up. Delivered by the shipped schedule tools. */
export interface HumanSubscription {
  cron: string
  prompt: string
  enabled: boolean
}

/** The IM bot this digital human speaks through. */
export interface HumanIm {
  botId: string
  targetId: string
  /**
   * Who owns this digital human, as an IM `senderId` or a display name.
   *
   * The IM platform never hands an operator the caller's opaque id, so the
   * value is normally claimed rather than typed: see `claimOwner` in `im.ts`.
   * Empty means "not claimed yet", which is the state a freshly bound bot
   * starts in.
   */
  owner?: string
}

/** How long a handover may wait before it escalates to the user. */
/**
 * One declared config field. Mirrors Halo's `InputDef`.
 *
 * The declaration is what makes the config generic: the record names its own
 * keys and says how each is filled, so the plugin never has to recognise a key
 * name, and the settings page can render the right control for each one.
 */
export interface ConfigField {
  /** The name a persona writes as `{{key}}`. */
  key: string
  label?: string
  type?: 'text' | 'number' | 'boolean' | 'select'
  description?: string
  default?: string
  required?: boolean
  options?: Array<{ label: string; value: string }>
  /**
   * Keep this field out of the settings form.
   *
   * It still resolves and still reaches the prompt — this only says the operator
   * has no reason to look at it. A platform fact needs no decision, and a value
   * whose declared default is already the answer is noise in a form.
   */
  hidden?: boolean
  /**
   * A platform fact to resolve when the operator sets no value.
   *
   * This enum is the plugin's whole vocabulary, and every member is a general
   * concept rather than a business term: a record maps its own key name onto one
   * of these, which is why a second digital human needs no plugin change.
   */
  from?: 'self_name' | 'self_id' | 'owner_id' | 'owner_chat' | 'peer_name' | 'peer_id'
}

/** One configurable digital human. */
export interface Human {
  id: string
  /** Set by the store on first write; absent on a seeded record. */
  createdAt?: string
  name: string
  description: string
  enabled: boolean
  systemPrompt: string
  workspace: string
  /**
   * The plugin-space skills this digital human mounts, by name.
   *
   * Only these are added: the deployment's own roots — the global directory, the
   * project's, the bundled set — keep loading for every agent as they always did.
   * So a skill in the plugin's space is opt-in per digital human, while everything
   * outside it needs no configuration at all.
   */
  skills: string[]
  peers: string[]
  im: HumanIm
  subscriptions: HumanSubscription[]
  memory: boolean
  /**
   * Values for the fields this digital human's persona reads at the start of a
   * run. Free-form, because the record's own `configSchema` supplies the names.
   */
  config?: Record<string, string>
  /**
   * The fields this digital human's persona expects.
   *
   * Absent means the record declares nothing, and then every `config` entry is
   * used as written. When a schema is present it is authoritative: a key it does
   * not declare is dropped, so a renamed or deleted field cannot leak a stale
   * value into the prompt.
   */
  configSchema?: ConfigField[]
  /**
   * Permission preset applied to this digital human's own sessions.
   *
   * A digital human works without a person watching the approval prompt, so it
   * needs a preset that does not ask. Empty means the platform default, which is
   * full access. Name a built-in preset to differ per digital human.
   */
  permissionPreset?: string
}

/**
 * The fields a caller may change. Everything else keeps its stored value.
 *
 * `im` is partial like the rest: a patch that omits `targetId` must leave the
 * stored target alone, which is only expressible if the nested object is partial
 * too. The host merges it over the stored record before validating.
 */
export type HumanPatch = Partial<Omit<Human, 'id' | 'im'>> & { id?: string; im?: Partial<HumanIm> }

/**
 * The preset registry owns these. Import them type-only: the reference erases at
 * compile time, so the runtime still imports nothing but node builtins.
 */
export type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
export type { Context } from '@deepseek-ai/cordis'

/** One row of a preset composition. */
export interface PresetRow {
  id: string
  name?: string
  disabled?: boolean
  isolate?: Record<string, unknown>
  config?: Record<string, unknown>
  [key: string]: unknown
}

/** A skill the catalog offers. */
export interface SkillSummary {
  name: string
  description?: string
  [key: string]: unknown
}

/** A workspace the workspace controller knows. */
export interface WorkspaceView {
  workspaceId: string
  title: string
  path: string
  [key: string]: unknown
}

/** One IM bot, as `dshIm.listBots` reports it, plus what we merge in. */
export interface ImBot {
  botId: string
  channel: string
  alias?: string
  workspace?: string
}

/** Alias and workspace maps read from the IM integration directories. */
export interface BotMeta {
  aliases: Record<string, string>
  workspaces: Record<string, string>
}

/** One entry of the mailbox the chat layer keeps per conversation. */
export interface MailboxEntry {
  at: string
  from: string
  text: string
  [key: string]: unknown
}

/** The subset of the Cordis context this plugin uses. */
export interface Ctx {
  get(name: string): any
  provide(name: string, value: unknown): void
  effect(work: () => void | (() => void), label?: string): void
  inject(deps: string[], work: (ctx: Ctx) => void): void
  logger?: {
    debug(...args: unknown[]): void
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }
  [key: string]: any
}

/** Plugin configuration, as the loader passes it. */
export interface Config {
  home?: string
  /**
   * Records to start from, for a caller that supplies its own examples.
   *
   * The plugin ships none: a fresh install grows no digital humans. They are
   * configured in the page or imported as a bundle, and the tests pass a list here.
   */
  humans?: Human[]
  /** Permission preset for a digital human that names none. */
  permissionPreset?: string
  /**
   * Prompt variables the renderer registers, so a persona may use them.
   *
   * Any other `{{name}}` is neutralised before the prompt is handed over: the
   * renderer fails the whole turn on a variable it does not know, so one stray
   * placeholder would otherwise cost a session.
   */
  platformVariables?: string[]
  [key: string]: unknown
}
