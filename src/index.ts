/**
 * Digital-human platform for DeepSeek Harness.
 *
 * A digital human is a record, not a composition row: persona, workspace, skills,
 * bound IM bot, peers, and declared wake-ups all live in one registry file. This
 * plugin turns each enabled record into a live Agent preset named `dh-<id>`, so a
 * digital human can be created, edited, paused, or deleted without touching YAML.
 *
 * The design follows Halo's split, rebuilt on Harness primitives:
 *
 * - Halo Chat system (`/chat/send|status|messages`) -> `sessionController` plus a
 *   durable per-conversation mailbox. See `lib/chat.js`.
 * - Halo `notify_bot` -> `dshIm.send` through the bot bound to the digital human.
 * - Halo `subscriptions` -> the shipped `@deepseek-ai/dsh-schedule` tools, which
 *   already deliver a due task back into its original Session.
 */

import { dirname } from 'node:path'

import { HumanStore, deadlineMinutesOf, defaultHome } from './lib/store.js'
import { DEFAULT_CONVERSATION, HumanChat, requireConversation } from './lib/chat.js'
import { archiveHistoryOnTurnEnd, memoryPaths } from './lib/memory.js'
import { HumanLedger } from './lib/ledger.js'
import type { TaskRow } from './lib/ledger.js'
import {
  DEFAULT_DEADLINE_MINUTES, deadlineIn, escalates, escalationText, foldedInto,
} from './lib/escalation.js'
import { buildPresetDefinition, presetIdOf, resolveConfigValues } from './lib/presets.js'
import { buildRegistryTool } from './lib/tools.js'
import { listLibrary, removeSkill, writeSkill } from './lib/skills.js'
import { packHumans, readBundle, unpackHumans } from './lib/bundle.js'
import { applyTitlePlan } from './lib/titles.js'
import { RPC_PATH } from './lib/rpc.js'
import { registerRpc } from './lib/rpc.js'
import { directSenderOf, directSenders, syncBotToHuman } from './lib/im.js'
import type { ImSyncResult } from './lib/im.js'
import { DEFAULT_WORKSPACE_TITLE, ensureDefaultWorkspace, listWorkspaces, readBotMeta } from './lib/workspaces.js'
import type { Config, Ctx, Human, HumanPatch, WorkspaceView } from './lib/types.js'
import { DEFAULT_PERMISSION_PRESET } from './lib/types.js'

/** Cordis plugin name. */
export const name = 'digital-human'

/** Services this plugin reads. */
export const inject = ['agentPresets', 'sessionController', 'tools']

/**
 * Defaults for the platform row. No `Config` schema is exported on purpose: this
 * package must resolve from a profile whose dependency tree it does not own, so it
 * imports nothing beyond node builtins and validates its own config here.
 */
const DEFAULTS = {
  basePreset: 'standard',
  toolsPlugin: '@harrywan/dsh-digital-human/tools',
}

/**
 * Access a session gets when the person talking is not the owner.
 *
 * The owner is whoever claimed the bot. Anyone else gets work confined to the
 * workspace, plus an approval policy of `never`: an IM turn composes no approval
 * answerer, so a policy that asks would stall the work instead of limiting it.
 *
 * These are the two knobs a permission preset bundles, applied directly. Naming a
 * preset would make every deployment define one, and an install that did not would
 * fall back to whatever the session was created with.
 */
const GUEST_SANDBOX_MODE = 'workspace-write'
const GUEST_APPROVAL_POLICY = 'never'

/**
 * What a session runs as: a named preset, or the two knobs a preset bundles.
 *
 * The confined form carries the sender so the log line can name who it was.
 */
type TalkerAccess =
  | { preset: string }
  | { sandbox: string; approval: string; sender: string }

/** First preset order handed to a generated digital-human preset. */
const PRESET_ORDER_BASE = 100

/**
 * How long to wait between alignment attempts that lost a startup race.
 *
 * Long enough for a slow sibling plugin to mount its routes or provide its
 * service, short enough that a person watching the log sees the outcome of the
 * same start.
 */
const ALIGN_RETRY_MS_DEFAULT = 3000

/**
 * How many alignment attempts a startup race is worth.
 *
 * A sibling plugin that opens a socket before it mounts its routes can take far
 * longer than a service lookup, so the window is generous: a failed alignment
 * silently leaves a digital human without its source block, which is worse than
 * a few wasted calls.
 */
const ALIGN_RETRY_MAX_DEFAULT = 10

/**
 * Read a positive number from the plugin config, or fall back to the default.
 *
 * Read from the config directly rather than through {@link setting}, which answers
 * for strings only — a numeric option would silently fall back to the default.
 */
function positiveSetting(config: Config, key: string, fallback: number): number {
  const value = Number((config as Record<string, unknown>)?.[key])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * The permission preset one record runs under.
 *
 * A record created before this field existed falls back to the creation default,
 * which is what the registry now writes into every new record.
 *
 * @param human - the record to read.
 */
function permissionPresetOf(human: Human): string {
  const named = typeof human.permissionPreset === 'string' ? human.permissionPreset.trim() : ''
  return named || DEFAULT_PERMISSION_PRESET
}

/** Read one optional string setting. */
function setting(config: Config, key: string): string {
  const value = config?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULTS[key]
}

/**
 * Mount the digital-human platform.
 * @param ctx - Host context carrying the preset registry, session controller, and tool registry.
 * @param config - registry location, seeding, and the capability baseline.
 */
export async function apply(ctx: Ctx, raw: Config | null = {}): Promise<void> {
  // A row written with an empty `config:` reaches here as null. Reading a property of
  // null would throw before anything mounts, and the host half would vanish while the
  // browser half stayed — the failure looks like a broken page, not a bad config.
  const config: Config = raw ?? {}
  const home = setting(config, 'home') || defaultHome()
  const basePreset = setting(config, 'basePreset')
  const toolsPlugin = setting(config, 'toolsPlugin')
  // An absent or empty list means "use the built-in platform set".
  const platformVariables = Array.isArray(config.platformVariables) && config.platformVariables.length > 0
    ? config.platformVariables.filter((name) => typeof name === 'string' && name)
    : undefined
  // The retry window is configurable so a deployment — or a test — can shorten it.
  const alignRetryMs = positiveSetting(config, 'alignRetryMs', ALIGN_RETRY_MS_DEFAULT)
  const alignRetryMax = positiveSetting(config, 'alignRetryMax', ALIGN_RETRY_MAX_DEFAULT)
  // How long a handover may run before its owner hears about it. A record may carry
  // its own value; this is the fallback every record inherits.
  const deadlineMinutes = positiveSetting(config, 'escalationDeadlineMinutes', DEFAULT_DEADLINE_MINUTES)
  // Empty unless the caller supplies examples. A fresh install grows no digital
  // humans: they are configured in the page or imported as a bundle.
  const seed: Human[] = Array.isArray(config.humans) ? config.humans : []
  const store = new HumanStore(home)
  const log = (message: string): void => { ctx.logger?.warn?.(`digital-human: ${message}`) }
  /**
   * Directory -> Workspace id, refilled by `refresh()`.
   *
   * A session created with a `cwd` alone is not filed under any Workspace, so the
   * UI cannot group it and shows it as ungrouped even though it runs in the right
   * directory. The id is what files it.
   */
  const workspaceIdByPath = new Map<string, string>()
  // Closures, not values: the Workspace roster is resolved during refresh(), which
  // runs after this constructor.
  const chat = new HumanChat(ctx, store, log, {
    defaultWorkspacePath: () => defaultWorkspace?.path,
    workspaceIdOf: (path: string) => workspaceIdByPath.get(path),
  })
  const ledger = new HumanLedger(store, log)

  /** Preset disposers currently owned by this plugin. */
  const disposers: Array<() => unknown> = []
  /** human id -> generated preset id, for enabled records only. */
  const activePresets = new Map<string, string>()
  /**
   * generated preset id -> human id.
   *
   * Its job is the event nobody primed for: a Session's header names the preset, and
   * that is enough to recognise whose turn just started without trusting a startup
   * read that may have been missed.
   */
  const humanByPreset = new Map<string, string>()
  /**
   * generated preset id -> the permission preset its sessions run under.
   *
   * A session announces its creation synchronously, so the lookup that decides
   * the override must be synchronous too. `refresh` fills this, which keeps the
   * event handler free of I/O.
   */
  const permissionByPreset = new Map<string, string>()
  /** human id -> the per-endpoint outcome of its last alignment. */
  const alignmentByHuman = new Map<string, ImSyncResult[]>()

  /** Records that keep durable memory, so a turn end knows whose timeline to reclaim. */
  const memoryEnabled = new Set<string>()

  /**
   * Whether an alignment is worth another attempt.
   *
   * The loader does not order this plugin after IM — its declared dependencies
   * are the preset registry, the session controller, and the tool registry, while
   * IM waits on the Connection service — so the first attempt of a process
   * routinely runs before IM is ready.
   *
   * Everything failed is retried, because the costs are not symmetric: an extra
   * attempt costs one idempotent call, while a missed one leaves a digital human
   * without its workspace, its preset, or its source block, and nothing says so.
   * IM reports "still initializing" through the same error channel as a real
   * refusal, so distinguishing them would mean trusting a channel's error strings
   * — and being wrong in that direction is the expensive one.
   */
  function worthRetrying(results: ImSyncResult[]): boolean {
    return results.some((entry) => !entry.ok)
  }

  /** Bound records by the preset id their sessions run under. */
  const boundByPreset = new Map<string, Human>()

  /** Push one record's mode, directory, and identity onto its bound bot. */
  async function align(record: Human): Promise<ImSyncResult[]> {
    const results = await syncBotToHuman(ctx, {
      botId: record.im?.botId,
      // A record without its own directory still belongs to the shared one: without
      // this push the bot's Sessions stay in whatever workspace IM last used, which
      // is the "我的会话不在数字人工作区" symptom.
      workspace: record.workspace || defaultWorkspace?.path,
      presetId: presetIdOf(record.id),
      owner: record.im?.owner,
      log,
    })
    alignmentByHuman.set(record.id, results)
    return results
  }

  /** Whether a retry loop is already running, so refreshes do not stack them. */
  let aligning = false

  /**
   * Retry the records that are only waiting on a service.
   *
   * Called without `await`: `apply()` must not stall on a service that may never
   * appear. It keeps retrying until every record is aligned or the attempt budget
   * runs out, because a failure here is otherwise invisible — the bot simply runs
   * without its workspace, its preset, or its source block.
   */
  async function alignWhenReady(records: Human[]): Promise<void> {
    if (aligning) return
    aligning = true
    try {
      for (let round = 1; round <= alignRetryMax; round++) {
        const waiting = records.filter((record) => worthRetrying(alignmentByHuman.get(record.id) ?? []))
        if (waiting.length === 0) return
        log(`alignment for ${waiting.length} bound bot(s) is waiting on a service; attempt ${round}/${alignRetryMax}`)
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, alignRetryMs)
          if (typeof timer.unref === 'function') timer.unref()
        })
        for (const record of waiting) await align(record)
      }
    } finally {
      aligning = false
    }
  }

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      Promise.resolve(dispose()).catch((error: Error) => log(`preset disposal failed: ${error.message}`))
    }
  })

  /** Re-register every enabled digital human as a live preset. */
  async function refresh() {
    for (const dispose of disposers.splice(0)) {
      try {
        await dispose()
      } catch (error) {
        log(`preset disposal failed: ${error.message}`)
      }
    }
    activePresets.clear()
    humanByPreset.clear()
    permissionByPreset.clear()
    boundByPreset.clear()
    // Cleared with the others: a stale outcome would report a bot as aligned after
    // its binding changed or the record was removed.
    alignmentByHuman.clear()
    memoryEnabled.clear()
    const humans = await store.list(seed)
    for (const human of humans) if (human.memory !== false) memoryEnabled.add(human.id)
    defaultWorkspace = await ensureDefaultWorkspace(ctx, { home, log })
    workspaceIdByPath.clear()
    for (const item of await listWorkspaces(ctx)) {
      if (typeof item?.path === 'string' && typeof item?.workspaceId === 'string') {
        workspaceIdByPath.set(item.path, item.workspaceId)
      }
    }
    // A record may name a directory the roster does not know yet. Register it, or
    // the session it creates carries a `cwd` but no `workspaceId` — and the UI
    // groups by the id, so the session shows up as ungrouped even though it runs in
    // the right place.
    const workspaceController = ctx.get?.('workspaceController')
    if (typeof workspaceController?.create === 'function') {
      for (const human of humans) {
        const path = human.workspace
        if (!human.enabled || !path || workspaceIdByPath.has(path)) continue
        try {
          const created = await workspaceController.create({ path })
          const workspaceId = created?.workspace?.workspaceId
          if (typeof workspaceId === 'string') {
            workspaceIdByPath.set(path, workspaceId)
            log(`registered workspace "${path}" for ${human.id}`)
          }
        } catch (error) {
          log(`workspace "${path}" for ${human.id} is unavailable: ${error.message}`)
        }
      }
    }
    let order = PRESET_ORDER_BASE
    const bound: Human[] = []
    // A persona names its counterpart, and the counterpart's display name is
    // already in this list — so `{{peer_name}}` resolves from the same picker the
    // settings page edits, instead of a second copy the operator must keep in step.
    const peerNames = Object.fromEntries(humans.map((entry) => [entry.id, entry.name]))
    for (const human of humans) {
      if (!human.enabled) continue
      // A fresh binding has no owner: the IM platform never reveals who created a
      // bot, so there is nothing to configure. Its own session state does name the
      // first direct caller, and a new bot is visible only to its creator — so the
      // first caller is the owner. Claiming here rather than on save means the
      // persona and the source block carry the owner from the first start.
      let record = human
      if (record.im?.botId) {
        const senders = directSenders(home, record.im.botId)
        if (!record.im.owner && senders[0]) {
          record = { ...record, im: { ...record.im, owner: senders[0] } }
          await store.upsert(record, seed)
          log(`claimed ${senders[0]} as the owner of ${record.id}`)
        } else if (record.im.owner && senders.length > 0 && !senders.includes(record.im.owner)) {
          // The WeCom channel never sends a display name, so an owner written as a
          // name can never equal a `senderId` — the persona would silently treat
          // the owner as a stranger. Say so instead of failing quietly.
          log(`owner "${record.im.owner}" of ${record.id} is none of the senders ${record.im.botId} has seen (${senders.join(', ')}), so the identity clause cannot match`)
        }
      }
      if (record.im?.botId) {
        bound.push(record)
        boundByPreset.set(presetIdOf(record.id), record)
      }
      const definition = buildPresetDefinition(record, {
        store,
        toolsPluginName: toolsPlugin,
        order: order++,
        peerNames,
        ...(platformVariables ? { platformVariables } : {}),
      })
      permissionByPreset.set(definition.id, permissionPresetOf(record))
      try {
        disposers.push(await ctx.agentPresets.register(definition))
        activePresets.set(record.id, definition.id)
        humanByPreset.set(definition.id, record.id)
      } catch (error) {
        log(`preset "${definition.id}" failed to register: ${error.message}`)
      }
    }
    await chat.prime(humans)
    // Align every bound bot, not only the one being saved. IM loads these
    // settings from its own file once and then holds them in memory, so a
    // restart leaves it unaligned until something pushes them again — and a
    // digital human that silently lost its source block, its workspace, or its
    // preset would run blind, in the wrong directory, with the wrong tools.
    await Promise.all(bound.map((record) => align(record)))
    // Not awaited: a retry must never stall apply(), and it returns at once when
    // every record already aligned.
    alignWhenReady(bound).catch((error) => log(`alignment retry failed: ${error.message}`))
  }

  /** Merge a partial patch over one stored record before validation. */
  async function merge(id: string, patch: HumanPatch): Promise<HumanPatch> {
    const existing = await store.get(id, seed)
    if (!existing) return patch
    return {
      ...existing,
      ...patch,
      im: { ...existing.im, ...(patch.im ?? {}) },
    }
  }

  /**
   * The conversation a delivery is filed under, resolved without opening a Session.
   *
   * The ledger row has to exist before the prompt is issued, so the address is
   * resolved here rather than read back from the delivery.
   */
  async function conversationFor(human: Human, { conversationId, sessionId }: {
    conversationId?: string
    sessionId?: string
  }): Promise<string> {
    // A shared-session record runs everything in one Session, which is filed under
    // the default conversation whatever label the message carries.
    if (human.sessionMode === 'single') return DEFAULT_CONVERSATION
    if (conversationId !== undefined) return requireConversation(conversationId)
    const known = sessionId ? await chat.conversationOf(human.id, sessionId) : undefined
    // A Session with no recorded thread keeps its own id as the label, which is the
    // same answer `chat.#resolve` gives; a caller naming neither address lands in
    // `main`. The tool is the layer that refuses both addresses at once (README:
    // "两个地址都不传 → 报错") and it resolves the address before calling here, so
    // this stays the service-level default: raising an error here would reject the
    // bare `service.send` calls the chat API and tests rely on. IM inbound never
    // reaches this function — `dsh-im` delivers into its own Session.
    return known ?? sessionId ?? DEFAULT_CONVERSATION
  }

  /** Whether a delivery hands work over from another digital human. */
  function isPeerDelivery(from: unknown, selfId: string): from is string {
    return typeof from === 'string' && from !== '' && from !== 'user' && from !== selfId
  }

  /**
   * Whether a delivery answers a question the peer's running turn just asked.
   *
   * The transport recorded the inbound edge when the question arrived, so the
   * Session that asked is known. A question that is still the last word on the
   * thread is the one an answer belongs to — anything else is new work.
   */
  async function answeringQuestion(human: Human, { from, conversation }: {
    from: string
    conversation: string
  }): Promise<boolean> {
    const running = (await ledger.open(human.id, conversation)).find((task) => task.state === 'in_progress')
    // The edges belong to the sender: it is the side that received the question.
    const asked = await chat.latestEdge(from, {
      dir: 'in',
      peer: human.id,
      conversation,
      ...(running?.owner ? { peerSession: running.owner } : {}),
    })
    if (!asked) return false
    const answered = await chat.latestEdge(from, { dir: 'out', peer: human.id, conversation })
    return answered === undefined || asked.at > answered.at
  }

  /**
   * Whether one record keeps a single Session for every thread.
   *
   * A shared-session record files its ledger under one conversation whatever label a
   * caller used, so its turn may claim the head across labels. A threaded record may
   * not: each thread has its own queue.
   */
  async function isSharedSession(humanId: string): Promise<boolean> {
    const human = await store.get(humanId, seed)
    return human?.sessionMode === 'single'
  }

  /**
   * Stop work items no turn will ever end.
   *
   * A restart kills every running turn without a turn/end, so an in-progress item
   * would otherwise stay in progress forever. Run once, after the chat layer knows
   * which Session belongs to which conversation.
   */
  async function sweepTasks(): Promise<void> {
    for (const human of await store.list(seed)) {
      try {
        await ledger.sweep(human.id, idleIn(human))
      } catch (error) {
        log(`work-item sweep failed for ${human.id}: ${error.message}`)
      }
    }
  }

  /**
   * Whether one conversation is between turns, as the ledger's predicates expect.
   *
   * A turn that is still running owns its work item: settling it behind the turn's
   * back would leave `turn/end` with nothing to close and call running work blocked.
   */
  function idleIn(human: Human): (conversation: string) => Promise<boolean> {
    return async (conversation) => !(await chat.status(human, conversation)).isGenerating
  }

  /**
   * Tell one record's owner about every work item that stopped.
   *
   * The ledger is the source of truth: any failed or blocked item that has not been
   * claimed yet is escalated, so a send missed by a crash is retried by the next
   * query or turn ending. An item folded into a message sent moments ago is left
   * unclaimed on purpose: it was never delivered, so a claim would lose it for good,
   * while leaving it pending lets the first settle after the window send it. The
   * claim still comes before sending — a person told twice stops trusting the
   * channel, while an unsent message is only a lost notification.
   */
  async function escalateStopped(human: Human, conversation?: string): Promise<void> {
    const rows = await ledger.list(human.id)
    const pending = rows.filter((task) => escalates(task.state)
      && task.escalatedAt === undefined
      && (conversation === undefined || task.conversation === conversation))
    if (pending.length === 0) return
    // One message per thread: a burst of failures from one handover is one event.
    const threads = new Map<string, TaskRow[]>()
    for (const task of pending) {
      const items = threads.get(task.conversation) ?? []
      items.push(task)
      threads.set(task.conversation, items)
    }
    const dshIm = ctx.get?.('dshIm')
    for (const [thread, items] of threads) {
      const lastAt = rows
        .filter((task) => task.conversation === thread && task.escalatedAt !== undefined)
        .map((task) => task.escalatedAt!)
        .sort()
        .at(-1)
      const now = new Date()
      const ids = items.map((task) => task.id).join(', ')
      // Decide the fold before claiming: a folded item was not sent, so claiming it
      // would mark it handled and no later settle would ever deliver it.
      if (foldedInto(lastAt, now)) {
        log(`escalation of ${ids} in "${thread}" for ${human.id} folded into the message sent at ${lastAt}`)
        continue
      }
      const claimed = await ledger.claim(human.id, {
        taskIds: items.map((task) => task.id),
        at: now.toISOString(),
      })
      if (claimed.length === 0) continue
      // A worker rarely carries a bot of its own. The record that handed the work
      // over is the one a person watches, so its bot and owner carry the news back;
      // without that hop a worker's failure would be visible to nobody.
      const notifier = await notifierFor(human, claimed)
      if (!notifier) {
        log(`escalation of ${ids} in "${thread}" for ${human.id} skipped: neither it nor the record that assigned the work has a bot and an owner`)
        continue
      }
      const { botId, owner } = notifier
      if (typeof dshIm?.send !== 'function') {
        log(`escalation of ${ids} in "${thread}" for ${human.id} skipped: the IM service is absent`)
        continue
      }
      try {
        await dshIm.send(
          botId,
          { kind: 'user', route: { chatId: owner } },
          escalationText(claimed),
          { format: 'plain' },
        )
        log(`escalated ${ids} in "${thread}" to ${owner} through ${botId} (via ${notifier.via})`)
      } catch (error) {
        log(`escalation of ${ids} in "${thread}" could not be sent: ${error.message}`)
      }
    }
  }

  /**
   * Which bot carries one failure to a person.
   *
   * The record that owns the failed item wins when it has a bot; otherwise the
   * record that assigned the work does, because that is the one bound to a human
   * and the one whose chain the failure belongs to.
   */
  async function notifierFor(
    human: Human,
    items: TaskRow[],
  ): Promise<{ botId: string; owner: string; via: string } | undefined> {
    const own = {
      botId: String(human.im?.botId ?? '').trim(),
      owner: String(human.im?.owner ?? '').trim(),
    }
    if (own.botId && own.owner) return { ...own, via: human.id }
    for (const senderId of [...new Set(items.map((task) => task.from))]) {
      if (!senderId || senderId === human.id) continue
      const sender = await store.get(senderId, seed)
      const botId = String(sender?.im?.botId ?? '').trim()
      const owner = String(sender?.im?.owner ?? '').trim()
      if (botId && owner) return { botId, owner, via: senderId }
    }
    return undefined
  }

  /**
   * Settle the ledger before anyone reads it.
   *
   * The plugin runs no timer. A timeout is noticed exactly when it is about to
   * matter — a status or task query, or a turn ending — so this is the whole clock.
   */
  async function settleWork(human: Human, conversation?: string): Promise<void> {
    await ledger.timeout(human.id, {
      now: new Date(),
      fallbackMinutes: deadlineMinutesOf(human, deadlineMinutes),
      isIdle: idleIn(human),
    })
    await escalateStopped(human, conversation)
  }

  /**
   * Close the item one turn owned, then settle everything the ledger can now see.
   *
   * The turn's own item is closed first, because a timeout must not race the result
   * the turn just produced. A turn ending is also the moment an unrelated overdue
   * item is noticed, whether or not this turn stopped anything.
   */
  async function settleTurn(humanId: string, sessionId: string, reason?: unknown): Promise<void> {
    await ledger.end(humanId, { sessionId, reason })
    const human = await store.get(humanId, seed)
    if (!human) return
    await settleWork(human)
  }

  /**
   * Reclaim the timeline of a record whose memory outgrew the file budget.
   *
   * Runs on the Host's `turn/end`, the one boundary after the model has written its
   * memory. Only `# History` moves: dropping working memory is the model's decision,
   * so `# now` is left for `memory_compact` to handle.
   */
  function reclaimHistory(humanId: string): void {
    if (!memoryEnabled.has(humanId)) return
    try {
      const archived = archiveHistoryOnTurnEnd(memoryPaths(store, humanId))
      if (archived) log(`archived ${archived.moved} memory history entries of ${humanId} to ${archived.archive}`)
    } catch (error) {
      log(`memory history archive failed for ${humanId}: ${error.message}`)
    }
  }

  let defaultWorkspace: WorkspaceView | undefined
  const service = {
    /** The Workspace a record uses when it names none. */
    defaultWorkspace: () => defaultWorkspace,
    /** Registry root, exposed so the prompt can name the file. */
    home,
    /** Which digital human and conversation a session belongs to, if any. */
    ownerOf: (sessionId: string) => chat.ownerOf(sessionId),
    store,
    chat,
    presetIdOf,
    refresh,
    /** Every digital human, enabled or not. */
    list: () => store.list(seed),
    /** Resolve one digital human by id or display name. */
    resolve: (idOrName) => store.get(idOrName, seed),
    /** Resolve one digital human, failing loud when it is unknown. */
    async require(idOrName) {
      const found = await store.get(idOrName, seed)
      if (!found) throw new Error(`unknown digital human: ${JSON.stringify(idOrName)}`)
      return found
    },
    /** Create or update one digital human, then re-register presets. */
    async upsert(patch, { partial = false } = {}) {
      if (!patch?.id) throw new Error('id is required')
      const merged = partial ? await merge(patch.id, patch) : patch
      const saved = await store.upsert(merged, seed)
      // refresh() owns both the owner claim and the IM alignment, so the record to
      // report is the one it left behind, not the pre-claim write.
      await refresh()
      const record = await store.get(saved.id, seed) ?? saved
      return { ...record, presetId: presetIdOf(record.id), alignment: alignmentByHuman.get(record.id) ?? [] }
    },
    /** Delete one digital human and drop its preset. */
    async remove(id) {
      const removed = await store.remove(id, seed)
      if (removed) {
        // Its sessions would otherwise keep resolving to an owner that is gone.
        chat.forget(id)
        await refresh()
      }
      return removed
    },
    /**
     * Deliver a message into a digital human's conversation, like `/chat/send`.
     *
     * A peer's delivery is also a work item, so the address decides the intent: an
     * idle peer is assigned now, a busy one queues behind the turn in progress, and
     * a reply into a turn that is waiting for it amends the item already open.
     * `mode` overrides that guess, because the model sometimes knows better.
     */
    async send(
      idOrName: string,
      { conversationId, sessionId, message, from, fromSession, mode, taskId, note, deadline }: {
        conversationId?: string
        sessionId?: string
        message?: string
        from?: string
        fromSession?: string
        mode?: 'new' | 'amend' | 'cancel'
        taskId?: string
        note?: string
        /** Explicit due time. Omitted means the record's escalation window. */
        deadline?: string
      },
    ) {
      const human = await service.require(idOrName)
      // A disabled record cannot run: say so before the ledger records a handover
      // nobody will ever pick up.
      if (!human.enabled) throw new Error(`digital human "${human.id}" is disabled`)
      const conversation = await conversationFor(human, { conversationId, sessionId })
      const delivery = {
        conversationId,
        sessionId,
        message,
        from,
        // The caller's own Session rides along, so the answer can come back to it.
        fromSession,
        presetId: presetIdOf(human.id),
      }
      // A person or a record talking to itself is a message, not a work item: the
      // ledger tracks work handed over between digital humans.
      if (!isPeerDelivery(from, human.id)) return chat.deliver(human, delivery)
      const busy = (await chat.status(human, sessionId ?? conversation)).isGenerating
      // Answering a Session that asked is not handing over new work: a reply travels
      // to the Session named by <dsh_peer_source>, and treating it as an assignment
      // left the responder holding a queued item no turn would ever start.
      const replying = typeof sessionId === 'string' && sessionId.trim() !== ''
      let intent: 'assign' | 'amend' | 'cancel' = 'assign'
      if (mode === 'cancel') intent = 'cancel'
      else if (mode === 'amend') intent = 'amend'
      else if (mode !== 'new' && replying) {
        // A reply amends the item it answers, and stays a plain message when there is
        // nothing open to amend.
        const open = await ledger.open(human.id, conversation)
        if (open.length === 0) return chat.deliver(human, delivery)
        intent = 'amend'
      }
      else if (mode !== 'new' && busy && await answeringQuestion(human, { from, conversation })) intent = 'amend'

      if (intent === 'cancel') {
        const cancelled = await ledger.cancel(human.id, { conversation, ...(taskId ? { taskId } : {}) })
        return {
          sessionId: sessionId ?? '',
          conversationId: conversation,
          accepted: false,
          task: { id: cancelled.id, state: cancelled.state, intent, queued: false },
        }
      }
      if (intent === 'amend') {
        const amended = await ledger.amend(human.id, {
          conversation,
          text: String(message ?? ''),
          ...(taskId ? { taskId } : {}),
        })
        const delivered = await chat.deliver(human, delivery)
        return { ...delivered, task: { id: amended.id, state: amended.state, intent, queued: busy } }
      }
      const assigned = await ledger.assign(human.id, {
        from,
        conversation,
        ...(typeof note === 'string' && note.trim() ? { note: note.trim() } : {}),
        // Every item carries a deadline: an escalation with no due time would wait
        // for a person to notice, which is the failure mode this field removes.
        deadline: typeof deadline === 'string' && deadline.trim()
          ? deadline.trim()
          : deadlineIn(new Date(), deadlineMinutesOf(human, deadlineMinutes)),
      })
      try {
        // A queued task must not steer the running turn: it is the next turn, not
        // news for this one.
        const delivered = await chat.deliver(human, { ...delivery, deliveryMode: busy ? 'queue' : 'steer' })
        return { ...delivered, task: { id: assigned.id, state: assigned.state, intent, queued: busy } }
      } catch (error) {
        // The row is already on the ledger. Say it never arrived instead of leaving
        // it queued forever.
        await ledger.fail(human.id, { taskId: assigned.id, reason: 'undelivered' })
          .catch((failure) => log(`work item ${assigned.id} could not be marked failed: ${failure.message}`))
        // The work never arrived, so its owner may need to act. Failure of the
        // escalation itself must not replace the delivery error the caller expects.
        await escalateStopped(human, conversation)
          .catch((failure) => log(`escalation of ${assigned.id} failed: ${failure.message}`))
        throw error
      }
    },
    /** The work items of one conversation, oldest first. */
    async tasks(idOrName, conversationId) {
      const human = await service.require(idOrName)
      // Reading the ledger is one of the two moments a timeout is noticed. A settle
      // failure must not hide the rows, so it is reported and the read continues.
      await settleWork(human, conversationId)
        .catch((error) => log(`work-item settle failed for ${human.id}: ${error.message}`))
      const rows = await ledger.list(human.id)
      return conversationId === undefined ? rows : rows.filter((task) => task.conversation === conversationId)
    },
    /**
     * The Session a message to one peer should reach, resolved from the edges the
     * transport has seen — a reply follows the Session that asked, not the thread's
     * name. `null` when nothing is known yet, which is what opens a new thread.
     */
    async threadTarget(humanId: string, options: {
      selfSession?: string
      peer: string
      conversationId?: string
    }) {
      return chat.threadTarget(humanId, options)
    },
    /** Record one outbound edge, so the thread can be found from this side too. */
    async noteEdge(humanId: string, edge: {
      dir: 'in' | 'out'
      selfSession: string
      peer: string
      peerSession: string
      conversation: string
    }) {
      return chat.noteEdge(humanId, edge)
    },
    /** Report whether a digital human is working on a conversation, like `/chat/status`. */
    async status(idOrName, conversationId) {
      return chat.status(await service.require(idOrName), conversationId)
    },
    /** Read a conversation's mailbox tail, like `/chat/messages`. */
    async messages(idOrName, conversationId, limit) {
      return chat.messages(await service.require(idOrName), conversationId, limit)
    },
    /** Stop a digital human's current turn, like `/chat/stop`. */
    async stop(idOrName, conversationId) {
      return chat.stop(await service.require(idOrName), conversationId)
    },
  }

  ctx.provide('digitalHumans', service)
  ctx.tools.register(buildRegistryTool({ service }))

  // The settings page reads and writes the same service the registry tool does, so
  // the page and the conversation can never disagree about what is configured.
  /**
   * Attach the config a persona actually sees.
   *
   * The resolution stays on this side: it needs every record's display name for
   * the peer facts, and a client that reimplemented it would be a second copy of
   * the precedence rules waiting to disagree with the first.
   *
   * @param human - the record to describe.
   * @param all - every record, for the peer lookup.
   */
  function withResolved(human: Human, all: Human[]) {
    const peerNames = Object.fromEntries(all.map((entry) => [entry.id, entry.name]))
    return {
      ...human,
      resolved: resolveConfigValues(human, peerNames),
      // The last push onto this record's bound bot. It is reported because the
      // only other trace is a log line, and a silent failure here means the bot
      // runs without its source block or preset.
      alignment: alignmentByHuman.get(human.id) ?? [],
      // The preset id this record actually registered under, so the page reports
      // what the host did rather than rebuilding the name and hoping.
      presetId: presetIdOf(human.id),
    }
  }

  /**
   * The bundle channel: one digital human in, one out.
   *
   * A separate route from the JSON RPC, because a package is binary — a skill may
   * carry resources a JSON body would have to base64, and a large one would have to
   * be held twice. Here the browser downloads and uploads it like any other file.
   * The route sits on the same authenticated channel, so it inherits the browser
   * check the management route already relies on.
   */

  registerRpc(ctx, async (method, payload) => {
    const ok = (value) => ({ ok: true, value })
    const bad = (message) => ({ ok: false, error: { code: 'bad-request', message, details: {} } })
    if (method === 'registry.list') {
      const humans = await service.list()
      return ok({ home, file: store.file, humans: humans.map((entry) => withResolved(entry, humans)) })
    }
    if (method === 'registry.sessionIcon') {
      // Resolve one Session's preset and return its digital human's icon. The Session
      // list API does not report presets here, but the resolver does, per Session.
      if (typeof payload.sessionId !== 'string' || !payload.sessionId) return bad('sessionId is required')
      const humans = await service.list()
      const byPreset = new Map(humans.filter((entry) => entry.icon).map((entry) => [presetIdOf(entry.id), entry.icon]))
      if (byPreset.size === 0) return ok({ icon: null })
      let preset: string | undefined
      try {
        const resolved = await ctx.sessionController.resolveAgent(payload.sessionId)
        preset = resolved?.agent?.session?.header?.agentPreset
      } catch {
        preset = undefined
      }
      return ok({ icon: preset ? byPreset.get(preset) ?? null : null })
    }
    if (method === 'registry.get') {
      const found = await service.resolve(payload.id)
      if (!found) return bad(`unknown digital human: ${JSON.stringify(payload.id)}`)
      return ok({ human: withResolved(found, await service.list()) })
    }
    if (method === 'registry.save') {
      if (typeof payload.id !== 'string' || !payload.id.trim()) return bad('id is required')
      const patch = { ...payload.patch, id: payload.id.trim() }
      const saved = await service.upsert(patch, { partial: payload.partial === true })
      return ok({ human: saved, presetId: saved.presetId })
    }
    if (method === 'registry.remove') {
      return ok({ removed: await service.remove(payload.id) })
    }
    if (method === 'im.bots') {
      const dshIm = ctx.get('dshIm')
      if (!dshIm) return ok({ bots: [] })
      const bots = await dshIm.listBots()
      // `listBots` reports only an opaque id and a channel, so a bare list is
      // impossible to tell apart. The WeCom integration records an alias and
      // the directory each bot serves; merge both in as labels.
      // The registry home is `<dshRoot>/digital-human`, so the integration
      // data sits one level up.
      const meta = await readBotMeta(dirname(home))
      return ok({
        bots: (Array.isArray(bots) ? bots : []).map((bot) => ({
          ...bot,
          alias: meta.aliases[bot.botId] ?? '',
          workspace: meta.workspaces[bot.botId] ?? '',
        })),
      })
    }
    if (method === 'workspaces.list') {
      const items = await listWorkspaces(ctx)
      return ok({
        defaultTitle: DEFAULT_WORKSPACE_TITLE,
        defaultPath: defaultWorkspace?.path ?? null,
        workspaces: items.map((item) => ({
          workspaceId: item.workspaceId,
          title: item.title,
          path: item.path,
        })),
      })
    }
    if (method === 'skills.library') {
      // The plugin's own skill space: what a digital human can be given, as opposed
      // to what the deployment mounts for everyone.
      return ok({ skills: listLibrary(home) })
    }
    if (method === 'skills.upload') {
      const name = String(payload?.name ?? '').trim()
      const files = payload?.files
      if (!files || typeof files !== 'object' || Array.isArray(files)) {
        return bad('files must be an object of relative path to text')
      }
      try {
        const skill = await writeSkill(home, name, files as Record<string, string>)
        // Presets carry the mounted list, so they are re-registered to pick it up.
        await refresh()
        return ok({ skill })
      } catch (error) {
        return bad(error.message)
      }
    }
    if (method === 'skills.remove') {
      const removed = await removeSkill(home, String(payload?.name ?? '').trim())
      if (removed) await refresh()
      return ok({ removed })
    }
    if (method === 'permissions.list') {
      // Read from the platform, never from a list copied into the page: a renamed or
      // newly contributed preset must show up without a plugin release.
      const presets = ctx.get?.('permissionPresets')
      if (typeof presets?.catalog !== 'function') return ok({ default: '', presets: [] })
      const catalog = presets.catalog()
      return ok({
        default: typeof catalog?.defaultPreset === 'string' ? catalog.defaultPreset : '',
        presets: (Array.isArray(catalog?.options) ? catalog.options : []).map((option) => ({
          value: String(option?.value ?? ''),
          label: String(option?.name ?? option?.value ?? ''),
          description: typeof option?.description === 'string' ? option.description : '',
        })),
      })
    }
    if (method === 'skills.list') {
      const skills = ctx.get('skills')
      if (!skills || typeof skills.list !== 'function') return ok({ skills: [] })
      const entries = await skills.list()
      return ok({
        skills: (Array.isArray(entries) ? entries : []).map((entry) => ({
          name: entry.name,
          description: entry.description ?? '',
          whenToUse: entry.whenToUse ?? '',
          source: entry.source ?? '',
        })),
      })
    }
    if (method === 'im.targets') {
      const dshIm = ctx.get('dshIm')
      if (!dshIm || !payload.botId) return ok({ targets: [] })
      const targets = await dshIm.listTargets(payload.botId)
      return ok({ targets: Array.isArray(targets) ? targets : [] })
    }
    return bad(`unsupported method: ${JSON.stringify(method)}`)
  }, log)

  const bundleRoute = ctx.get?.('connection')
  if (typeof bundleRoute?.fetch?.register === 'function') try {
    bundleRoute.fetch.register({
      path: `${RPC_PATH}/bundle`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url)
        if (request.method === 'GET') {
          // The id is a query parameter, not a path segment: the route table matches
          // an exact pathname, so `/bundle/<id>` would never reach this handler and
          // the request would fall through to the SPA's 404.
          const includeMemory = url.searchParams.get('memory') === '1'
          // `all=1` exports the whole registry; `id=` exports one. Both produce the
          // same shape, so an import never has to ask which kind it received.
          let humans: Human[]
          let label: string
          if (url.searchParams.get('all') === '1') {
            humans = (await store.list(seed)).filter((human) => human.enabled !== false)
            label = 'digital-humans'
          } else {
            const id = url.searchParams.get('id') ?? ''
            const human = await store.get(id, seed)
            if (!human) return new Response(`unknown digital human: ${JSON.stringify(id)}`, { status: 404 })
            humans = [human]
            label = human.id
          }
          if (humans.length === 0) return new Response('there is no digital human to export', { status: 404 })
          const { archive } = packHumans(home, humans, { includeMemory })
          const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')
          return new Response(archive, {
            status: 200,
            headers: {
              'content-type': 'application/gzip',
              'content-disposition': `attachment; filename="${label}-${stamp}.dh.tar.gz"`,
            },
          })
        }
        let archive
        try {
          archive = Buffer.from(await request.arrayBuffer())
        } catch (error) {
          return Response.json({ ok: false, error: { code: 'bad-request', message: error.message } }, { status: 400 })
        }
        try {
          // A preview writes nothing: importing runs someone else's prompt, so the
          // contents are shown first.
          if (url.searchParams.get('preview') === '1') {
            return Response.json({ ok: true, value: { preview: readBundle(archive) } })
          }
          const result = await unpackHumans(home, archive, {
            id: url.searchParams.get('id') ?? undefined,
            overwrite: url.searchParams.get('overwrite') !== 'false',
          })
          for (const record of result.records) await store.upsert(record as HumanPatch, seed)
          await refresh()
          const { records: _stored, ...report } = result
          return Response.json({ ok: true, value: report })
        } catch (error) {
          return Response.json({ ok: false, error: { code: 'bad-request', message: error.message } }, { status: 400 })
        }
      },
    })
  }
 catch (error) {
    // A refused route must not take the rest of `apply` with it: the presets and the
    // management route are already up, and the failure is worth seeing.
    log(`the bundle route was refused: ${error.message}`)
  }

  // A digital human works autonomously: it takes a task from a peer and runs
  // shell and file tools without a person watching the approval prompt. The
  // deployment default is `workspace-write` plus `ask`, and no composed answerer
  // exists in an IM turn, so an ask would fail closed and stall the work.
  //
  // `SessionCreateRequest` carries no permission field, so the override is
  // applied after creation instead: `permissionPresets.set` records the change
  // and drives each knob through its own setter, which is the same path the GUI
  // uses. The lookup is keyed on a generated preset id, so the override reaches
  // this plugin's sessions only.
  /**
   * The permission preset already applied to each session.
   *
   * Keyed to the preset, not merely to the session: a session created under one
   * digital human and later switched to another would otherwise keep the first
   * one's access.
   */
  const granted = new Map<string, string>()

  /**
   * Sessions that announced a preset before the presets were registered.
   *
   * The hooks are subscribed before the first `refresh()` finishes, so a session
   * created in that window finds no entry in `permissionByPreset` and would keep
   * the deployment's default access for its whole life. They are remembered here
   * and resolved once the roster is known.
   */
  const pendingPermission = new Map<string, { session: unknown; preset: string }>()

  /**
   * Apply one digital-human session's permission preset, once.
   * @param session - the session that announced itself.
   * @param announced - the preset named by the announcing event, when it was a
   * selection rather than a creation; the header is the creation-time value and
   * is stale by then.
   */
  /**
   * How one session should run, given who is talking.
   *
   * A record's own preset applies to its owner. A direct conversation with anyone else
   * is confined to the workspace, so a stranger who reaches the bot cannot act on the
   * machine. A group, an unclaimed bot, and a session with no IM conversation all keep
   * the record's preset.
   *
   * @param record - the digital human the session runs.
   * @param sessionId - the session asking for access.
   * @param fallback - the preset the record itself names.
   */
  function accessForTalker(record: Human, sessionId: string, fallback: string): TalkerAccess {
    const botId = record.im?.botId
    const owner = record.im?.owner
    if (!botId || !owner) return { preset: fallback }
    const sender = directSenderOf(home, botId, sessionId)
    if (!sender || sender === owner) return { preset: fallback }
    return { sandbox: GUEST_SANDBOX_MODE, approval: GUEST_APPROVAL_POLICY, sender }
  }

  function grantPermission(session, announced?: string) {
    const sessionId = session?.id ?? session?.header?.id
    if (typeof sessionId !== 'string') return
    const preset = typeof announced === 'string' ? announced : session?.header?.agentPreset
    if (typeof preset !== 'string') return
    const named = permissionByPreset.get(preset)
    if (!named) {
      pendingPermission.set(sessionId, { session, preset })
      return
    }
    const record = boundByPreset.get(preset)
    const access = record ? accessForTalker(record, sessionId, named) : { preset: named }
    const wanted = 'preset' in access ? access.preset : `confine:${access.sandbox}:${access.approval}`
    if (granted.get(sessionId) === wanted) return
    granted.set(sessionId, wanted)
    if (!('preset' in access)) {
      // Confine the session without naming a preset. The two appends are exactly what
      // the preset service does for its own bundles, so any deployment supports them
      // and the session reports itself as `custom`.
      if (typeof session?.append !== 'function') {
        log(`session ${sessionId} needs ${access.sandbox}/${access.approval}, but the session cannot record it`)
        return
      }
      session.append('sandbox/mode', { mode: access.sandbox })
      session.append('approval/policy', { policy: access.approval })
      log(`session ${sessionId} is a direct chat with ${access.sender}, not owner: ${access.sandbox} + ${access.approval}`)
      return
    }
    const permissionPresets = ctx.get?.('permissionPresets')
    if (typeof permissionPresets?.set !== 'function') {
      log(`session ${sessionId} runs ${preset}, but permissionPresets is absent, so ${wanted} was not applied`)
      return
    }
    // The announcement fires while the session is still being published, so the
    // first attempt can land too early. One retry on the next microtask runs
    // after publication. Re-selecting the effective preset appends nothing, so a
    // retry after a partial write is harmless.
    const attempt = (retry) => {
      try {
        permissionPresets.set(session, wanted)
        log(`session ${sessionId} (${preset}) runs with ${wanted}`)
      } catch (error) {
        if (retry) {
          queueMicrotask(() => attempt(false))
          return
        }
        log(`could not set ${wanted} on session ${sessionId}: ${error.message}`)
      }
    }
    attempt(true)
  }

  // The creation header names the preset the session started with, so this is
  // the normal path. A session may still change preset while it is blank, which
  // the `agent-preset/selected` branch below catches.
  ctx.on('session/created', (session) => {
    grantPermission(session)
    // A session means IM is delivering messages, so anything that failed while it
    // was still starting up can be pushed now. This is the exact signal the retry
    // loop has to guess at, and it survives an initialization slower than the loop.
    const record = boundByPreset.get(session?.header?.agentPreset)
    if (!record || !worthRetrying(alignmentByHuman.get(record.id) ?? [])) return
    align(record).catch((error) => log(`alignment on session creation failed: ${error.message}`))
  }, { global: true })
  ctx.on('session/disposed', (session) => {
    const sessionId = session?.id ?? session?.header?.id
    if (typeof sessionId === 'string') granted.delete(sessionId)
  }, { global: true })

  // Mirror each digital human's own turns into its mailbox. Without this the log
  // would hold only what peers sent, and `/chat/messages` could not return a reply.
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id ?? session?.header?.id
    if (typeof sessionId !== 'string') return
    const kind = event?.type
    // A preset chosen after creation is the only other way a session becomes a
    // digital-human session, so it must reach the same override.
    if (kind === 'agent-preset/selected') {
      grantPermission(session, event.data?.agentPreset)
      return
    }
    // The reverse index is the fast path. When it is empty — a startup read that was
    // missed, a Session it does not name — the header's preset still says whose turn
    // this is, so the mapping is recovered instead of the event being dropped.
    const known = async () => {
      const primed = chat.ownerOf(sessionId)
      if (primed) return primed
      const humanId = humanByPreset.get(session?.header?.agentPreset)
      if (!humanId) return undefined
      try {
        return await chat.adopt(sessionId, humanId)
      } catch (error) {
        log(`could not recognise session ${sessionId}: ${error.message}`)
        return undefined
      }
    }
    // The Host's turn boundaries are the only authoritative source of a work item's
    // state: a model reporting its own success is not a completion signal.
    if (kind === 'turn/start') {
      void known().then(async (owner) => {
        if (!owner) return undefined
        return ledger.start(owner.humanId, {
          conversation: owner.conversationId,
          sessionId,
          singleThread: await isSharedSession(owner.humanId),
        })
      }).catch((error) => log(`work item start failed for ${sessionId}: ${error.message}`))
      return
    }
    if (kind === 'turn/end') {
      void known().then((owner) => {
        if (!owner) return undefined
        // Only this turn's own item is closed; the queue behind it is untouched.
        // The same boundary reclaims the timeline, so memory maintenance shares the
        // one subscription instead of adding a timer of its own.
        reclaimHistory(owner.humanId)
        return settleTurn(owner.humanId, sessionId, event.data?.reason)
      }).catch((error) => log(`work item end failed for ${sessionId}: ${error.message}`))
      return
    }
    // Only the assistant side is mirrored. An inbound message is already written
    // by `deliver`, and a `user/message` event also carries injected
    // system-reminders and runtime-context snapshots, which are not conversation.
    if (kind === 'assistant/message') {
      // Same recovery: a reply whose Session was never primed would otherwise go
      // unlogged, and the thread would lose the half of the conversation it wrote.
      void known().then(async (owner) => {
        if (!owner) return
        // A turn that was already running when its item arrived never emitted
        // turn/start for it, so the item would stay queued with nothing to close it.
        // A reply is proof the turn is real, so it claims the queue head too; the
        // call is a no-op when an item is already in progress.
        await ledger.start(owner.humanId, {
          conversation: owner.conversationId,
          sessionId,
          singleThread: await isSharedSession(owner.humanId),
        }).catch((error) => log(`work item claim failed for ${sessionId}: ${error.message}`))
        await chat.noteAssistant(sessionId, event.data?.message ?? event.data)
      }).catch((error) => log(`mailbox write failed: ${error.message}`))
    }
  }, { global: true })

  // A hand-edited registry is documented as supported, so a bad file must degrade
  // rather than take the whole platform down: the tools, the presets and the
  // settings page all mount from here, and that page is how the file gets fixed.
  try {
    await refresh()
    // Nothing is mid-turn right after a restart, so any in-progress item is a ghost.
    await sweepTasks()
    // A pending title plan is applied once, through the Host, so the projection the
    // list reads and the log agree on the title and its sequence.
    applyTitlePlan(home, async (sessionId, title) => {
      const controller = ctx.get?.('sessionController')
      const rename = controller?.rename
      if (typeof rename !== 'function') throw new Error('renaming is unavailable on this Host')
      await rename.call(controller, { sessionId, title })
    }, log).catch((error) => log(`title plan failed: ${error.message}`))
    // The roster is known now, so a session that announced itself during the first
    // refresh can finally be given the access its record asks for.
    for (const [sessionId, entry] of [...pendingPermission]) {
      pendingPermission.delete(sessionId)
      grantPermission(entry.session, entry.preset)
    }
    // Read inside the guard: a second read outside it would throw past the catch and
    // take activation down anyway.
    log(`platform ready: home=${home}, humans=${(await store.list(seed)).length}, presets=${activePresets.size}`)
  } catch (error) {
    log(`the registry could not be read, so no digital human was mounted: ${error.message}`)
  }
}
