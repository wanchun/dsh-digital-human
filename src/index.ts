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

import { HumanStore, defaultHome } from './lib/store.js'
import { HumanChat } from './lib/chat.js'
import { buildPresetDefinition, presetIdOf, resolveConfigValues } from './lib/presets.js'
import { buildRegistryTool } from './lib/tools.js'
import { listLibrary, removeSkill, writeSkill } from './lib/skills.js'
import { packHuman, readBundle, unpackHuman } from './lib/bundle.js'
import { RPC_PATH } from './lib/rpc.js'
import { registerRpc } from './lib/rpc.js'
import { directSenders, syncBotToHuman } from './lib/im.js'
import type { ImSyncResult } from './lib/im.js'
import { DEFAULT_WORKSPACE_TITLE, ensureDefaultWorkspace, listWorkspaces, readBotMeta } from './lib/workspaces.js'
import { SEED_HUMANS } from './lib/seed.js'
import type { Config, Ctx, Human, HumanPatch, WorkspaceView } from './lib/types.js'

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
  toolsPlugin: '@local/dsh-digital-human/tools',
  /**
   * Permission preset for a digital human that names none.
   *
   * A digital human works without a person watching the approval prompt, and an
   * IM turn composes no approval answerer — so the deployment default
   * (`workspace-write` plus `ask`) would fail closed and stall the work. Full
   * access is the preset that neither confines the sandbox nor asks.
   *
   * It is a setting rather than a constant because the right answer is a
   * deployment's policy, not this plugin's: a profile that trusts its digital
   * humans differently says so in its own composition.
   */
  permissionPreset: 'danger-full-access',
}

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
 * The permission preset one record runs under: its own choice, else the
 * deployment's.
 *
 * @param human - the record to read.
 * @param fallback - the deployment default.
 */
function permissionPresetOf(human: Human, fallback: string): string {
  const named = typeof human.permissionPreset === 'string' ? human.permissionPreset.trim() : ''
  return named || fallback
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
  const fallbackPermission = setting(config, 'permissionPreset')
  // An absent or empty list means "use the built-in platform set".
  const platformVariables = Array.isArray(config.platformVariables) && config.platformVariables.length > 0
    ? config.platformVariables.filter((name) => typeof name === 'string' && name)
    : undefined
  // The retry window is configurable so a deployment — or a test — can shorten it.
  const alignRetryMs = positiveSetting(config, 'alignRetryMs', ALIGN_RETRY_MS_DEFAULT)
  const alignRetryMax = positiveSetting(config, 'alignRetryMax', ALIGN_RETRY_MAX_DEFAULT)
  // Opt-in, and off unless asked for. A fresh install grows no digital humans: they
  // are configured in the page or imported as a bundle, which is the plugin's job.
  // The examples exist for the tests, which ask for them explicitly.
  const seed: Human[] = config.seed === true ? (SEED_HUMANS as Human[]) : []
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

  /** Preset disposers currently owned by this plugin. */
  const disposers: Array<() => unknown> = []
  /** human id -> generated preset id, for enabled records only. */
  const activePresets = new Map<string, string>()
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
      workspace: record.workspace,
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
    permissionByPreset.clear()
    boundByPreset.clear()
    // Cleared with the others: a stale outcome would report a bot as aligned after
    // its binding changed or the record was removed.
    alignmentByHuman.clear()
    const humans = await store.list(seed)
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
        // The renderer throws when a registered variable has no value, so a session
        // that will have no working directory must not be told about one.
        hasWorkingDirectory: Boolean(record.workspace || defaultWorkspace),
      })
      permissionByPreset.set(definition.id, permissionPresetOf(record, fallbackPermission))
      try {
        disposers.push(await ctx.agentPresets.register(definition))
        activePresets.set(record.id, definition.id)
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
    /** Deliver a message into a digital human's conversation, like `/chat/send`. */
    async send(
      idOrName: string,
      { conversationId, sessionId, message, from, fromSession }: {
        conversationId?: string
        sessionId?: string
        message?: string
        from?: string
        fromSession?: string
      },
    ) {
      const human = await service.require(idOrName)
      return chat.deliver(human, {
        conversationId,
        sessionId,
        message,
        from,
        // The caller's own Session rides along, so the answer can come back to it.
        fromSession,
        presetId: presetIdOf(human.id),
      })
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
  if (typeof bundleRoute?.fetch?.register === 'function') {
    bundleRoute.fetch.register({
      path: `${RPC_PATH}/bundle`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url)
        if (request.method === 'GET') {
          const id = decodeURIComponent(url.pathname.slice(`${RPC_PATH}/bundle/`.length))
          const human = await store.get(id, seed)
          if (!human) return new Response(`unknown digital human: ${JSON.stringify(id)}`, { status: 404 })
          const includeMemory = url.searchParams.get('memory') === '1'
          const { archive } = packHuman(home, human, { includeMemory })
          const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')
          return new Response(archive, {
            status: 200,
            headers: {
              'content-type': 'application/gzip',
              'content-disposition': `attachment; filename="${human.id}-${stamp}.dh.tar.gz"`,
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
          const result = await unpackHuman(home, archive, {
            id: url.searchParams.get('id') ?? undefined,
            overwrite: url.searchParams.get('overwrite') !== 'false',
          })
          await store.upsert(result.record as HumanPatch, seed)
          await refresh()
          const { record: _stored, ...report } = result
          return Response.json({ ok: true, value: report })
        } catch (error) {
          return Response.json({ ok: false, error: { code: 'bad-request', message: error.message } }, { status: 400 })
        }
      },
    })
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
  function grantPermission(session, announced?: string) {
    const sessionId = session?.id ?? session?.header?.id
    if (typeof sessionId !== 'string') return
    const preset = typeof announced === 'string' ? announced : session?.header?.agentPreset
    if (typeof preset !== 'string') return
    const wanted = permissionByPreset.get(preset)
    if (!wanted) {
      pendingPermission.set(sessionId, { session, preset })
      return
    }
    if (granted.get(sessionId) === wanted) return
    granted.set(sessionId, wanted)
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
    if (!chat.ownerOf(sessionId)) return
    // Only the assistant side is mirrored. An inbound message is already written
    // by `deliver`, and a `user/message` event also carries injected
    // system-reminders and runtime-context snapshots, which are not conversation.
    if (kind === 'assistant/message') {
      Promise.resolve(chat.noteAssistant(sessionId, event.data?.message ?? event.data)).catch((error) => log(`mailbox write failed: ${error.message}`))
    }
  }, { global: true })

  // A hand-edited registry is documented as supported, so a bad file must degrade
  // rather than take the whole platform down: the tools, the presets and the
  // settings page all mount from here, and that page is how the file gets fixed.
  try {
    await refresh()
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
