/**
 * Durable memory for digital humans — the DSH form of Halo's `platform/memory`
 * app scope (`{spacePath}/.halo/apps/{appId}/memory.md`).
 *
 * The design is Halo's, kept because it works:
 *
 * - One `memory.md` per digital human, with two top-level sections: `# now`
 *   (working memory) and `# History` (a newest-first timeline, one entry per run).
 * - `# now` is pre-loaded into every prompt assembly, so the model starts each run
 *   already knowing its state and needs no read call.
 * - The model edits memory with the ordinary file tools. Only structural metadata
 *   is a tool (`memory_status`), exactly as in Halo.
 * - Above the size threshold the file is archived to `memory/<timestamp>.md` and
 *   restarted, so working memory never grows without bound.
 * - The injected `# now` block is budgeted, and an oversized timeline is reclaimed
 *   automatically. The two have different owners on purpose: the timeline is
 *   mechanical and lossless to move, while working memory is the model's to drop.
 *
 * Where Halo injects the snapshot into a trigger message, this module renders it
 * for a scoped `systemPrompt.context` entry, which re-reads on every assembly.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { conversationSlug } from './slug.js'

/** Archive a memory file once it grows past this many bytes. */
export const COMPACTION_THRESHOLD_BYTES = 100 * 1024

/** How much of `# now` one prompt assembly may inject. */
export const NOW_BUDGET_BYTES = 16 * 1024

/** How much of the shared conversation's `# now` one prompt assembly may inject. */
export const SHARED_BUDGET_BYTES = 4 * 1024

/** How many of the newest History entries stay in memory.md when the rest is archived. */
export const HISTORY_KEEP_ENTRIES = 60

/** How many History titles the prompt carries, so the timeline stays visible without its bodies. */
const HISTORY_TITLE_COUNT = 8

/** Room reserved for the note that names what a cut dropped. */
const TRUNCATION_NOTE_RESERVE = 256

/** Files with at most this many lines are small enough to inject whole. */
const SMALL_MEMORY_LINE_THRESHOLD = 30

/** Archive files listed in one snapshot. */
const MAX_ARCHIVE_FILES = 5

/** The working-memory section, pre-loaded into every prompt assembly. */
const NOW_HEADING = '# now'

/** The timeline section, appended to by the model. */
const HISTORY_HEADING = '# History'

/** How one record scopes its memory, and the conversation a session-scoped read names. */
export interface MemoryPathOptions {
  scope?: 'record' | 'session' | string
  memoryScope?: 'record' | 'session' | string
  conversation?: string
  conversationId?: string
}

/** The conversation a session-scoped path uses when the caller names none. */
const DEFAULT_CONVERSATION_SLUG = 'main'

/**
 * Where memory lives for one digital human.
 *
 * The default stays the single `memory.md` every record already has. A
 * `session` scope keeps the same directory but names one file per conversation
 * and one shared file, so a write to one requirement cannot be read by another.
 *
 * @param store - registry, read for the record's directory.
 * @param humanId - the record whose memory to locate.
 * @param options - `scope` (or its record-level spelling `memoryScope`) and the
 *   conversation. A plain string is accepted as a conversation for callers that
 *   only have that.
 */
export function memoryPaths(store, humanId, options: MemoryPathOptions | string = {}) {
  const opts: MemoryPathOptions = typeof options === 'string' ? { conversation: options, scope: 'session' } : options ?? {}
  const scope = opts.scope ?? opts.memoryScope
  const base = store.dir(humanId)
  if (scope === 'session') {
    const slug = conversationSlug(opts.conversation ?? opts.conversationId) || DEFAULT_CONVERSATION_SLUG
    // `_shared.md` is a reserved file beside the per-conversation ones; a
    // conversation with that name would overwrite the cross-requirement notes.
    if (slug === '_shared') throw new Error('conversation "_shared" is reserved for shared memory')
    const root = join(base, 'memory')
    return {
      scope: 'session' as const,
      file: join(root, `${slug}.md`),
      sharedFile: join(root, '_shared.md'),
      archiveDir: join(root, slug),
      runDir: join(root, slug, 'run'),
    }
  }
  return {
    scope: 'record' as const,
    file: join(base, 'memory.md'),
    archiveDir: join(base, 'memory'),
    runDir: join(base, 'memory', 'run'),
  }
}

/** UTF-8 size of one string. Budgets are bytes because one Chinese character is three. */
function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** The timestamp a memory operation names itself with, at minute resolution. */
function stampNow(): string {
  return new Date().toISOString().slice(0, 16).replace('T', '-')
}

/** A fresh memory skeleton, used on first touch and after compaction. */
function skeleton(now) {
  return [
    NOW_HEADING,
    '',
    `## State | created ${now}`,
    '- runs_completed: 0',
    '',
    '## Patterns',
    '',
    '## Errors',
    '',
    HISTORY_HEADING,
    '',
  ].join('\n')
}

/** Read the memory file, or null when it does not exist yet. */
export function readMemory(file) {
  if (!existsSync(file)) return null
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Create the memory skeleton when the file is absent. */
export function ensureMemory(file) {
  if (existsSync(file)) return false
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, skeleton(new Date().toISOString().slice(0, 16).replace('T', '-')), 'utf8')
  return true
}

/**
 * Split the file into its top-level sections.
 * @returns one entry per `# ` heading, in file order.
 */
function topLevelSections(content) {
  const sections: MemorySection[] = []
  let current: MemorySection | null = null
  for (const line of content.split('\n')) {
    if (line.startsWith('# ')) {
      if (current) sections.push(current)
      current = { heading: line.trim(), lines: [] }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) sections.push(current)
  return sections
}

/** Collect every heading with its depth and body size. */
function headings(content) {
  const lines: string[] = content.split('\n')
  const found: Array<{ line: number; heading: string; level: number; lineCount: number }> = []
  for (const [index, line] of lines.entries()) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (!match) continue
    const level = match[1].length
    let lineCount = 0
    for (let at = index + 1; at < lines.length; at += 1) {
      const next = /^(#{1,6})\s+/.exec(lines[at])
      if (next && next[1].length <= level) break
      lineCount += 1
    }
    found.push({ line: index + 1, heading: match[2].trim(), level, lineCount })
  }
  return found
}

/** The `## title` blocks of one section, in file order, with the title text alone. */
function subsectionSizes(lines: string[]): Array<{ heading: string; bytes: number }> {
  const groups: Array<{ heading: string; lines: string[] }> = []
  for (const line of lines) {
    const match = /^##\s+(.*)$/.exec(line)
    if (match) groups.push({ heading: match[1].trim(), lines: [line] })
    else if (groups.length > 0) groups[groups.length - 1].lines.push(line)
  }
  return groups.map((group) => ({ heading: group.heading, bytes: bytesOf(group.lines.join('\n')) }))
}

/** The `## title` lines of the timeline, newest first, as the file orders them. */
function historyEntriesOf(lines: string[]): string[] {
  return lines
    .filter((line) => /^##\s+/.test(line))
    .map((line) => line.replace(/^##\s+/, '').trim())
}

/** Name what a cut dropped. A silent cut would read as if the model saw everything. */
function omittedNote(lines: string[], where: string, source = 'memory.md'): string {
  const bytes = lines.reduce((total, line) => total + bytesOf(line) + 1, 0)
  return `[… ${lines.length} lines (${bytes} bytes) omitted ${where}; read ${source} for the rest …]`
}

/** Name the whole sections a cut left out, so the count is visible next to their size. */
function droppedSectionsNote(groups: string[][], source = 'memory.md'): string {
  const lines = groups.flat()
  const bytes = lines.reduce((total, line) => total + bytesOf(line) + 1, 0)
  const sections = `${groups.length} section${groups.length === 1 ? '' : 's'}`
  return `[… ${sections}, ${lines.length} lines (${bytes} bytes) of \`# now\` omitted; read ${source} for the rest …]`
}

/**
 * Cut one overlong `##` section down to its head and its tail.
 *
 * The head keeps the section heading and the State counters; the tail keeps the
 * newest lines, because 06 anchors the current task at the end of `# now`. Only
 * the middle is dropped, and the note says how much.
 */
function truncateSection(lines: string[], budget: number, source = 'memory.md'): string {
  const heading = lines[0]
  const body = lines.slice(1)
  const room = Math.max(budget - TRUNCATION_NOTE_RESERVE, 0)
  const headBudget = Math.floor(room / 2)
  let headBytes = bytesOf(heading) + 1
  let headCount = 0
  while (headCount < body.length && headBytes + bytesOf(body[headCount]) + 1 <= headBudget) {
    headBytes += bytesOf(body[headCount]) + 1
    headCount += 1
  }
  const tailRoom = Math.max(room - headBytes, 0)
  let tailBytes = 0
  let tailCount = 0
  while (tailCount < body.length - headCount) {
    const size = bytesOf(body[body.length - 1 - tailCount]) + 1
    if (tailBytes + size > tailRoom) break
    tailBytes += size
    tailCount += 1
  }
  const omitted = body.slice(headCount, body.length - tailCount)
  const kept = [heading, ...body.slice(0, headCount)]
  if (omitted.length > 0) kept.push(omittedNote(omitted, 'in the middle', source))
  kept.push(...body.slice(body.length - tailCount))
  return kept.join('\n')
}

/**
 * Fit `# now` into the injection budget.
 *
 * Multi-section blocks keep their leading `##` sections and their last one whole,
 * and report the middle they had to leave out; the last section is the newest, which
 * 06 anchors the current task on, so it is never dropped just because it came last.
 * A section that alone overflows is cut by line with {@link truncateSection} instead,
 * keeping its head and its newest lines: a version of `# now` that keeps no State is
 * not worth injecting.
 */
function truncateNow(now: string, budget: number, source = 'memory.md'): string {
  if (bytesOf(now) <= budget) return now
  const lines = now.split('\n')
  // The heading and anything before the first `##` are the first group and are
  // always kept; one group follows per `##` section.
  const groups: string[][] = [[lines[0]]]
  for (const line of lines.slice(1)) {
    if (/^##\s+/.test(line)) groups.push([line])
    else groups[groups.length - 1].push(line)
  }
  // Without a `##` the block is one section, and cutting it by line is the only
  // way to keep both its first lines and its newest ones.
  if (groups.length === 1) return truncateSection(groups[0], budget, source)
  // The newest section is the one 06 anchors the current task on, so it is kept
  // whole when it fits and cut to its own head and tail when it does not. Only the
  // sections between it and the heading are candidates for being dropped.
  const head = [groups[0]]
  const used = bytesOf(groups[0].join('\n')) + 1
  const middle = groups.slice(1, -1)
  const tail = groups[groups.length - 1]
  const reserved = middle.length > 0 ? TRUNCATION_NOTE_RESERVE : 0
  const tailRoom = Math.max(budget - used - reserved, 0)
  const tailSize = bytesOf(tail.join('\n')) + 1
  const tailText = tailSize <= tailRoom ? tail.join('\n') : truncateSection(tail, tailRoom, source)
  let left = Math.max(budget - used - (bytesOf(tailText) + 1), 0)
  const keptMiddle: string[][] = []
  for (const [index, group] of middle.entries()) {
    const size = bytesOf(group.join('\n')) + 1
    // Keeping a section that leaves no room for the note would silently drop the
    // rest, so a section that is not the last of the middle needs the note's room too.
    const laterDrop = index < middle.length - 1
    if (size > left || (laterDrop && size + TRUNCATION_NOTE_RESERVE > left)) break
    keptMiddle.push(group)
    left -= size
  }
  const dropped = middle.slice(keptMiddle.length)
  const parts = [...head, ...keptMiddle].map((group) => group.join('\n'))
  if (dropped.length > 0) parts.push(droppedSectionsNote(dropped, source))
  parts.push(tailText)
  return parts.join('\n')
}

/** Where the next archive goes, refusing to overwrite one written in the same minute. */
function nextArchivePath(paths: MemoryPaths, stamp: string): string {
  let target = join(paths.archiveDir, `${stamp}.md`)
  let suffix = 1
  while (existsSync(target)) {
    target = join(paths.archiveDir, `${stamp}-${suffix}.md`)
    suffix += 1
  }
  return target
}

/** List the newest archive files, newest first. */
function archiveFiles(runDir) {
  if (!existsSync(runDir)) return []
  try {
    return readdirSync(runDir).sort().reverse().slice(0, MAX_ARCHIVE_FILES)
  } catch {
    return []
  }
}

/**
 * Build a structural snapshot. Pure read: it never creates or modifies a file.
 * @returns the snapshot, or `{exists: false}` when there is no memory yet.
 */
export function buildSnapshot(paths: MemoryPaths): MemorySnapshot {
  const content = readMemory(paths.file)
  const snapshot: MemorySnapshot = {
    exists: content !== null,
    file: paths.file,
    archiveDir: paths.archiveDir,
    totalLines: 0,
    sizeBytes: 0,
    nowSection: null,
    nowBytes: 0,
    nowSections: [],
    sectionBytes: [],
    headers: [],
    fullContent: null,
    // What `compactMemory` writes. `runDir` is never written by this plugin, so
    // listing it reported no archives right after a compaction.
    archiveFiles: archiveFiles(paths.archiveDir),
    lastModified: null,
    needsCompaction: false,
    historyEntries: 0,
    historyTitles: [],
  }
  if (content === null) return snapshot
  const lines = content.split('\n')
  snapshot.totalLines = lines.length
  try {
    const stats = statSync(paths.file)
    snapshot.sizeBytes = stats.size
    snapshot.lastModified = stats.mtime.toISOString()
  } catch {
    // The file may have been removed between the read and the stat; the content stands.
  }
  snapshot.headers = headings(content)
  const sections = topLevelSections(content)
  const now = sections.find((section) => section.heading.toLowerCase() === NOW_HEADING)
  const history = sections.find((section) => section.heading.toLowerCase() === HISTORY_HEADING.toLowerCase())
  snapshot.nowSection = now ? `${now.heading}\n${now.lines.join('\n')}`.trimEnd() : null
  snapshot.nowBytes = snapshot.nowSection === null ? 0 : bytesOf(snapshot.nowSection)
  // A section is over budget when the bytes before and including it already overflow:
  // those are exactly the sections the injection can no longer show in full.
  let running = bytesOf(NOW_HEADING)
  snapshot.nowSections = now
    ? subsectionSizes(now.lines).map((entry) => {
      running += entry.bytes + 1
      return { ...entry, overBudget: running > NOW_BUDGET_BYTES }
    })
    : []
  snapshot.sectionBytes = sections.map((section) => ({
    heading: section.heading.replace(/^#\s+/, ''),
    bytes: bytesOf(`${section.heading}\n${section.lines.join('\n')}`),
  }))
  snapshot.fullContent = snapshot.totalLines <= SMALL_MEMORY_LINE_THRESHOLD ? content : null
  snapshot.historyLines = history ? history.lines.filter((line) => line.trim()).length : 0
  const titles = history ? historyEntriesOf(history.lines) : []
  snapshot.historyEntries = titles.length
  snapshot.historyTitles = titles.slice(0, HISTORY_TITLE_COUNT)
  // Either budget overflowing is reason enough: the whole file for the archive, the
  // working block alone because it is what every prompt carries.
  snapshot.needsCompaction = snapshot.sizeBytes > COMPACTION_THRESHOLD_BYTES
    || snapshot.nowBytes > NOW_BUDGET_BYTES
  return snapshot
}

/**
 * Archive the current memory file and start a fresh one.
 * @returns the archive path, or null when there was nothing to archive.
 */
export function compactMemory(paths) {
  if (!existsSync(paths.file)) return null
  mkdirSync(paths.archiveDir, { recursive: true })
  const stamp = stampNow()
  const target = nextArchivePath(paths, stamp)
  renameSync(paths.file, target)
  writeFileSync(paths.file, skeleton(stamp), 'utf8')
  return target
}

/** The `# History` section's bounds, with its body between them. */
function locateHistory(content: string): { lines: string[]; start: number; end: number } | null {
  const lines = content.split('\n')
  const start = lines.findIndex((line) => line.trim().toLowerCase() === HISTORY_HEADING.toLowerCase())
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !lines[end].startsWith('# ')) end += 1
  return { lines, start, end }
}

/**
 * Move the oldest timeline entries into a dated archive.
 *
 * The timeline is mechanical and lossless to move, so the host may do it without
 * asking. `# now` is copied back byte for byte: dropping working memory is a
 * decision only the model can make, and an automatic move would be silent loss.
 *
 * @param keep - how many of the newest entries stay in memory.md; 0 moves them all.
 * @returns the archive and the number of entries moved, or null when there was nothing to move.
 */
export function archiveHistory(paths: MemoryPaths, { keep = 0 }: { keep?: number } = {}): { archive: string; moved: number } | null {
  const content = readMemory(paths.file)
  if (content === null) return null
  const located = locateHistory(content)
  if (!located) return null
  const { lines, start, end } = located
  // Split the section body into its preamble and its `##` entries, keeping every
  // line so the archive is a lossless copy rather than a rewrite.
  const preamble: string[] = []
  const entries: string[][] = []
  for (const line of lines.slice(start + 1, end)) {
    if (/^##\s+/.test(line)) entries.push([line])
    else if (entries.length === 0) preamble.push(line)
    else entries[entries.length - 1].push(line)
  }
  const wanted = Math.max(keep, 0)
  if (entries.length <= wanted) return null
  const moved = entries.slice(wanted)
  const stamp = stampNow()
  mkdirSync(paths.archiveDir, { recursive: true })
  const archive = nextArchivePath(paths, stamp)
  writeFileSync(archive, [
    `# History archive | ${stamp}`,
    '',
    `_The ${moved.length} oldest \`# History\` entries of memory.md, archived on ${stamp}. \`# now\` was not touched._`,
    '',
    ...moved.map((entry) => entry.join('\n')),
    '',
  ].join('\n'), 'utf8')
  writeFileSync(paths.file, [
    ...lines.slice(0, start + 1),
    ...preamble,
    ...entries.slice(0, wanted).flat(),
    ...lines.slice(end),
  ].join('\n'), 'utf8')
  return { archive, moved: moved.length }
}

/**
 * Reclaim the timeline when a turn left memory over the file budget.
 *
 * Called from the Host's `turn/end` handler. The trigger is the file size because
 * the timeline is what grows; `# now` is never moved here, only reported.
 */
export function archiveHistoryOnTurnEnd(paths: MemoryPaths): { archive: string; moved: number } | null {
  const content = readMemory(paths.file)
  if (content === null || bytesOf(content) <= COMPACTION_THRESHOLD_BYTES) return null
  return archiveHistory(paths, { keep: HISTORY_KEEP_ENTRIES })
}

/** Render the memory map the model sees when it asks for structural status. */
export function renderSnapshot(snapshot) {
  if (!snapshot.exists) {
    return [
      'Memory: no file yet.',
      `- file: ${snapshot.file} (create it by writing your first entry)`,
      `- archive: ${snapshot.archiveDir}`,
    ].join('\n')
  }
  const over: string[] = []
  if (snapshot.sizeBytes > COMPACTION_THRESHOLD_BYTES) over.push(`file over ${COMPACTION_THRESHOLD_BYTES} bytes`)
  if (snapshot.nowBytes > NOW_BUDGET_BYTES) over.push(`\`# now\` over ${NOW_BUDGET_BYTES} bytes`)
  const lines = [
    `- file: ${snapshot.file}`,
    `- size: ${snapshot.totalLines} lines, ${snapshot.sizeBytes} bytes, last modified ${snapshot.lastModified ?? 'unknown'}`,
    `- compaction: ${over.length > 0 ? `needed (${over.join('; ')})` : 'not needed'}`,
  ]
  if (snapshot.sectionBytes.length > 0) {
    lines.push('- sections:')
    for (const entry of snapshot.sectionBytes) lines.push(`  - ${entry.heading}: ${entry.bytes} bytes`)
  }
  if (snapshot.nowSections.length > 0) {
    lines.push(`- \`# now\` sections (${snapshot.nowBytes} of ${NOW_BUDGET_BYTES} bytes):`)
    for (const entry of snapshot.nowSections) {
      lines.push(`  - ## ${entry.heading}: ${entry.bytes} bytes${entry.overBudget ? ' (over budget)' : ''}`)
    }
    if (snapshot.nowBytes > NOW_BUDGET_BYTES) {
      // One line the model can act on: how many sections the block has to become.
      const wanted = Math.ceil(snapshot.nowBytes / NOW_BUDGET_BYTES)
      lines.push(`  - over the ${NOW_BUDGET_BYTES}-byte injection budget: split it into ${wanted} sections`)
    }
  }
  if (snapshot.archiveFiles.length > 0) lines.push(`- recent archives: ${snapshot.archiveFiles.join(', ')}`)
  if (snapshot.headers.length > 0) {
    lines.push('- headings:')
    for (const entry of snapshot.headers) {
      lines.push(`  - ${'#'.repeat(entry.level)} ${entry.heading} (line ${entry.line}, ${entry.lineCount} body lines)`)
    }
  }
  return lines.join('\n')
}

/**
 * Instructions that teach the model to keep memory useful. Ported from Halo's
 * `MEMORY_INSTRUCTIONS`, with the pre-inserted History heading replaced by an
 * instruction to write the timestamp itself, because Harness supplies current
 * time through its own time context rather than through a rewritten message.
 */
export const MEMORY_INSTRUCTIONS = `
## Memory

You have a persistent \`memory.md\` file. It has two sections: \`# now\` (working memory, pre-loaded below every step) and \`# History\` (timeline, newest first).

Structure of \`# now\`:
- \`## State | one-line summary\` — counters and current status. Always first.
- \`## [Entity]\` — optional, one per tracked item.
- \`## Patterns\` — learned rules.
- \`## Errors\` — failure lessons. Keep compact.

History: one \`## YYYY-MM-DD-HHmm | summary\` entry per run, above older ones. Detail only important events.

Update memory after the work, before you report. Use edit for routine updates, so the rest of the file stays untouched; use write only to create or fully restructure. Record what helps future runs — discoveries, pattern changes, error fixes. Remove obsolete fields.

Archives: \`memory.md\` → \`memory/\` (compaction snapshots) → \`memory/run/\` (raw logs; grep, never read whole). The host archives the oldest History entries past 100 KB; \`# now\` is never moved automatically.

Keep \`# now\` under about 20 lines per section. Consolidate when a section grows: merge related Patterns, delete wrong ones, drop obsolete fields. When \`memory_status\` says compaction is needed, call \`memory_compact\`, then rewrite \`# now\` from the archive.
`.trim()

/**
 * Render the scoped prompt context for one digital human: the instructions, the
 * pre-loaded `# now` block, and the memory map.
 */
export function renderMemoryContext(paths) {
  // A session-scoped file is the one memory artifact this module creates on read.
  // Unlike `memory.md`, nobody asked for it by path, so without this the first
  // prompt of a fresh conversation would show an empty memory and the model would
  // have to invent a file before it could record anything.
  if (paths.scope === 'session' && paths.file) ensureMemory(paths.file)
  const snapshot = buildSnapshot(paths)
  const parts = [MEMORY_INSTRUCTIONS, '', '### Memory map', '', renderSnapshot(snapshot), '', '### Pre-loaded `# now`', '']
  if (!snapshot.exists) {
    parts.push('(no memory file yet — create it with your first entry)')
  } else if (snapshot.fullContent !== null) {
    parts.push('Your memory file is small, so it is shown in full:', '', '```markdown', snapshot.fullContent.trimEnd(), '```')
  } else if (snapshot.nowSection) {
    parts.push('```markdown', truncateNow(snapshot.nowSection, NOW_BUDGET_BYTES), '```')
    // The timeline stays visible as titles only: the bodies are what made the file
    // large, and a title is enough to know whether the rest is worth reading.
    if (snapshot.historyTitles.length > 0) {
      parts.push(
        '',
        `The latest ${snapshot.historyTitles.length} \`# History\` titles (newest first; read memory.md for the bodies):`,
        '',
        ...snapshot.historyTitles.map((title) => `- ${title}`),
      )
    }
  } else {
    parts.push('(no `# now` section found — add one)')
  }
  parts.push(...sharedMemoryBlock(paths))
  return parts.join('\n')
}

/**
 * The evergreen part of the shared memory file, as one prompt block.
 *
 * Only `# now` travels: its Patterns, Errors and team rules are what applies to
 * every conversation, while the shared file's timeline is history nobody needs
 * in a prompt. The smaller budget is stated by the cut note, so the model can
 * tell a complete shared block from a truncated one.
 */
function sharedMemoryBlock(paths) {
  if (!paths.sharedFile) return []
  const content = readMemory(paths.sharedFile)
  if (content === null) return []
  const now = topLevelSections(content).find((section) => section.heading.toLowerCase() === NOW_HEADING)
  if (!now) return []
  const text = `${now.heading}\n${now.lines.join('\n')}`.trimEnd()
  return [
    '',
    '### Shared cross-conversation memory',
    '',
    `Context from \`${paths.sharedFile}\`; it applies to every conversation of this digital human.`,
    '',
    '```markdown',
    truncateNow(text, SHARED_BUDGET_BYTES, paths.sharedFile),
    '```',
  ]
}

/** One `## heading` block of a memory file. */
export interface MemorySection {
  heading: string
  lines: string[]
}

/** Where one digital human's memory file and its archive live. */
export interface MemoryPaths {
  /** `record` for the single legacy file, `session` for one file per conversation. */
  scope?: 'record' | 'session'
  file: string
  runDir: string
  archiveDir: string
  /** The shared cross-conversation file; only a session-scoped path has one. */
  sharedFile?: string
  [key: string]: unknown
}

/** The shape `buildSnapshot` reports. */
export interface MemorySnapshot {
  exists: boolean
  file: string
  archiveDir: string
  totalLines: number
  sizeBytes: number
  nowSection: string | null
  nowBytes: number
  nowSections: Array<{ heading: string; bytes: number; overBudget: boolean }>
  sectionBytes: Array<{ heading: string; bytes: number }>
  headers: Array<{ line: number; heading: string; level: number; lineCount: number }>
  fullContent: string | null
  archiveFiles: string[]
  lastModified: string | null
  needsCompaction: boolean
  historyLines?: number
  historyEntries: number
  historyTitles: string[]
}
