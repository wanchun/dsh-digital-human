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

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'

/** One requirement directory, as `meta.json` describes it. */
export interface RequirementDir {
  /** Directory name under `reqs/`. */
  dir: string
  /** Requirement name the menu shows; Chinese in practice, never assumed. */
  name: string
}

/** Directory under the requirement root that holds one directory per requirement. */
export const REQUIREMENTS_DIR = 'reqs'

/** Directory under the requirement root that holds archived requirements and their index. */
export const ARCHIVE_DIR = '_archive'

/** Header of the archive index, written once by the first archive. */
const ARCHIVE_INDEX_HEADER = [
  '| 需求名 | 线程名 | 归档时间 | 节点数 | 最后阶段 |',
  '|---|---|---|---|---|',
]

/**
 * The separator between two table cells: a pipe the writer did not escape.
 *
 * A requirement name is free text and may contain a pipe, so a row is split on the
 * unescaped separators only; otherwise one such name would shift every cell after
 * it and the row could never be found again.
 */
const TABLE_CELL = /(?<!\\)\|/

/** One index cell: a pipe inside a value would end the cell early. */
function cell(value: string): string {
  return String(value ?? '').replace(/\|/g, '\\|')
}

/**
 * Read every `reqs/<dir>/meta.json` under one requirement root.
 *
 * @param workspacePath - the requirement root, the parent of the digital humans'
 *   workspaces. An absent root yields an empty map, which reads as "no metadata".
 * @returns thread name -> the directory and display name it maps to.
 */
export function readRequirementDirs(workspacePath: string | undefined): Map<string, RequirementDir> {
  if (!workspacePath) return new Map()
  return readMetaDirs(join(workspacePath, REQUIREMENTS_DIR))
}

/**
 * Read every archived requirement's `meta.json` under one requirement root.
 *
 * An archived requirement left `reqs/`, so the live map no longer names it. The
 * view still needs to know that the thread is archived, not unknown: this map is
 * what keeps its Sessions off the tree until a restore brings it back.
 *
 * @param workspacePath - the requirement root, the parent of `_archive/`.
 * @returns thread name -> the archived directory and display name.
 */
export function readArchivedRequirementDirs(workspacePath: string | undefined): Map<string, RequirementDir> {
  if (!workspacePath) return new Map()
  return readMetaDirs(join(workspacePath, ARCHIVE_DIR))
}

/** Read the `meta.json` of every directory under one requirement folder. */
function readMetaDirs(root: string): Map<string, RequirementDir> {
  const found = new Map<string, RequirementDir>()
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

/** What one created requirement knows about itself. */
export interface CreatedRequirement {
  dir: string
  path: string
  metaPath: string
}

/**
 * Create one requirement directory and its metadata in a single step.
 *
 * The directory, the display name and the thread name are one fact written once:
 * letting a persona assemble them by hand is how the three drifted apart.
 */
export function createRequirement(
  root: string,
  input: { thread: string; name: string; subsystems?: Array<Record<string, string>> },
): CreatedRequirement {
  const thread = String(input.thread || '').trim()
  const name = String(input.name || '').trim()
  if (!thread) throw new Error('thread is required')
  if (!name) throw new Error('name is required')
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const dir = `${name}-${stamp}`
  const path = join(root, REQUIREMENTS_DIR, dir)
  mkdirSync(path, { recursive: true })
  const metaPath = join(path, 'meta.json')
  const meta = { thread, name, createdAt: new Date().toISOString(), subsystems: input.subsystems ?? [] }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8')
  const rows = (input.subsystems ?? []).map((row) =>
    `| ${row.subsystem ?? ''} | ${row.version ?? ''} | ${row.deployBranch ?? ''} | ${row.env ?? ''} |`)
  const params = [
    '# 参数确认',
    '',
    `- 需求名称：${name}`,
    `- 线程名：${thread}`,
    '',
    '## 子系统参数',
    '',
    '| 子系统 | 版本 | 部署分支 | 目标环境 |',
    '|---|---|---|---|',
    ...(rows.length > 0 ? rows : ['| （无子系统） | | | |']),
    '',
  ].join('\n')
  writeFileSync(join(path, 'params.md'), params, 'utf8')
  return { dir, path, metaPath }
}

/** One requirement's durable state: the digest every role reads instead of history. */
export interface RequirementState {
  thread: string
  name: string
  phase: string
  nodes: Record<string, { status: string; note?: string; evidence?: string[]; updatedAt?: string }>
  next: string[]
  events: string[]
  updatedAt?: string
}

/** Where a requirement keeps its state file. */
export function statePath(dirPath: string): string {
  return join(dirPath, 'state.json')
}

/** Read one requirement's state, returning an empty skeleton when it has none yet. */
export function readState(dirPath: string, fallback: { thread: string; name: string }): RequirementState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(dirPath), 'utf8'))
    if (parsed && typeof parsed === 'object') {
      return {
        thread: String(parsed.thread ?? fallback.thread),
        name: String(parsed.name ?? fallback.name),
        phase: String(parsed.phase ?? 'planning'),
        nodes: parsed.nodes && typeof parsed.nodes === 'object' ? parsed.nodes : {},
        next: Array.isArray(parsed.next) ? parsed.next.map(String) : [],
        events: Array.isArray(parsed.events) ? parsed.events.map(String) : [],
        updatedAt: parsed.updatedAt,
      }
    }
  } catch {
    // A missing or broken file reads as "nothing recorded yet".
  }
  return { thread: fallback.thread, name: fallback.name, phase: 'planning', nodes: {}, next: [], events: [] }
}

/** Write one requirement's state, keeping the file small on purpose. */
export function writeState(dirPath: string, state: RequirementState): RequirementState {
  const next = { ...state, updatedAt: new Date().toISOString(), events: state.events.slice(-20) }
  writeFileSync(statePath(dirPath), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/** The compact digest a role reads at turn start: bounded, no history. */
export function renderDigest(state: RequirementState): string {
  const lines = [
    '# 需求状态',
    '',
    '线程名：' + state.thread,
    '需求名：' + state.name,
    '阶段：' + state.phase,
    '',
    '## 节点',
  ]
  const nodes = Object.entries(state.nodes)
  if (nodes.length === 0) lines.push('（尚未开始）')
  for (const [node, info] of nodes) {
    const evidence = (info.evidence ?? []).slice(0, 3).join(' ')
    lines.push('- ' + node + '：' + info.status + (info.note ? '（' + info.note + '）' : '') + (evidence ? ' 证据 ' + evidence : ''))
  }
  lines.push('', '## 下一步')
  lines.push(state.next.length > 0 ? state.next.map((item) => '- ' + item).join('\n') : '（无）')
  if (state.events.length > 0) {
    lines.push('', '## 近期事件')
    for (const event of state.events.slice(-3)) lines.push('- ' + event)
  }
  return lines.join('\n')
}

/** Fold one evidence file into the requirement, returning its absolute path. */
export function attachFile(dirPath: string, input: { name: string; content: string; kind?: string }): string {
  const kind = input.kind === 'self-test' ? 'self-test' : input.kind === 'files' ? 'files' : 'nodes'
  const target = join(dirPath, kind)
  mkdirSync(target, { recursive: true })
  const file = join(target, input.name.replace(/[\/]+/g, '-'))
  writeFileSync(file, input.content, 'utf8')
  return file
}

/** Resolve one requirement directory by thread name or directory name. */
export function findRequirementDir(root: string, key: string): string | undefined {
  return findDirUnder(join(root, REQUIREMENTS_DIR), key)
}

/**
 * Resolve one archived requirement directory by thread name or directory name.
 *
 * Only a directory under `_archive/` counts, so a restore cannot move a live
 * requirement, and a send can tell an archived requirement from an unknown one.
 */
export function findArchivedRequirementDir(root: string, key: string): string | undefined {
  return findDirUnder(join(root, ARCHIVE_DIR), key)
}

/** Resolve one directory under a requirement folder by meta thread or folder name. */
function findDirUnder(base: string, key: string): string | undefined {
  const byThread = readMetaDirs(base)
  const hit = byThread.get(key)
  if (hit) return join(base, hit.dir)
  try {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name === key) return join(base, entry.name)
    }
  } catch {
    return undefined
  }
  return undefined
}

/** One archived requirement, as the archive left it. */
export interface ArchivedRequirement {
  /** Directory name the requirement now has under `_archive/`. */
  dir: string
  /** When the move happened, as an ISO 8601 timestamp. */
  archivedAt: string
  /** Absolute path of the index that holds the new row. */
  index: string
}

/**
 * Move one requirement directory into the archive root and record the move.
 *
 * The move keeps every file: a requirement holds the evidence of its own work, so
 * archiving is a change of location, never a cleanup. The state is written with
 * phase `archived`, and one row is appended to `_archive/index.md`, which is
 * created with its header on the first archive.
 *
 * Every write happens before the move. A write that fails therefore leaves the
 * requirement where it was, unchanged and retryable; a directory that moved before
 * its record was written could only be put right by hand.
 *
 * @param root - the requirement root, the parent of `reqs/`.
 * @param sourcePath - the requirement directory to move.
 * @param names - the thread name and display name the row and state fall back to.
 * @returns the archived directory name, the timestamp, and the index path.
 */
export function archiveRequirement(
  root: string,
  sourcePath: string,
  names: { thread: string; name: string },
): ArchivedRequirement {
  const archiveRoot = join(root, ARCHIVE_DIR)
  const dir = basename(sourcePath)
  const target = join(archiveRoot, dir)
  // A second archive of the same name would overwrite the documents of the first.
  if (existsSync(target)) {
    throw new Error(
      `archive target already exists: ${target}. Nothing was moved. Rename or remove the archived copy first.`,
    )
  }
  // Read the state before anything is written: the row records the phase the
  // requirement ended in, and the snapshot is what a failed move is rolled back to.
  const before = readState(sourcePath, names)
  const lastPhase = before.phase
  const archivedAt = new Date().toISOString()
  mkdirSync(archiveRoot, { recursive: true })
  // The phase before the move is kept in the event: a restore reads it back and
  // has no other record of what the requirement was doing.
  const state: RequirementState = {
    ...before,
    phase: 'archived',
    events: [...before.events, `${archivedAt} archived to ${target} (phase before archive: ${lastPhase})`],
  }
  // The state file moves with the directory, so it is written in place.
  writeState(sourcePath, state)
  const index = join(archiveRoot, 'index.md')
  const rowAt = sizeOrNone(index)
  appendArchiveRow(index, state, archivedAt, lastPhase)
  try {
    renameSync(sourcePath, target)
  } catch (error) {
    // Nothing moved, so nothing may say it did: the row and the state go back.
    dropArchiveRow(index, rowAt)
    writeState(sourcePath, before)
    throw error
  }
  return { dir, archivedAt, index }
}

/** Byte size of one file, or -1 when it does not exist yet. */
function sizeOrNone(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return -1
  }
}

/** Append one archive row, writing the header first when the index is new. */
function appendArchiveRow(
  index: string,
  state: RequirementState,
  archivedAt: string,
  lastPhase: string,
): void {
  const header = existsSync(index) ? '' : ARCHIVE_INDEX_HEADER.join('\n') + '\n'
  const row = `| ${cell(state.name)} | ${cell(state.thread)} | ${archivedAt} | ${Object.keys(state.nodes).length} | ${cell(lastPhase)} |`
  appendFileSync(index, header + row + '\n', 'utf8')
}

/** Put the index back to the size it had before one row, or remove the file it created. */
function dropArchiveRow(index: string, size: number): void {
  try {
    if (size < 0) unlinkSync(index)
    else truncateSync(index, size)
  } catch {
    // The move failed and the requirement is live. A stray row is the lesser fault,
    // and the next archive appends its own row to the same table.
  }
}

/** One restored requirement: where it went and when. */
export interface RestoredRequirement {
  /** Directory name the requirement has again under `reqs/`. */
  dir: string
  /** When the move happened, as an ISO 8601 timestamp. */
  restoredAt: string
}

/**
 * Move one archived requirement back to `reqs/` and record the move.
 *
 * The restore reverses an archive, never a delete: every file moves back with the
 * directory. The phase returns to what it was before the archive, read from the
 * archive event, and falls back to `active` when no event names it. One annotation
 * is added to the archived row, so the index shows that the requirement is live
 * again.
 *
 * @param root - the requirement root, the parent of `reqs/` and `_archive/`.
 * @param sourcePath - the archived requirement directory to move.
 * @param names - the thread name and display name the state falls back to.
 * @returns the restored directory name and the timestamp.
 */
export function restoreRequirement(
  root: string,
  sourcePath: string,
  names: { thread: string; name: string },
): RestoredRequirement {
  const dir = basename(sourcePath)
  const target = join(root, REQUIREMENTS_DIR, dir)
  // A live directory with the same name holds newer work; never overwrite it.
  if (existsSync(target)) {
    throw new Error(
      `restore target already exists: ${target}. Nothing was moved. Rename or remove the live copy first.`,
    )
  }
  // The phase an archive recorded is never `archived` itself: an archive event
  // names the phase the requirement was in before the move.
  const before = readState(sourcePath, names)
  const archivedIndex = join(root, ARCHIVE_DIR, 'index.md')
  const phase = phaseBeforeArchive(before) || 'active'
  const restoredAt = new Date().toISOString()
  const state: RequirementState = {
    ...before,
    phase,
    events: [...before.events, `${restoredAt} restored to ${target}`],
  }
  mkdirSync(join(root, REQUIREMENTS_DIR), { recursive: true })
  // The state is written before the move, like the archive: a failed write leaves
  // the requirement archived and retryable, instead of live while still saying
  // "archived".
  writeState(sourcePath, state)
  try {
    renameSync(sourcePath, target)
  } catch (error) {
    writeState(sourcePath, before)
    throw error
  }
  markIndexRestored(archivedIndex, state.thread, restoredAt)
  return { dir, restoredAt }
}

/** The phase an archive event recorded, or '' when no event names one. */
function phaseBeforeArchive(state: RequirementState): string {
  for (const event of [...state.events].reverse()) {
    const found = /phase before archive: ([^\s()]+)/.exec(event)
    if (found && found[1] !== 'archived') return found[1]
  }
  return ''
}

/**
 * Mark one archived row as restored, in place.
 *
 * The note goes inside the row's last cell, so the table keeps its columns and no
 * other line is rewritten. The newest row for the thread is the one marked: a
 * requirement can be archived, restored and archived again, and only the row of the
 * last archive describes the archive this restore reverses. A row that cannot be
 * found is left alone: the move already happened and the state already records it.
 */
function markIndexRestored(index: string, thread: string, restoredAt: string): void {
  let body = ''
  try {
    body = readFileSync(index, 'utf8')
  } catch {
    return
  }
  const lines = body.split('\n')
  // The thread column is read from the header, because an index a person wrote may
  // order its columns differently. A table without that header keeps the column this
  // module writes.
  const named = (values: string[]) => values.findIndex((value) => value.trim() === '线程名')
  const header = lines.find((line) => named(line.split(TABLE_CELL)) >= 0)
  const column = header === undefined ? 2 : named(header.split(TABLE_CELL))
  for (let position = lines.length - 1; position >= 0; position -= 1) {
    if (lines[position] === header) continue
    const cells = lines[position].split(TABLE_CELL)
    // The last cell is the empty tail the closing pipe leaves; the note goes in the
    // cell before it, which is the row's last column.
    if (cells.length < 4) continue
    if ((cells[column] ?? '').trim() !== thread) continue
    const last = cells.length - 2
    cells[last] = `${cells[last].replace(/\s+$/, '')}（已恢复 ${restoredAt}） `
    lines[position] = cells.join('|')
    writeFileSync(index, lines.join('\n'), 'utf8')
    return
  }
}
