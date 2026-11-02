/**
 * Requirement directory metadata.
 *
 * A requirement directory is named for the requirement, in Chinese, plus its
 * creation date: `reqs/组织基线验证-20261102/`. The thread name stays the Session
 * key, so the mapping between the two lives in `meta.json` beside the docs:
 *
 *   { "thread": "<thread name>", "name": "<requirement name>" }
 *
 * The directory is data, not code: every name is read from the file, and a
 * requirement without one falls back to its thread name.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** One requirement directory, as `meta.json` describes it. */
export interface RequirementDir {
  /** Directory name under `reqs/`. */
  dir: string
  /** Requirement name the menu shows; Chinese in practice, never assumed. */
  name: string
}

/** Directory under the requirement root that holds one directory per requirement. */
export const REQUIREMENTS_DIR = 'reqs'

/**
 * Read every `reqs/<dir>/meta.json` under one requirement root.
 *
 * @param workspacePath - the requirement root, the parent of the digital humans'
 *   workspaces. An absent root yields an empty map, which reads as "no metadata".
 * @returns thread name -> the directory and display name it maps to.
 */
export function readRequirementDirs(workspacePath: string | undefined): Map<string, RequirementDir> {
  const found = new Map<string, RequirementDir>()
  if (!workspacePath) return found
  const root = join(workspacePath, REQUIREMENTS_DIR)
  let entries: Array<{ name: string; isDirectory(): boolean }> = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    // No requirement directory yet is not an error.
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const parsed = JSON.parse(readFileSync(join(root, entry.name, 'meta.json'), 'utf8'))
      const thread = typeof parsed?.thread === 'string' ? parsed.thread.trim() : ''
      const name = typeof parsed?.name === 'string' ? parsed.name.trim() : ''
      // A half-written meta cannot name anything; the thread fallback is better
      // than a directory whose title would be blank.
      if (!thread || !name) continue
      found.set(thread, { dir: entry.name, name })
    } catch {
      // No meta, or malformed: the requirement keeps its thread name.
    }
  }
  return found
}
