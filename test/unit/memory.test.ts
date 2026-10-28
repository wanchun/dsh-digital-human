import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  COMPACTION_THRESHOLD_BYTES,
  HISTORY_KEEP_ENTRIES,
  NOW_BUDGET_BYTES,
  archiveHistory,
  archiveHistoryOnTurnEnd,
  buildSnapshot,
  compactMemory,
  ensureMemory,
  memoryPaths,
  readMemory,
  renderMemoryContext,
  renderSnapshot,
} from '../../src/lib/memory'

let home = ''
/** The one store method the memory module reads. */
const store = { dir: (id: string) => join(home, 'humans', id) }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dh-memory-'))
  mkdirSync(store.dir('pm'), { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const paths = () => memoryPaths(store, 'pm')
const write = (text: string) => writeFileSync(paths().file, text, 'utf8')

describe('memoryPaths', () => {
  it('names the file, the archive directory and the run directory', () => {
    const p = paths()
    expect(p.file).toBe(join(home, 'humans', 'pm', 'memory.md'))
    expect(p.archiveDir).toBe(join(home, 'humans', 'pm', 'memory'))
    expect(p.runDir).toBe(join(home, 'humans', 'pm', 'memory', 'run'))
  })
})

describe('readMemory', () => {
  it('is null when the file does not exist', () => {
    expect(readMemory(paths().file)).toBeNull()
  })

  it('returns the text when it does', () => {
    write('# now\n')
    expect(readMemory(paths().file)).toBe('# now\n')
  })

  it('is null when the path is a directory', () => {
    mkdirSync(paths().file, { recursive: true })
    expect(readMemory(paths().file)).toBeNull()
  })
})

describe('ensureMemory', () => {
  it('creates the file and its directory on first use, and reports it', () => {
    expect(ensureMemory(paths().file)).toBe(true)
    const text = readFileSync(paths().file, 'utf8')
    expect(text).toContain('# now')
    expect(text).toContain('# History')
  })

  it('reports false when the file is already there', () => {
    write('MINE\n')
    expect(ensureMemory(paths().file)).toBe(false)
    expect(readMemory(paths().file)).toBe('MINE\n')
  })
})

describe('buildSnapshot', () => {
  it('reports an absent memory without creating anything', () => {
    const snapshot = buildSnapshot(paths())
    expect(snapshot.exists).toBe(false)
    expect(snapshot.totalLines).toBe(0)
    expect(snapshot.sizeBytes).toBe(0)
    expect(snapshot.nowSection).toBeNull()
    expect(snapshot.headers).toEqual([])
    // A pure read: the status tool must not bring a memory into being.
    expect(existsSync(paths().file)).toBe(false)
  })

  it('reports the size, the headings and the sections', () => {
    write('# now\n## State | busy\n\n# History\n## 2026-01-01 | old\n')
    const snapshot = buildSnapshot(paths())
    expect(snapshot.exists).toBe(true)
    // The trailing newline makes an empty final element.
    expect(snapshot.totalLines).toBe(6)
    expect(snapshot.sizeBytes).toBeGreaterThan(0)
    expect(snapshot.headers.map((entry) => entry.heading)).toContain('State | busy')
    expect(snapshot.nowSection).toContain('## State | busy')
    expect(snapshot.historyLines).toBe(1)
    expect(snapshot.lastModified).toBeTypeOf('string')
  })

  it('injects a small file whole and withholds a large one', () => {
    write('# now\n')
    expect(buildSnapshot(paths()).fullContent).toBe('# now\n')
    write(Array.from({ length: 40 }, (_v, at) => `line ${at}`).join('\n'))
    expect(buildSnapshot(paths()).fullContent).toBeNull()
  })

  it('asks for compaction once the file passes the threshold', () => {
    write('x'.repeat(COMPACTION_THRESHOLD_BYTES + 1))
    expect(buildSnapshot(paths()).needsCompaction).toBe(true)
    write('x'.repeat(10))
    expect(buildSnapshot(paths()).needsCompaction).toBe(false)
  })

  it('lists the archives compaction writes', () => {
    write('# now\n')
    mkdirSync(paths().archiveDir, { recursive: true })
    writeFileSync(join(paths().archiveDir, '2026-10-28-11-00.md'), 'r')
    expect(buildSnapshot(paths()).archiveFiles).toHaveLength(1)
  })

  it('lists the archive a compaction just wrote', () => {
    write('# now\n## State | x\n')
    compactMemory(paths())
    expect(buildSnapshot(paths()).archiveFiles).toHaveLength(1)
  })

  it('reports no history section as zero lines', () => {
    write('# now\n## State | x\n')
    expect(buildSnapshot(paths()).historyLines).toBe(0)
  })
})

describe('renderSnapshot', () => {
  it('says when there is no memory yet', () => {
    const text = renderSnapshot(buildSnapshot(paths()))
    expect(text).toContain('no file yet')
    expect(text).toContain(paths().file)
  })

  it('reports size, headings and the compaction verdict', () => {
    write('# now\n## State | x\n')
    const text = renderSnapshot(buildSnapshot(paths()))
    expect(text).toMatch(/size: \d+ lines, \d+ bytes/)
    expect(text).toContain('State | x')
    expect(text).toContain('not needed')
  })

  it('says compaction is needed when it is', () => {
    write('x'.repeat(COMPACTION_THRESHOLD_BYTES + 1))
    expect(renderSnapshot(buildSnapshot(paths()))).toContain('needed')
  })

  it('lists the recent archives when there are any', () => {
    write('# now\n')
    mkdirSync(paths().archiveDir, { recursive: true })
    writeFileSync(join(paths().archiveDir, '2026-10-28-11-00.md'), 'r')
    expect(renderSnapshot(buildSnapshot(paths()))).toContain('recent archives')
  })
})

describe('compactMemory', () => {
  it('is null when there is nothing to archive', () => {
    expect(compactMemory(paths())).toBeNull()
  })

  it('archives the file and starts a fresh one', () => {
    write('# now\n## State | x\n')
    const archived = compactMemory(paths())
    expect(archived).toBeTypeOf('string')
    expect(readFileSync(archived as string, 'utf8')).toContain('## State | x')
    expect(readFileSync(paths().file, 'utf8')).toContain('# now')
    expect(buildSnapshot(paths()).exists).toBe(true)
  })

  it('keeps a second archive in the same minute apart from the first', () => {
    write('one')
    const first = compactMemory(paths())
    write('two')
    const second = compactMemory(paths())
    expect(second).not.toBe(first)
    expect(readFileSync(second as string, 'utf8')).toBe('two')
  })
})

describe('renderMemoryContext', () => {
  it('carries the instructions, the map and the current block', () => {
    write('# now\n## State | busy\n\n# History\n## 2026-01-01 | old\n')
    const context = renderMemoryContext(paths())
    expect(context).toContain('memory_status')
    expect(context).toContain('memory_compact')
    expect(context).toContain(paths().file)
    expect(context).toContain('## State | busy')
  })

  it('teaches the real tool names, which are lowercase', () => {
    ensureMemory(paths().file)
    const context = renderMemoryContext(paths())
    expect(context).toContain('Use edit for routine updates')
    // Naming `Edit` would send the model after a tool that does not exist.
    expect(context).not.toMatch(/\b(Edit|Write)\(/)
  })

  it('does not create a file, because a prompt provider must not have side effects', () => {
    const context = renderMemoryContext(paths())
    expect(context).toContain('no memory file yet')
    expect(context).toContain('# now')
    expect(existsSync(paths().file)).toBe(false)
  })

  it('shows the whole file when it is small, and only `# now` when it is not', () => {
    write('# now\n## State | busy\n')
    expect(renderMemoryContext(paths())).toContain('shown in full')
    // One top-level section, long enough that the whole file is withheld.
    write(`# now\n${Array.from({ length: 40 }, (_v, at) => `## item ${at}`).join('\n')}`)
    const context = renderMemoryContext(paths())
    expect(context).not.toContain('shown in full')
    expect(context).toContain('## item 0')
  })
})

/** Pad a `##` section to roughly this many bytes, one line at a time. */
function paddedSection(heading: string, bytes: number): string[] {
  const lines = [heading]
  let size = 0
  let index = 0
  while (size < bytes) {
    const line = `- ${heading.slice(3, 7)}-${index}: ${'x'.repeat(80)}`
    lines.push(line)
    size += line.length + 1
    index += 1
  }
  return lines
}

/** The pre-loaded memory block, which is the only ```markdown fence in the context. */
function fencedBlock(context: string): string {
  const match = /```markdown\n([\s\S]*?)\n```/.exec(context)
  if (!match) throw new Error('the context carries no pre-loaded memory block')
  return match[1]
}

describe('the `# now` injection budget', () => {
  it('keeps the head and the tail of one overlong section, and says what it dropped', () => {
    const head = ['## State | big', '- runs_completed: 7', '- current_task: ship it']
    const middle = Array.from({ length: 400 }, (_v, at) => `- old-${at}: ${'m'.repeat(200)}`)
    const tail = ['- newest_task: REQ-9', '- newest_state: waiting']
    write(`# now\n${[...head, ...middle, ...tail].join('\n')}\n`)
    const block = fencedBlock(renderMemoryContext(paths()))
    // The State counters are the head every later read depends on.
    expect(block).toContain('- runs_completed: 7')
    // The tail is the newest working memory, which 06 anchors the current task on.
    expect(block).toContain('- newest_task: REQ-9')
    expect(block).not.toContain('- old-200:')
    // The cut is named, not silent: the reported count is exactly what the block lost.
    const lost = middle.filter((line) => !block.includes(line)).length
    const reported = /(\d+) lines \(\d+ bytes\) omitted/.exec(block)
    expect(reported?.[1]).toBe(String(lost))
    expect(lost).toBeGreaterThan(0)
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(NOW_BUDGET_BYTES)
  })

  it('keeps the leading `##` sections that fit and reports the sections it dropped', () => {
    write([
      '# now',
      ...paddedSection('## State | big', 6000),
      ...paddedSection('## Patterns', 6000),
      ...paddedSection('## Errors', 6000),
    ].join('\n'))
    const block = fencedBlock(renderMemoryContext(paths()))
    expect(block).toContain('## State | big')
    expect(block).toContain('## Patterns')
    expect(block).not.toContain('## Errors')
    expect(block).toMatch(/1 section/)
    expect(block).toMatch(/omitted/)
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(NOW_BUDGET_BYTES)
  })

  it('budgets a `# now` block that carries no `##` headings', () => {
    const lines = Array.from({ length: 400 }, (_v, at) => `- unheaded-${at}: ${'u'.repeat(200)}`)
    write(`# now\n${lines.join('\n')}`)
    const block = fencedBlock(renderMemoryContext(paths()))
    expect(block.startsWith('# now')).toBe(true)
    expect(block).toMatch(/omitted/)
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(NOW_BUDGET_BYTES)
    // An unheaded block is one section: head and tail survive it too.
    expect(block).toContain('- unheaded-0:')
    expect(block).toContain('- unheaded-399:')
  })

  it('injects the latest eight history titles without their bodies', () => {
    const entries = Array.from({ length: 10 }, (_v, at) =>
      `## 2026-10-${String(at + 1).padStart(2, '0')}-1200 | entry ${at}\nbody-${at} must stay out`)
    write([
      '# now',
      '## State | x',
      ...paddedSection('## Patterns', 2000),
      '',
      '# History',
      '',
      ...entries,
    ].join('\n'))
    const context = renderMemoryContext(paths())
    // Titles only, one per line, and only the newest eight of the ten.
    for (let at = 0; at < 8; at += 1) {
      expect(context).toContain(`\n- 2026-10-${String(at + 1).padStart(2, '0')}-1200 | entry ${at}`)
    }
    expect(context).not.toContain('\n- 2026-10-09-1200 | entry 8')
    expect(context).not.toContain('body-0 must stay out')
  })

  it('asks for compaction when `# now` alone passes the injection budget', () => {
    write(`# now\n${paddedSection('## State | big', NOW_BUDGET_BYTES + 1000).join('\n')}`)
    const snapshot = buildSnapshot(paths())
    // The whole file stays under the archive threshold; the working block alone is what overflows.
    expect(snapshot.sizeBytes).toBeLessThan(COMPACTION_THRESHOLD_BYTES)
    expect(snapshot.nowBytes).toBeGreaterThan(NOW_BUDGET_BYTES)
    expect(snapshot.needsCompaction).toBe(true)
  })

  it('reports the bytes of every `# now` section and marks the ones over budget', () => {
    write([
      '# now',
      ...paddedSection('## State | x', 200),
      ...paddedSection('## Patterns', NOW_BUDGET_BYTES + 1000),
    ].join('\n'))
    const text = renderSnapshot(buildSnapshot(paths()))
    expect(text).toMatch(/## State \| x: \d+ bytes/)
    expect(text).toMatch(/## Patterns: \d+ bytes \(over budget\)/)
    expect(text).toMatch(/split it into \d+ sections/)
  })
})

describe('archiveHistory', () => {
  /** A memory file whose History holds this many newest-first entries. */
  const historyFile = (count: number, { now = '## State | x\n- runs: 1' } = {}) => {
    const lines = ['# now', now, '', '# History', '']
    for (let at = 0; at < count; at += 1) lines.push(`## 2026-10-01-1200 | entry ${at}`, `body ${at}`, '')
    return lines.join('\n')
  }

  it('moves the oldest entries into a dated archive and keeps the newest', () => {
    const before = historyFile(5)
    write(before)
    const result = archiveHistory(paths(), { keep: 2 })
    expect(result?.moved).toBe(3)
    const archive = readFileSync(result!.archive, 'utf8')
    // The timeline is newest first, so the archive gets the tail of the file.
    expect(archive).toContain('entry 4')
    expect(archive).toContain('body 4')
    expect(archive).not.toContain('entry 1')
    expect(result!.archive.startsWith(paths().archiveDir)).toBe(true)
    const kept = readFileSync(paths().file, 'utf8')
    expect(kept).toContain('entry 0')
    expect(kept).toContain('entry 1')
    expect(kept).not.toContain('entry 2')
    // `# now` is not touched: the host only reclaims the timeline.
    expect(kept.slice(0, kept.indexOf('# History')))
      .toBe(before.slice(0, before.indexOf('# History')))
  })

  it('is null when there is nothing to move', () => {
    write(historyFile(2))
    expect(archiveHistory(paths(), { keep: 2 })).toBeNull()
    write('# now\n## State | x\n')
    expect(archiveHistory(paths())).toBeNull()
  })

  it('archives the whole timeline on request while `# now` stays', () => {
    write(historyFile(3))
    const result = archiveHistory(paths(), { keep: 0 })
    expect(result?.moved).toBe(3)
    const kept = readFileSync(paths().file, 'utf8')
    expect(kept).toContain('## State | x')
    expect(kept).not.toContain('entry 0')
  })
})

describe('archiveHistoryOnTurnEnd', () => {
  const historyFile = (count: number, now = '## State | x\n- runs: 1') => {
    const lines = ['# now', now, '', '# History', '']
    for (let at = 0; at < count; at += 1) lines.push(`## 2026-10-01-1200 | entry ${at}`, '')
    return lines.join('\n')
  }

  it('reclaims the oldest history only once the file passes the size threshold', () => {
    write(historyFile(61))
    expect(buildSnapshot(paths()).sizeBytes).toBeLessThan(COMPACTION_THRESHOLD_BYTES)
    // Under the threshold the timeline is left alone, however many entries it has.
    expect(archiveHistoryOnTurnEnd(paths())).toBeNull()
    write(historyFile(61, `## State | big\n${'- x\n'.repeat(40000)}`))
    expect(buildSnapshot(paths()).sizeBytes).toBeGreaterThan(COMPACTION_THRESHOLD_BYTES)
    const result = archiveHistoryOnTurnEnd(paths())
    expect(result?.moved).toBe(1)
    expect(buildSnapshot(paths()).historyEntries).toBe(HISTORY_KEEP_ENTRIES)
    // The oversized working block survives; only the timeline shrank.
    expect(readFileSync(paths().file, 'utf8')).toContain('## State | big')
  })

  it('does nothing when the file is over budget but the timeline is already short', () => {
    write(historyFile(3, `## State | big\n${'- x\n'.repeat(40000)}`))
    expect(archiveHistoryOnTurnEnd(paths())).toBeNull()
  })
})
