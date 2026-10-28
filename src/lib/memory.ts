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
 *
 * Where Halo injects the snapshot into a trigger message, this module renders it
 * for a scoped `systemPrompt.context` entry, which re-reads on every assembly.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Archive a memory file once it grows past this many bytes. */
export const COMPACTION_THRESHOLD_BYTES = 100 * 1024

/** Files with at most this many lines are small enough to inject whole. */
const SMALL_MEMORY_LINE_THRESHOLD = 30

/** Archive files listed in one snapshot. */
const MAX_ARCHIVE_FILES = 5

/** The working-memory section, pre-loaded into every prompt assembly. */
const NOW_HEADING = '# now'

/** The timeline section, appended to by the model. */
const HISTORY_HEADING = '# History'

/** Where memory lives for one digital human. */
export function memoryPaths(store, humanId) {
  const base = store.dir(humanId)
  return {
    file: join(base, 'memory.md'),
    archiveDir: join(base, 'memory'),
    runDir: join(base, 'memory', 'run'),
  }
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
    headers: [],
    fullContent: null,
    // What `compactMemory` writes. `runDir` is never written by this plugin, so
    // listing it reported no archives right after a compaction.
    archiveFiles: archiveFiles(paths.archiveDir),
    lastModified: null,
    needsCompaction: false,
  }
  if (content === null) return snapshot
  const lines = content.split('\n')
  snapshot.totalLines = lines.length
  try {
    const stats = statSync(paths.file)
    snapshot.sizeBytes = stats.size
    snapshot.lastModified = stats.mtime.toISOString()
    snapshot.needsCompaction = stats.size > COMPACTION_THRESHOLD_BYTES
  } catch {
    // The file may have been removed between the read and the stat; the content stands.
  }
  snapshot.headers = headings(content)
  const sections = topLevelSections(content)
  const now = sections.find((section) => section.heading.toLowerCase() === NOW_HEADING)
  const history = sections.find((section) => section.heading.toLowerCase() === HISTORY_HEADING.toLowerCase())
  snapshot.nowSection = now ? `${now.heading}\n${now.lines.join('\n')}`.trimEnd() : null
  snapshot.fullContent = snapshot.totalLines <= SMALL_MEMORY_LINE_THRESHOLD ? content : null
  snapshot.historyLines = history ? history.lines.filter((line) => line.trim()).length : 0
  return snapshot
}

/**
 * Archive the current memory file and start a fresh one.
 * @returns the archive path, or null when there was nothing to archive.
 */
export function compactMemory(paths) {
  if (!existsSync(paths.file)) return null
  mkdirSync(paths.archiveDir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '-')
  let target = join(paths.archiveDir, `${stamp}.md`)
  let suffix = 1
  while (existsSync(target)) {
    target = join(paths.archiveDir, `${stamp}-${suffix}.md`)
    suffix += 1
  }
  renameSync(paths.file, target)
  writeFileSync(paths.file, skeleton(stamp), 'utf8')
  return target
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
  const lines = [
    `- file: ${snapshot.file}`,
    `- size: ${snapshot.totalLines} lines, ${snapshot.sizeBytes} bytes, last modified ${snapshot.lastModified ?? 'unknown'}`,
    `- compaction: ${snapshot.needsCompaction ? `needed (over ${COMPACTION_THRESHOLD_BYTES} bytes)` : 'not needed'}`,
  ]
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

You have a persistent \`memory.md\` file that carries state across sessions.
It has two top-level sections: \`# now\` (working memory) and \`# History\` (timeline).
Your \`# now\` block is pre-loaded below on every step, so you never need to read it first.

### Structure

\`\`\`
# now                          <- working memory (pre-loaded)
## State | one-line summary    <- always first, updated every run
## [Entity Name]               <- per-entity tracking (optional)
## Patterns                    <- learned rules (accumulates)
## Errors                      <- failure lessons (compact)

# History                      <- timeline (newest first)
## YYYY-MM-DD-HHmm | summary   <- one entry per run
### details heading            <- optional, for important events
\`\`\`

**\`# now\`** holds your current state. Use \`- key: value\` format, one field per line.
Each field is one fact. Each line is independently editable.

- **\`## State | description\`** — counters, current status, last result. The \`| description\`
  is your one-line summary of the current situation.
- **\`## [Entity Name]\`** — per-entity tracking when you monitor several items.
- **\`## Patterns\`** — learned rules that improve future runs.
- **\`## Errors\`** — what went wrong and the fix that worked.

**\`# History\`** is your timeline, newest first.

- Add one \`## YYYY-MM-DD-HHmm | summary\` entry per run, above the previous entries.
- Important events get a \`###\` sub-heading with details. Routine runs need one line.

### When to Update

Update memory **after finishing the work, before reporting**. This is required.

Workflow: receive task -> do work -> compare results with memory -> update memory -> report.

- **Every run**: update the State fields that changed and the \`| description\`.
- **When you learn something new**: add a line to Patterns or Errors.
- **When tracking a new entity**: add a \`##\` section under \`# now\`.
- **When a field is obsolete**: remove it.

Record what helps future runs. Important discoveries, pattern changes, and error
resolutions deserve detail. An unchanged routine check can be a single line.

### How to Update

Use edit for routine updates, so the rest of the file is untouched:

\`\`\`
edit(memory.md, "- current_price: 1199", "- current_price: 1099")
edit(memory.md, "## State | old description", "## State | new description")
\`\`\`

Use write only for the first creation or a full restructure.

### Archives

Access by priority: \`memory.md\` -> \`memory/\` -> \`memory/run/\` — coarse to fine.

- **\`memory.md\`** — always start here.
- **\`memory/\`** — compaction archives: past snapshots of your working memory.
- **\`memory/run/\`** — raw run logs. You rarely need them; filter with grep, never read whole.

### Growth and Consolidation

Keep \`# now\` compact. Consolidate a section once it passes about 20 lines: merge
related Patterns into general rules, delete Patterns that proved wrong, and drop
obsolete fields. When \`memory_status\` reports that compaction is needed, call
\`memory_compact\` to archive the file, then rewrite \`# now\` from the archive.
`.trim()

/**
 * Render the scoped prompt context for one digital human: the instructions, the
 * pre-loaded `# now` block, and the memory map.
 */
export function renderMemoryContext(paths) {
  const snapshot = buildSnapshot(paths)
  const parts = [MEMORY_INSTRUCTIONS, '', '### Memory map', '', renderSnapshot(snapshot), '', '### Pre-loaded `# now`', '']
  if (!snapshot.exists) {
    parts.push('(no memory file yet — create it with your first entry)')
  } else if (snapshot.fullContent !== null) {
    parts.push('Your memory file is small, so it is shown in full:', '', '```markdown', snapshot.fullContent.trimEnd(), '```')
  } else if (snapshot.nowSection) {
    parts.push('```markdown', snapshot.nowSection, '```')
  } else {
    parts.push('(no `# now` section found — add one)')
  }
  return parts.join('\n')
}

/** One `## heading` block of a memory file. */
export interface MemorySection {
  heading: string
  lines: string[]
}

/** Where one digital human's memory file and its archive live. */
export interface MemoryPaths {
  file: string
  runDir: string
  archiveDir: string
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
  headers: Array<{ line: number; heading: string; level: number; lineCount: number }>
  fullContent: string | null
  archiveFiles: string[]
  lastModified: string | null
  needsCompaction: boolean
  historyLines?: number
}
