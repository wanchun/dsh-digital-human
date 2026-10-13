/**
 * Workspace discovery for digital humans.
 *
 * A digital human runs in a Workspace, so the config page offers the Workspaces
 * the Harness already knows instead of a free-text path. When a record names no
 * Workspace, the digital human lands in one dedicated default Workspace.
 *
 * `workspaceController` is a remote service, so it is read through `ctx.get`
 * and every call degrades to `undefined` rather than blocking activation.
 */

import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Ctx } from './types.js'

/** Title of the Workspace a digital human uses when its record names none. */
export const DEFAULT_WORKSPACE_TITLE = '数字人'

/** Directory that backs the default Workspace. */
export function defaultWorkspacePath(home) {
  return join(home, 'workspace')
}

/** How long to wait for the roster's first frame before giving up. */
const ROSTER_TIMEOUT_MS = 5000

/**
 * Read the Workspace roster. `follow` is a live stream whose first frame is a
 * complete baseline, so one frame is enough and the stream is then aborted.
 */
export async function listWorkspaces(ctx, { timeoutMs = ROSTER_TIMEOUT_MS } = {}) {
  const controller = ctx.get?.('workspaceController')
  if (!controller || typeof controller.follow !== 'function') return []
  const abort = new AbortController()
  // A stream that never emits its baseline would hold activation open forever, and
  // a hang is worse than an empty roster: the caller logs and carries on.
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    for await (const frame of controller.follow(abort.signal)) {
      if (frame?.type !== 'baseline') continue
      const items = frame.value?.items
      return Array.isArray(items) ? [...items] : []
    }
    return []
  } catch {
    return []
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}

/**
 * Find the default Workspace, creating and renaming it on first use.
 * @returns the Workspace, or `undefined` when the Harness cannot supply one.
 */
export async function ensureDefaultWorkspace(
  ctx: Ctx,
  { home, log = () => {} }: { home: string; log?: (message: string) => void },
) {
  const controller = ctx.get?.('workspaceController')
  if (!controller || typeof controller.create !== 'function') return undefined
  const existing = (await listWorkspaces(ctx)).find((item) => item.title === DEFAULT_WORKSPACE_TITLE)
  if (existing) return existing
  const path = defaultWorkspacePath(home)
  try {
    await mkdir(path, { recursive: true })
    const created = await controller.create({ path })
    const workspace = created?.workspace
    if (!workspace) return undefined
    if (workspace.title === DEFAULT_WORKSPACE_TITLE || typeof controller.rename !== 'function') return workspace
    try {
      const renamed = await controller.rename({ workspaceId: workspace.workspaceId, title: DEFAULT_WORKSPACE_TITLE })
      return renamed?.workspace ?? workspace
    } catch (error) {
      // The workspace exists and works; only its title is wrong. Discarding it here
      // would leave the platform with no default workspace at all.
      log(`default workspace "${DEFAULT_WORKSPACE_TITLE}" could not be renamed: ${error.message}`)
      return workspace
    }
  } catch (error) {
    log(`default workspace "${DEFAULT_WORKSPACE_TITLE}" unavailable: ${error.message}`)
    return undefined
  }
}

/**
 * Read the alias and the directory of each IM bot.
 *
 * `listBots` reports only an opaque id, so a picker cannot tell two bots apart
 * without this. The file belongs to the IM integration, so a missing or
 * malformed file yields empty maps rather than an error.
 *
 * @returns {Promise<{aliases: Record<string, string>, workspaces: Record<string, string>}>}
 */
export async function readBotMeta(dshRoot = join(homedir(), '.dsh')) {
  const aliases: Record<string, string> = {}
  const workspaces: Record<string, string> = {}
  const root = join(dshRoot, 'integrations')
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return { aliases, workspaces }
  }
  // Every IM channel keeps its bots under its own `dsh-<channel>` directory, so
  // scan them all instead of naming one. A new channel is picked up for free.
  // A plain object or nothing: spreading a string would turn it into an index map
  // (`{0: 'n', 1: 'o'}`), which then reads as a bot named "0".
  const asMap = (value: unknown): Record<string, unknown> => (
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  )
  for (const entry of entries) {
    try {
      const parsed = JSON.parse(await readFile(join(root, entry, 'workspaces.json'), 'utf8'))
      for (const [botId, value] of Object.entries(asMap(parsed?.aliases))) {
        if (typeof value === 'string') aliases[botId] = value
      }
      for (const [botId, value] of Object.entries(asMap(parsed?.workspaces))) {
        if (typeof value === 'string') workspaces[botId] = value
      }
    } catch {
      // A channel without that file, or with a malformed one, contributes nothing.
    }
  }
  return { aliases, workspaces }
}
