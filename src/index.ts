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
import { buildPresetDefinition, presetIdOf } from './lib/presets.js'
import { buildRegistryTool } from './lib/tools.js'
import { registerRpc } from './lib/rpc.js'
import { syncBotToHuman } from './lib/im.js'
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
}

/** First preset order handed to a generated digital-human preset. */
const PRESET_ORDER_BASE = 100

/** Read one optional string setting. */
function setting(config: Config, key: 'home' | 'basePreset' | 'toolsPlugin'): string {
  const value = config?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULTS[key]
}

/**
 * Mount the digital-human platform.
 * @param ctx - Host context carrying the preset registry, session controller, and tool registry.
 * @param config - registry location, seeding, and the capability baseline.
 */
export async function apply(ctx: Ctx, config: Config = {}): Promise<void> {
  const home = setting(config, 'home') || defaultHome()
  const basePreset = setting(config, 'basePreset')
  const toolsPlugin = setting(config, 'toolsPlugin')
  const seed: Human[] = config.seed === false ? [] : (SEED_HUMANS as Human[])
  const store = new HumanStore(home)
  const log = (message: string): void => { ctx.logger?.warn?.(`digital-human: ${message}`) }
  // A closure, not a value: the default Workspace is resolved during refresh(),
  // which runs after this constructor.
  const chat = new HumanChat(ctx, store, log, { defaultWorkspacePath: () => defaultWorkspace?.path })

  /** Preset disposers currently owned by this plugin. */
  const disposers: Array<() => unknown> = []
  /** human id -> generated preset id, for enabled records only. */
  const activePresets = new Map<string, string>()

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
    const humans = await store.list(seed)
    defaultWorkspace = await ensureDefaultWorkspace(ctx, { home, log })
    let order = PRESET_ORDER_BASE
    for (const human of humans) {
      if (!human.enabled) continue
      const definition = buildPresetDefinition(human, {
        store,
        toolsPluginName: toolsPlugin,
        order: order++,
      })
      try {
        disposers.push(await ctx.agentPresets.register(definition))
        activePresets.set(human.id, definition.id)
      } catch (error) {
        log(`preset "${definition.id}" failed to register: ${error.message}`)
      }
    }
    await chat.prime(humans)
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
      await refresh()
      // The digital human owns the mode and the directory. Push both onto the
      // bound bot through IM's own endpoints, so the change lands in its memory
      // and survives its next write. A failure here never fails the save.
      const alignment = await syncBotToHuman(ctx, {
        botId: saved.im?.botId,
        workspace: saved.workspace,
        presetId: presetIdOf(saved.id),
        log,
      })
      return { ...saved, presetId: presetIdOf(saved.id), alignment }
    },
    /** Delete one digital human and drop its preset. */
    async remove(id) {
      const removed = await store.remove(id, seed)
      if (removed) await refresh()
      return removed
    },
    /** Deliver a message into a digital human's conversation, like `/chat/send`. */
    async send(
      idOrName: string,
      { conversationId, message, from }: { conversationId?: string; message?: string; from?: string },
    ) {
      const human = await service.require(idOrName)
      return chat.deliver(human, { conversationId, message, from, presetId: presetIdOf(human.id) })
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
  registerRpc(ctx, async (method, payload) => {
    const ok = (value) => ({ ok: true, value })
    const bad = (message) => ({ ok: false, error: { code: 'bad-request', message, details: {} } })
    if (method === 'registry.list') {
      const humans = await service.list()
      return ok({ home, file: store.file, humans })
    }
    if (method === 'registry.get') {
      const found = await service.resolve(payload.id)
      return found ? ok({ human: found }) : bad(`unknown digital human: ${JSON.stringify(payload.id)}`)
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

  // Mirror each digital human's own turns into its mailbox. Without this the log
  // would hold only what peers sent, and `/chat/messages` could not return a reply.
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id ?? session?.header?.id
    if (typeof sessionId !== 'string' || !chat.ownerOf(sessionId)) return
    const kind = event?.type
    // Only the assistant side is mirrored. An inbound message is already written
    // by `deliver`, and a `user/message` event also carries injected
    // system-reminders and runtime-context snapshots, which are not conversation.
    if (kind === 'assistant/message') {
      Promise.resolve(chat.noteAssistant(sessionId, event.data?.message ?? event.data)).catch((error) => log(`mailbox write failed: ${error.message}`))
    }
  }, { global: true })

  await refresh()
  log(`platform ready: home=${home}, humans=${(await store.list(seed)).length}, presets=${activePresets.size}`)
}
