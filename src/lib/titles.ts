/**
 * One-shot title plan.
 *
 * A Session title must be written through the Host: `rename` allocates the event
 * sequence and updates the projection the session list reads. Editing the log by
 * hand cannot do either, and a plan applied here is the only way to retitle
 * Sessions that nobody is talking to right now.
 *
 * The plan is a JSON array of `{ sessionId, title }`. It is consumed once and
 * renamed with an `.applied` suffix, so a restart never re-applies it.
 */

import { existsSync } from 'node:fs'
import { readFile, rename as renameFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** File name inside the registry home. */
export const TITLE_PLAN = 'title-plan.json'

/** One entry of the plan. */
interface TitleEntry {
  sessionId: string
  title: string
}

/**
 * Apply the pending title plan, if any.
 *
 * Every entry is attempted independently: one stale Session id must not stop the
 * rest, and a failure is reported rather than thrown, because titles are a
 * convenience and this runs during activation.
 *
 * @param home - registry root holding the plan file.
 * @param rename - the Host's rename, already bound to its controller.
 * @param log - sink for contained failures.
 * @returns how many titles were accepted, and how many were skipped.
 */
export async function applyTitlePlan(
  home: string,
  rename: (sessionId: string, title: string) => Promise<unknown>,
  log: (message: string) => void,
): Promise<{ applied: number; failed: number }> {
  const file = join(home, TITLE_PLAN)
  if (!existsSync(file)) return { applied: 0, failed: 0 }
  let entries: TitleEntry[] = []
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (Array.isArray(parsed)) {
      entries = parsed.filter((entry) => typeof entry?.sessionId === 'string' && typeof entry?.title === 'string' && entry.title.trim())
    }
  } catch (error) {
    log(`title plan is unreadable: ${error.message}`)
    return { applied: 0, failed: 0 }
  }
  let applied = 0
  let failed = 0
  const refused: Array<{ sessionId: string; error: string }> = []
  for (const entry of entries) {
    try {
      await rename(entry.sessionId, entry.title.trim())
      applied += 1
    } catch (error) {
      failed += 1
      refused.push({ sessionId: entry.sessionId, error: String(error?.message ?? error) })
      log(`title for ${entry.sessionId} was refused: ${error.message}`)
    }
  }
  try {
    await renameFile(file, `${file}.applied-${Date.now()}`)
  } catch (error) {
    log(`title plan could not be retired: ${error.message}`)
  }
  try {
    await writeFile(`${file}.result.json`, `${JSON.stringify({ applied, failed, refused }, null, 2)}\n`)
  } catch {}
  log(`title plan applied: ${applied} accepted, ${failed} refused`)
  return { applied, failed }
}
