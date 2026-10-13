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
}

/** How long a handover may wait before it escalates to the user. */
export interface HumanEscalation {
  enabled: boolean
  timeoutHours: number
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
  skills: string[]
  peers: string[]
  im: HumanIm
  subscriptions: HumanSubscription[]
  memory: boolean
  escalation: HumanEscalation
}

/** The fields a caller may change. Everything else keeps its stored value. */
export type HumanPatch = Partial<Omit<Human, 'id'>> & { id?: string }

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
  seed?: boolean
  [key: string]: unknown
}
