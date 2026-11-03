import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  archiveRequirement,
  attachFile,
  findArchivedRequirementDir,
  findRequirementDir,
  readArchivedRequirementDirs,
  readRequirementDirs,
  readState,
  renderDigest,
  restoreRequirement,
  statePath,
  writeState,
} from '../../src/lib/requirements'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dh-reqs-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Write one requirement directory's meta.json (or any text) under `reqs/`. */
async function meta(dir: string, body: string) {
  const at = join(root, 'reqs', dir)
  await mkdir(at, { recursive: true })
  await writeFile(join(at, 'meta.json'), body)
}

describe('requirement directory metadata', () => {
  it('maps a thread to its directory and Chinese name', async () => {
    await meta('组织基线验证-20261102', JSON.stringify({ thread: 'qs-org-baseline-verify-20261102', name: '组织基线验证' }))
    expect(readRequirementDirs(root)).toEqual(new Map([
      ['qs-org-baseline-verify-20261102', { dir: '组织基线验证-20261102', name: '组织基线验证' }],
    ]))
  })

  it('skips a directory without a usable meta.json', async () => {
    await meta('missing', '')
    const at = join(root, 'reqs', 'no-meta')
    await mkdir(at, { recursive: true })
    await meta('half', JSON.stringify({ thread: 't-only' }))
    await meta('blank', JSON.stringify({ thread: '  ', name: '名字' }))
    // A plain file under reqs/ is not a requirement directory.
    await writeFile(join(root, 'reqs', 'stray.md'), 'x')
    expect(readRequirementDirs(root).size).toBe(0)
  })

  it('answers an empty map without a requirement root', () => {
    expect(readRequirementDirs(undefined).size).toBe(0)
    expect(readRequirementDirs(join(root, 'absent')).size).toBe(0)
  })
})
describe('requirement state', () => {
  const fallback = { thread: 'REQ-1', name: '组织基线验证' }
  const dir = () => join(root, 'reqs', '组织基线验证-20260101')

  it('reads a missing state as an empty skeleton', async () => {
    await mkdir(dir(), { recursive: true })
    expect(readState(dir(), fallback)).toEqual({
      ...fallback, phase: 'planning', nodes: {}, next: [], events: [],
    })
  })

  it('reads a broken state file as an empty skeleton', async () => {
    await mkdir(dir(), { recursive: true })
    await writeFile(statePath(dir()), '{not json')
    expect(readState(dir(), fallback).phase).toBe('planning')
  })

  it('writes a state that reads back, stamps updatedAt and keeps the last 20 events', async () => {
    await mkdir(dir(), { recursive: true })
    const events = Array.from({ length: 25 }, (_, index) => `e${index}`)
    const saved = writeState(dir(), {
      ...fallback,
      phase: 'executing',
      nodes: { dev: { status: 'done', evidence: ['nodes/dev.md'] } },
      next: ['self-test'],
      events,
    })
    expect(saved.events).toEqual(events.slice(-20))
    expect(typeof saved.updatedAt).toBe('string')
    const loaded = JSON.parse(readFileSync(statePath(dir()), 'utf8'))
    expect(loaded.events).toHaveLength(20)
    expect(loaded.events[0]).toBe('e5')
    expect(readState(dir(), fallback)).toMatchObject({
      phase: 'executing', nodes: { dev: { status: 'done' } }, next: ['self-test'],
    })
  })

  it('renders a bounded digest of nodes, next steps and recent events', async () => {
    const digest = renderDigest({
      ...fallback,
      phase: 'executing',
      nodes: {
        dev: { status: 'done', note: 'merged', evidence: ['a.md', 'b.md', 'c.md', 'd.md'] },
        deploy: { status: 'running' },
      },
      next: ['self-test', 'report'],
      events: ['old', 'older', 'e1', 'e2', 'e3'],
    })
    expect(digest).toContain('线程名：REQ-1')
    expect(digest).toContain('- dev：done（merged） 证据 a.md b.md c.md')
    expect(digest).not.toContain('d.md')
    expect(digest).toContain('- deploy：running')
    expect(digest).toContain('- self-test')
    expect(digest).toContain('- e3')
    // Only the last three events are shown, so the digest stays small.
    expect(digest).not.toContain('old')
  })

  it('attaches a file under the folder its kind names, and returns an absolute path', async () => {
    await mkdir(dir(), { recursive: true })
    const report = attachFile(dir(), { name: 'report.md', content: '# ok', kind: 'self-test' })
    expect(report).toBe(join(dir(), 'self-test', 'report.md'))
    expect(readFileSync(report, 'utf8')).toBe('# ok')
    const node = attachFile(dir(), { name: 'dev/one.md', content: 'x' })
    expect(node).toBe(join(dir(), 'nodes', 'dev-one.md'))
    const other = attachFile(dir(), { name: 'brief.md', content: 'x', kind: 'files' })
    expect(other).toBe(join(dir(), 'files', 'brief.md'))
  })

  it('resolves a requirement by thread name or directory name, and nothing else', async () => {
    await mkdir(dir(), { recursive: true })
    await writeFile(join(dir(), 'meta.json'), JSON.stringify({ thread: 'REQ-1', name: '组织基线验证' }))
    expect(findRequirementDir(root, 'REQ-1')).toBe(dir())
    expect(findRequirementDir(root, '组织基线验证-20260101')).toBe(dir())
    expect(findRequirementDir(root, 'ghost')).toBeUndefined()
    expect(findRequirementDir(join(root, 'absent'), 'REQ-1')).toBeUndefined()
  })

  it('moves a requirement to the archive and back, restoring its phase and marking the row', async () => {
    await mkdir(dir(), { recursive: true })
    await writeFile(join(dir(), 'meta.json'), JSON.stringify({ thread: 'REQ-1', name: '组织基线验证' }))
    writeState(dir(), { ...fallback, phase: 'executing', nodes: {}, next: [], events: [] })
    const archived = archiveRequirement(root, dir(), fallback)
    // The archived map names the thread, so the tree can tell archived from unknown.
    expect(readArchivedRequirementDirs(root).get('REQ-1'))
      .toEqual({ dir: '组织基线验证-20260101', name: '组织基线验证' })
    expect(findArchivedRequirementDir(root, 'REQ-1')).toBe(join(root, '_archive', archived.dir))
    expect(findRequirementDir(root, 'REQ-1')).toBeUndefined()
    expect(readState(join(root, '_archive', archived.dir), fallback).phase).toBe('archived')

    const restored = restoreRequirement(root, join(root, '_archive', archived.dir), fallback)
    expect(restored.dir).toBe(archived.dir)
    expect(typeof restored.restoredAt).toBe('string')
    expect(findRequirementDir(root, 'REQ-1')).toBe(dir())
    expect(readArchivedRequirementDirs(root).size).toBe(0)
    const state = readState(dir(), fallback)
    expect(state.phase).toBe('executing')
    expect(state.events.at(-1)).toContain('restored to')
    // One row, annotated in place: the header is not written again.
    const index = readFileSync(join(root, '_archive', 'index.md'), 'utf8')
    expect(index.split('\n').filter((line) => line.startsWith('| 需求名'))).toHaveLength(1)
    expect(index).toContain('已恢复')
    expect(index).toContain(restored.restoredAt)
  })

  it('refuses a restore onto a directory that already exists', async () => {
    await mkdir(dir(), { recursive: true })
    await writeFile(join(dir(), 'meta.json'), JSON.stringify({ thread: 'REQ-1', name: '组织基线验证' }))
    const archived = archiveRequirement(root, dir(), fallback)
    await mkdir(dir(), { recursive: true })
    await writeFile(join(dir(), 'live.md'), 'new')
    expect(() => restoreRequirement(root, join(root, '_archive', archived.dir), fallback))
      .toThrow(/restore target already exists/)
    expect(readFileSync(join(dir(), 'live.md'), 'utf8')).toBe('new')
  })
})
