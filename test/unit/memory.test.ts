import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  COMPACTION_THRESHOLD_BYTES,
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
