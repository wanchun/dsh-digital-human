import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  archiveRequirement,
  attachFile,
  attachNameProblem,
  createRequirement,
  findArchivedRequirementDir,
  findRequirementDir,
  layoutViolations,
  phaseOf,
  readArchivedRequirementDirs,
  readRequirementDirs,
  readRequirementTrigger,
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
describe('requirement layout', () => {
  it('creates the protocol files and the two landing folders, and nothing else', () => {
    const created = createRequirement(root, { thread: 'REQ-LAYOUT', name: '分层校验' })
    expect(readdirSync(created.path).sort()).toEqual(['files', 'meta.json', 'nodes', 'params.md'].sort())
    // The role folders are written by their owners, not by the scaffold.
    expect(existsSync(join(created.path, 'analysis'))).toBe(false)
    expect(existsSync(join(created.path, 'design'))).toBe(false)
  })

  it('reports a misplaced document at the root and accepts the protocol files', async () => {
    const created = createRequirement(root, { thread: 'REQ-CLEAN', name: '干净目录' })
    expect(layoutViolations(created.path)).toEqual([])
    // A protocol file and a folder are both in place.
    await writeFile(join(created.path, 'state.json'), '{}')
    await mkdir(join(created.path, 'files', 'srs'), { recursive: true })
    expect(layoutViolations(created.path)).toEqual([])
    // Material left in the root is the violation the check exists for.
    await writeFile(join(created.path, 'SRS.md'), 'x')
    await writeFile(join(created.path, '原型.png'), 'x')
    await writeFile(join(created.path, '.DS_Store'), 'x')
    const violations = layoutViolations(created.path)
    expect(violations).toHaveLength(2)
    expect(violations).toEqual(expect.arrayContaining(['SRS.md', '原型.png']))
  })
})
describe('project list', () => {
  const listPath = () => join(root, 'project-list.md')

  it('creates the list with its header and appends one row', () => {
    createRequirement(root, {
      thread: 'REQ-ONE',
      name: '需求一',
      trigger: { name: '万纯', chatId: 'wohR_1' },
    })
    const body = readFileSync(listPath(), 'utf8')
    expect(body).toContain('# 需求清单')
    expect(body).toContain('| 需求名 | 线程名 | 状态 | 日期 |')
    const row = body.split('\n').find((line) => line.startsWith('| 需求一'))
    expect(row).toMatch(/^\| 需求一 \| REQ-ONE \| 已建档 \| \d{4}-\d{2}-\d{2} \|$/)
  })

  it('adds a row per requirement without repeating the header', () => {
    createRequirement(root, { thread: 'REQ-ONE', name: '需求一' })
    createRequirement(root, { thread: 'REQ-TWO', name: '需求二' })
    const lines = readFileSync(listPath(), 'utf8').split('\n')
    expect(lines.filter((line) => line.startsWith('| 需求名'))).toHaveLength(1)
    expect(lines.filter((line) => line.includes('| REQ-ONE |'))).toHaveLength(1)
    expect(lines.filter((line) => line.includes('| REQ-TWO |'))).toHaveLength(1)
  })

  it('leaves one row when the same requirement is created again', () => {
    createRequirement(root, { thread: 'REQ-ONE', name: '需求一' })
    createRequirement(root, { thread: 'REQ-ONE', name: '需求一' })
    expect(readFileSync(listPath(), 'utf8').match(/\| REQ-ONE \|/g)).toHaveLength(1)
  })

  it('opens the row at 已建档, the state a person scans for', () => {
    createRequirement(root, { thread: 'REQ-CHAT', name: '聊天需求', trigger: { chatId: 'wohR_2' } })
    expect(readFileSync(listPath(), 'utf8')).toContain('| 聊天需求 | REQ-CHAT | 已建档 |')
  })
})
describe('requirement trigger', () => {
  it('reads the trigger person and chat id from meta.json', async () => {
    await meta('组织基线验证-20261102', JSON.stringify({
      thread: 'qs-org-baseline-verify-20261102',
      name: '组织基线验证',
      trigger: { name: '万纯', chatId: 'wohR_trigger' },
    }))
    expect(readRequirementTrigger(join(root, 'reqs', '组织基线验证-20261102')))
      .toEqual({ name: '万纯', chatId: 'wohR_trigger' })
  })

  it('reads no trigger from a missing or plain meta.json', async () => {
    expect(readRequirementTrigger(join(root, 'reqs', 'absent'))).toEqual({})
    await meta('half', JSON.stringify({ thread: 't-only', name: '名字' }))
    expect(readRequirementTrigger(join(root, 'reqs', 'half'))).toEqual({})
  })
})
describe('derived phase', () => {
  const state = (nodes: Record<string, { status: string }>, archived = false) => ({
    thread: 'REQ-1',
    name: '组织基线验证',
    ...(archived ? { archived: true } : {}),
    nodes,
    next: [],
    events: [],
  })

  it('reports planning when the requirement has no nodes', () => {
    expect(phaseOf(state({}))).toBe('planning')
  })

  it('reports the earliest unfinished node in action order, not the last written', () => {
    // Deploy is written first and is still pending, but merge comes earlier.
    expect(phaseOf(state({
      部署: { status: 'pending' },
      开发: { status: 'done' },
      合并: { status: 'running' },
    }))).toBe('verifying')
    // A name that carries 修复 is development work.
    expect(phaseOf(state({ 'bug修复': { status: 'running' } }))).toBe('developing')
    expect(phaseOf(state({ 自测: { status: 'pending' }, 冒烟: { status: 'done' } }))).toBe('testing')
  })

  it('reports done when every node is done', () => {
    expect(phaseOf(state({
      开发: { status: 'done' },
      合并: { status: 'done' },
      部署: { status: 'done' },
      自测: { status: 'done' },
    }))).toBe('done')
  })

  it('reports archived before any node', () => {
    expect(phaseOf(state({ 开发: { status: 'running' } }, true))).toBe('archived')
    expect(phaseOf(state({}, true))).toBe('archived')
  })

  it('carries the last known phase for a name it does not know, and never throws', () => {
    // 联调 is not in the map, so it takes the phase of 开发 before it.
    expect(phaseOf(state({ 开发: { status: 'done' }, 联调: { status: 'running' } }))).toBe('developing')
    // With no known name before it, there is nothing to carry: planning.
    expect(phaseOf(state({ 联调: { status: 'running' } }))).toBe('planning')
  })
})
describe('requirement state', () => {
  const fallback = { thread: 'REQ-1', name: '组织基线验证' }
  const dir = () => join(root, 'reqs', '组织基线验证-20260101')

  it('reads a missing state as an empty skeleton', async () => {
    await mkdir(dir(), { recursive: true })
    expect(readState(dir(), fallback)).toEqual({
      ...fallback, nodes: {}, next: [], events: [],
    })
    expect(phaseOf(readState(dir(), fallback))).toBe('planning')
  })

  it('reads a broken state file as an empty skeleton', async () => {
    await mkdir(dir(), { recursive: true })
    await writeFile(statePath(dir()), '{not json')
    expect(phaseOf(readState(dir(), fallback))).toBe('planning')
  })

  it('writes a state that reads back, stamps updatedAt and keeps the last 20 events', async () => {
    await mkdir(dir(), { recursive: true })
    const events = Array.from({ length: 25 }, (_, index) => `e${index}`)
    const saved = writeState(dir(), {
      ...fallback,
      nodes: { dev: { status: 'done', evidence: ['nodes/dev.md'] } },
      next: ['self-test'],
      events,
    })
    expect(saved.events).toEqual(events.slice(-20))
    expect(typeof saved.updatedAt).toBe('string')
    const loaded = JSON.parse(readFileSync(statePath(dir()), 'utf8'))
    expect(loaded.events).toHaveLength(20)
    expect(loaded.events[0]).toBe('e5')
    // The phase is derived now, so the file never carries it.
    expect(loaded).not.toHaveProperty('phase')
    expect(readState(dir(), fallback)).toMatchObject({
      nodes: { dev: { status: 'done' } }, next: ['self-test'],
    })
  })

  it('renders a bounded digest of nodes, next steps and recent events', async () => {
    const digest = renderDigest({
      ...fallback,
      nodes: {
        dev: { status: 'done', note: 'merged', evidence: ['a.md', 'b.md', 'c.md', 'd.md'] },
        deploy: { status: 'running' },
      },
      next: ['self-test', 'report'],
      events: ['old', 'older', 'e1', 'e2', 'e3'],
    })
    expect(digest).toContain('线程名：REQ-1')
    // Neither node name is in the map, so the phase stays at its planning default.
    expect(digest).toContain('阶段：planning')
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

  it('moves a requirement to the archive and back, clearing its archived mark and marking the row', async () => {
    await mkdir(dir(), { recursive: true })
    await writeFile(join(dir(), 'meta.json'), JSON.stringify({ thread: 'REQ-1', name: '组织基线验证' }))
    writeState(dir(), { ...fallback, nodes: {}, next: [], events: [] })
    const archived = archiveRequirement(root, dir(), fallback)
    // The archived map names the thread, so the tree can tell archived from unknown.
    expect(readArchivedRequirementDirs(root).get('REQ-1'))
      .toEqual({ dir: '组织基线验证-20260101', name: '组织基线验证' })
    expect(findArchivedRequirementDir(root, 'REQ-1')).toBe(join(root, '_archive', archived.dir))
    expect(findRequirementDir(root, 'REQ-1')).toBeUndefined()
    const archivedState = readState(join(root, '_archive', archived.dir), fallback)
    expect(archivedState.archived).toBe(true)
    expect(phaseOf(archivedState)).toBe('archived')

    const restored = restoreRequirement(root, join(root, '_archive', archived.dir), fallback)
    expect(restored.dir).toBe(archived.dir)
    expect(typeof restored.restoredAt).toBe('string')
    expect(findRequirementDir(root, 'REQ-1')).toBe(dir())
    expect(readArchivedRequirementDirs(root).size).toBe(0)
    const state = readState(dir(), fallback)
    // No nodes, so the derived phase is planning again; nothing says "archived".
    expect(state.archived).toBeUndefined()
    expect(phaseOf(state)).toBe('planning')
    expect(state.events.at(-1)).toContain('restored to')
    // One row, annotated in place: the header is not written again.
    const index = readFileSync(join(root, '_archive', 'index.md'), 'utf8')
    expect(index.split('\n').filter((line) => line.startsWith('| 需求名'))).toHaveLength(1)
    expect(index).toContain('已恢复')
    expect(index).toContain(restored.restoredAt)
  })

  it('marks the newest row when one thread was archived twice', async () => {
    // Archive, restore, archive again: the table now holds two rows for the thread.
    // The note belongs on the row the last archive wrote, not on the first one.
    await mkdir(dir(), { recursive: true })
    await writeFile(join(dir(), 'meta.json'), JSON.stringify({ thread: 'REQ-1', name: '组织基线验证' }))
    const first = archiveRequirement(root, dir(), fallback)
    restoreRequirement(root, join(root, '_archive', first.dir), fallback)
    const second = archiveRequirement(root, dir(), fallback)
    restoreRequirement(root, join(root, '_archive', second.dir), fallback)
    const rows = readFileSync(join(root, '_archive', 'index.md'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('| 组织基线验证'))
    expect(rows).toHaveLength(2)
    // The first row keeps the one note its own restore added, and never a second one.
    expect(rows[0].match(/已恢复/g)).toHaveLength(1)
    expect(rows[1].match(/已恢复/g)).toHaveLength(1)
  })

  it('leaves the requirement live when the archive cannot write its state', async () => {
    // The record is written before the move, so a failed write must leave the
    // directory where it was and the index untouched: the call can be retried.
    await mkdir(dir(), { recursive: true })
    await writeFile(join(dir(), 'meta.json'), JSON.stringify({ thread: 'REQ-1', name: '组织基线验证' }))
    await mkdir(statePath(dir()), { recursive: true })
    expect(() => archiveRequirement(root, dir(), fallback)).toThrow()
    expect(findRequirementDir(root, 'REQ-1')).toBe(dir())
    expect(existsSync(join(root, '_archive', '组织基线验证-20260101'))).toBe(false)
    expect(existsSync(join(root, '_archive', 'index.md'))).toBe(false)
  })

  it('leaves the requirement archived when the restore cannot write its state', async () => {
    await mkdir(dir(), { recursive: true })
    await writeFile(join(dir(), 'meta.json'), JSON.stringify({ thread: 'REQ-1', name: '组织基线验证' }))
    const archived = archiveRequirement(root, dir(), fallback)
    const archivedState = join(root, '_archive', archived.dir, 'state.json')
    rmSync(archivedState)
    await mkdir(archivedState, { recursive: true })
    expect(() => restoreRequirement(root, join(root, '_archive', archived.dir), fallback)).toThrow()
    expect(findArchivedRequirementDir(root, 'REQ-1')).toBe(join(root, '_archive', archived.dir))
    expect(findRequirementDir(root, 'REQ-1')).toBeUndefined()
  })

  // A permission failure is how a real rename fails here, and root ignores it.
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

  it.skipIf(asRoot)('rolls the archive record back when the move itself fails', async () => {
    // One archive first, so the index exists and the rollback has a row to take back.
    const other = join(root, 'reqs', '另一个需求-20260101')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 'meta.json'), JSON.stringify({ thread: 'REQ-2', name: '另一个需求' }))
    archiveRequirement(root, other, { thread: 'REQ-2', name: '另一个需求' })
    const indexFile = join(root, '_archive', 'index.md')
    const before = readFileSync(indexFile, 'utf8')
    await mkdir(dir(), { recursive: true })
    await writeFile(join(dir(), 'meta.json'), JSON.stringify({ thread: 'REQ-1', name: '组织基线验证' }))
    // Every write succeeds; the move cannot, because reqs/ is read-only. What the
    // test measures is the rollback: the record must not claim a move that failed.
    await chmod(join(root, 'reqs'), 0o500)
    try {
      expect(() => archiveRequirement(root, dir(), fallback)).toThrow(/EACCES/)
    } finally {
      await chmod(join(root, 'reqs'), 0o700)
    }
    expect(findRequirementDir(root, 'REQ-1')).toBe(dir())
    // The rolled-back state must not claim the archive it never made.
    expect(readState(dir(), fallback).archived).toBeUndefined()
    expect(phaseOf(readState(dir(), fallback))).toBe('planning')
    expect(existsSync(join(root, '_archive', '组织基线验证-20260101'))).toBe(false)
    expect(readFileSync(indexFile, 'utf8')).toBe(before)
  })

  it.skipIf(asRoot)('rolls the restore record back when the move itself fails', async () => {
    await mkdir(dir(), { recursive: true })
    await writeFile(join(dir(), 'meta.json'), JSON.stringify({ thread: 'REQ-1', name: '组织基线验证' }))
    const archived = archiveRequirement(root, dir(), fallback)
    await chmod(join(root, '_archive'), 0o500)
    try {
      expect(() => restoreRequirement(root, join(root, '_archive', archived.dir), fallback)).toThrow(/EACCES/)
    } finally {
      await chmod(join(root, '_archive'), 0o700)
    }
    expect(readArchivedRequirementDirs(root).get('REQ-1')).toEqual({ dir: '组织基线验证-20260101', name: '组织基线验证' })
    // Still archived, so its state still says so.
    expect(readState(join(root, '_archive', archived.dir), fallback).archived).toBe(true)
  })

  it('notes the row of a hand-written index in its own last column', async () => {
    // The index a person writes may order its columns differently. The row is found
    // by the column the header names, and the note goes in that row's last cell.
    const source = join(root, '_archive', '手工归档-20260101')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'meta.json'), JSON.stringify({ thread: 'HAND-1', name: '手工归档' }))
    const header = '| 需求名 | 线程名 | 项目 | 归档日期 | 结论 |'
    await writeFile(join(root, '_archive', 'index.md'), [
      '# 归档索引',
      '',
      header,
      '|---|---|---|---|---|',
      '| 手工归档 | HAND-1 | 平台 | 2026-11-03 | 通过 |',
      '',
    ].join('\n'))
    restoreRequirement(root, source, { thread: 'HAND-1', name: '手工归档' })
    const index = readFileSync(join(root, '_archive', 'index.md'), 'utf8')
    expect(index).toContain('| 手工归档 | HAND-1 | 平台 | 2026-11-03 | 通过（已恢复 ')
    expect(index.split('\n')[2]).toBe(header)
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

describe('attachNameProblem', () => {
  it('refuses an analysis artifact aimed at nodes', () => {
    expect(attachNameProblem('日粒度批次-拷问清单.md', 'nodes')).toContain('analysis')
    expect(attachNameProblem('领域模型-设计说明.md', 'nodes')).toContain('analysis')
  })

  it('refuses a bare nodes name with no ticket id or nature prefix', () => {
    expect(attachNameProblem('企业id下拉搜索.md', 'nodes')).toContain('票号')
  })

  it('accepts ticket-prefixed, merged, and nature-prefixed nodes names', () => {
    expect(attachNameProblem('07-dev-ASR规则.md', 'nodes')).toBeUndefined()
    expect(attachNameProblem('02+05-对账批次.md', 'nodes')).toBeUndefined()
    expect(attachNameProblem('all-deploy-F1.md', 'nodes')).toBeUndefined()
    expect(attachNameProblem('fix-entry-md5.md', 'nodes')).toBeUndefined()
    expect(attachNameProblem('deploy-ff1-d6.md', 'nodes')).toBeUndefined()
    expect(attachNameProblem('w3-冒烟记录.md', 'nodes')).toBeUndefined()
  })

  it('leaves other shelves alone', () => {
    expect(attachNameProblem('自测报告-F首轮.md', 'self-test')).toBeUndefined()
    expect(attachNameProblem('SRS_V1.1.md', 'files')).toBeUndefined()
  })
})
