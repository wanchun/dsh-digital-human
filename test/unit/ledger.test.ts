import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HumanLedger, endStateOf } from '../../src/lib/ledger'
import { HumanStore } from '../../src/lib/store'

let home = ''
let store: HumanStore
let ledger: HumanLedger

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dh-ledger-'))
  store = new HumanStore(home)
  ledger = new HumanLedger(store)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** The lines of one human's ledger, as written. */
const lines = (id = 'dev'): any[] => readFileSync(store.taskPath(id), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))

describe('the work-item ledger', () => {
  it('appends one queued row per assignment and numbers them per human', async () => {
    const first = await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    const second = await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    expect(first).toMatchObject({
      id: 'w-01', from: 'pm', to: 'dev', conversation: 'REQ-1', state: 'queued',
    })
    expect(typeof first.createdAt).toBe('string')
    expect(second.id).toBe('w-02')
    // Append-only: an assignment is a line, never a rewrite.
    expect(lines()).toHaveLength(2)
    expect((await ledger.list('dev')).map((task) => task.id)).toEqual(['w-01', 'w-02'])
  })

  it('never writes the same state twice, even across two ledgers', async () => {
    // Two claim paths can both read the head as queued — a live plugin reload gives
    // each its own write queue. The second write says nothing, so it is skipped.
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    const other = new HumanLedger(store)
    await Promise.all([
      ledger.start('dev', { conversation: 'REQ-1', sessionId: 'session-1' }),
      other.start('dev', { conversation: 'REQ-1', sessionId: 'session-1' }),
    ])
    expect(lines('dev').filter((row) => row.state === 'in_progress')).toHaveLength(1)
  })

  it('claims a lone open thread when the turn names another label for it', async () => {
    // A shared-session record files everything under one conversation, but the turn
    // arrives with whichever label the Session was recorded under. With one thread
    // open there is no ambiguity, so the head is claimed instead of left queued.
    await ledger.assign('dev', { from: 'pm', conversation: 'probe-1' })
    const claimed = await ledger.start('dev', { conversation: 'main', sessionId: 'session-1', singleThread: true })
    expect(claimed).toMatchObject({ id: 'w-01', state: 'in_progress', owner: 'session-1' })
  })

  it('still refuses to guess when two threads are open', async () => {
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-2' })
    expect(await ledger.start('dev', { conversation: 'main', sessionId: 'session-1' })).toBeUndefined()
  })

  it('records a note on the assignment and keeps it through a transition', async () => {
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1', note: 'blocked on the spec' })
    const started = await ledger.start('dev', { conversation: 'REQ-1', sessionId: 'session-1' })
    expect(started?.note).toBe('blocked on the spec')
    expect(lines()).toHaveLength(2)
  })

  it('numbers ids across conversations and keeps them stable under folding', async () => {
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-2' })
    await ledger.assign('dev', { from: 'qa', conversation: 'REQ-1' })
    const listed = await ledger.list('dev')
    expect(listed.map((task) => task.id)).toEqual(['w-01', 'w-02', 'w-03'])
    expect(listed.map((task) => task.from)).toEqual(['pm', 'pm', 'qa'])
  })

  it('marks the head of a conversation in progress when its turn starts', async () => {
    const first = await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    const second = await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    const started = await ledger.start('dev', { conversation: 'REQ-1', sessionId: 'session-1' })
    expect(started).toMatchObject({ id: first.id, state: 'in_progress', owner: 'session-1' })
    // A turn already running keeps ownership: one conversation has one live item.
    const again = await ledger.start('dev', { conversation: 'REQ-1', sessionId: 'session-2' })
    expect(again).toMatchObject({ id: first.id, owner: 'session-1' })
    const open = await ledger.open('dev', 'REQ-1')
    expect(open.map((task) => [task.id, task.state])).toEqual([[first.id, 'in_progress'], [second.id, 'queued']])
  })

  it('starts nothing when the head belongs to another conversation', async () => {
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-2' })
    expect(await ledger.start('dev', { conversation: 'REQ-1', sessionId: 'session-1' })).toBeUndefined()
    expect((await ledger.list('dev'))[0].state).toBe('queued')
  })

  it('closes only the item this session owns, then starts the next one', async () => {
    const first = await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    const second = await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    await ledger.start('dev', { conversation: 'REQ-1', sessionId: 'session-1' })
    const closed = await ledger.end('dev', { sessionId: 'session-1', reason: { kind: 'completed' } })
    expect(closed?.closed).toMatchObject({ id: first.id, state: 'done', reason: 'completed' })
    expect(typeof closed?.closed.endedAt).toBe('string')
    // The item behind it takes the conversation, without waiting for another event.
    expect(closed?.next).toMatchObject({ id: second.id, state: 'in_progress', owner: 'session-1' })
    // A turn that owns nothing closes nothing.
    const stray = await ledger.end('dev', { sessionId: 'session-2', reason: { kind: 'completed' } })
    expect(stray).toBeUndefined()
    const listed = await ledger.list('dev')
    expect(listed.find((task) => task.id === second.id)!.state).toBe('in_progress')
  })

  it('numbers a work item beyond w-99 without dropping its shape', async () => {
    for (let index = 0; index < 100; index++) {
      await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    }
    const last = await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    expect(last.id).toBe('w-101')
  })

  it('refuses an amendment with no open item, and one that is ambiguous', async () => {
    await expect(ledger.amend('dev', { conversation: 'REQ-1', text: 'more' }))
      .rejects.toThrow(/no open work item/)
    const first = await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    const updated = await ledger.amend('dev', { conversation: 'REQ-1', text: 'more' })
    expect(updated.id).toBe(first.id)
    expect(updated.amendments).toEqual([{ at: expect.any(String), text: 'more' }])
    // An amendment is an event on the item, never a second item.
    expect(await ledger.list('dev')).toHaveLength(1)
    const second = await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    await expect(ledger.amend('dev', { conversation: 'REQ-1', text: 'again' }))
      .rejects.toThrow(/more than one open work item/)
    const anchored = await ledger.amend('dev', { conversation: 'REQ-1', text: 'again', taskId: second.id })
    expect(anchored.id).toBe(second.id)
    await expect(ledger.amend('dev', { conversation: 'REQ-1', text: 'x', taskId: 'w-99' }))
      .rejects.toThrow(/w-99/)
    await expect(ledger.amend('dev', { conversation: 'REQ-1', text: '  ' }))
      .rejects.toThrow(/must not be empty/)
  })

  it('cancels a queued item and refuses one that already ended', async () => {
    const first = await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    const cancelled = await ledger.cancel('dev', { conversation: 'REQ-1' })
    expect(cancelled).toMatchObject({ id: first.id, state: 'cancelled' })
    expect(typeof cancelled.endedAt).toBe('string')
    await expect(ledger.cancel('dev', { conversation: 'REQ-1' })).rejects.toThrow(/no open work item/)
  })

  it('cancels the item named by task_id even beside another open one', async () => {
    const first = await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    const cancelled = await ledger.cancel('dev', { conversation: 'REQ-1', taskId: first.id })
    expect(cancelled.id).toBe(first.id)
    const open = await ledger.open('dev', 'REQ-1')
    expect(open.map((task) => task.id)).toEqual(['w-02'])
    await expect(ledger.cancel('dev', { conversation: 'REQ-1', taskId: first.id })).rejects.toThrow(/w-01/)
  })

  it('stops an in-progress item whose conversation went idle, and leaves a live one alone', async () => {
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    await ledger.start('dev', { conversation: 'REQ-1', sessionId: 'session-1' })
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-2' })
    await ledger.start('dev', { conversation: 'REQ-2', sessionId: 'session-2' })
    const swept = await ledger.sweep('dev', async (conversation) => conversation === 'REQ-1')
    expect(swept).toEqual([expect.objectContaining({ id: 'w-01', state: 'stopped', reason: 'restart' })])
    const listed = await ledger.list('dev')
    expect(listed.find((task) => task.id === 'w-02')!.state).toBe('in_progress')
  })

  it('keeps the deadline an assignment carries', async () => {
    const deadline = '2026-11-01T00:00:00.000Z'
    const task = await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1', deadline })
    expect(task.deadline).toBe(deadline)
    expect((await ledger.list('dev'))[0].deadline).toBe(deadline)
  })

  it('refuses an assignment whose deadline is not a timestamp', async () => {
    await expect(ledger.assign('dev', { from: 'pm', conversation: 'REQ-1', deadline: 'soon' }))
      .rejects.toThrow(/deadline/)
  })

  it('blocks an open item past its deadline, once', async () => {
    const now = new Date('2026-10-28T12:00:00.000Z')
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1', deadline: '2026-10-28T11:00:00.000Z' })
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1', deadline: '2026-10-28T13:00:00.000Z' })
    const blocked = await ledger.timeout('dev', { now, fallbackMinutes: 30, isIdle: async () => true })
    expect(blocked).toEqual([
      expect.objectContaining({ id: 'w-01', state: 'blocked', reason: 'timeout', endedAt: now.toISOString() }),
    ])
    // The item that is not overdue keeps its state, and a second pass changes nothing.
    expect((await ledger.list('dev')).map((task) => [task.id, task.state]))
      .toEqual([['w-01', 'blocked'], ['w-02', 'queued']])
    expect(await ledger.timeout('dev', { now, fallbackMinutes: 30, isIdle: async () => true })).toEqual([])
  })

  it('leaves an item alone while its conversation is still running', async () => {
    const now = new Date('2026-10-28T12:00:00.000Z')
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1', deadline: '2026-10-28T11:00:00.000Z' })
    await ledger.start('dev', { conversation: 'REQ-1', sessionId: 'session-1' })
    const seen: string[] = []
    const blocked = await ledger.timeout('dev', {
      now,
      fallbackMinutes: 30,
      isIdle: async (conversation) => {
        seen.push(conversation)
        return false
      },
    })
    expect(blocked).toEqual([])
    expect(seen).toEqual(['REQ-1'])
    // A turn/end still finds the item it owns, because nothing blocked it behind its back.
    expect((await ledger.list('dev'))[0].state).toBe('in_progress')
    expect(await ledger.end('dev', { sessionId: 'session-1', reason: { kind: 'interrupted' } }))
      .toMatchObject({ closed: { state: 'stopped', reason: 'restart' } })
    // Once the conversation is idle the same deadline does time the item out.
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-2', deadline: '2026-10-28T11:00:00.000Z' })
    expect(await ledger.timeout('dev', { now, fallbackMinutes: 30, isIdle: async () => true }))
      .toEqual([expect.objectContaining({ conversation: 'REQ-2', state: 'blocked', reason: 'timeout' })])
  })

  it('times out a row that carries no deadline using the fallback', async () => {
    // A ledger written before deadlines existed still has to settle: otherwise its
    // queued items stay open forever.
    await store.ensureDir(store.dir('dev'))
    writeFileSync(store.taskPath('dev'), `${JSON.stringify({
      id: 'w-01', from: 'pm', to: 'dev', conversation: 'REQ-1', state: 'in_progress',
      createdAt: '2026-10-28T10:00:00.000Z', owner: 'session-1',
    })}\n`)
    const now = new Date('2026-10-28T10:31:00.000Z')
    expect(await ledger.timeout('dev', { now, fallbackMinutes: 30, isIdle: async () => true }))
      .toEqual([expect.objectContaining({ id: 'w-01', state: 'blocked', reason: 'timeout' })])
    // Just inside the fallback window nothing happens.
    await store.ensureDir(store.dir('dev2'))
    writeFileSync(store.taskPath('dev2'), `${JSON.stringify({
      id: 'w-01', from: 'pm', to: 'dev2', conversation: 'REQ-1', state: 'queued',
      createdAt: '2026-10-28T10:00:00.000Z',
    })}\n`)
    expect(await ledger.timeout('dev2', { now: new Date('2026-10-28T10:29:59.000Z'), fallbackMinutes: 30, isIdle: async () => true }))
      .toEqual([])
  })

  it('claims escalation for each item at most once', async () => {
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-2' })
    const at = '2026-10-28T12:00:00.000Z'
    expect(await ledger.claim('dev', { taskIds: ['w-01', 'w-99'], at }))
      .toEqual([expect.objectContaining({ id: 'w-01', escalatedAt: at })])
    // A task already claimed, and an unknown id, claim nothing.
    expect(await ledger.claim('dev', { taskIds: ['w-01', 'w-02'], at })).toHaveLength(1)
    expect((await ledger.list('dev')).map((task) => [task.id, task.escalatedAt]))
      .toEqual([['w-01', at], ['w-02', at]])
  })

  it('skips a malformed line instead of losing the ledger', async () => {
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    writeFileSync(store.taskPath('dev'), `not json\n${readFileSync(store.taskPath('dev'), 'utf8')}`)
    expect((await ledger.list('dev')).map((task) => task.id)).toEqual(['w-01'])
  })

  it('settles an item whose delivery never reached its Session', async () => {
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    expect(await ledger.fail('dev', { taskId: 'w-01', reason: 'undelivered' }))
      .toMatchObject({ id: 'w-01', state: 'failed', reason: 'undelivered' })
    // A settled item is not settled twice.
    expect(await ledger.fail('dev', { taskId: 'w-01', reason: 'undelivered' })).toBeUndefined()
  })

  it('adopts a running item that lost its owner', async () => {
    // An older build, or a hand-edited ledger, may hold an ownerless in-progress row.
    await store.ensureDir(store.dir('dev'))
    writeFileSync(store.taskPath('dev'), `${JSON.stringify({
      id: 'w-01', from: 'pm', to: 'dev', conversation: 'REQ-1', state: 'in_progress', createdAt: '2026-01-01T00:00:00Z',
    })}\n`)
    expect(await ledger.start('dev', { conversation: 'REQ-1', sessionId: 'session-1' }))
      .toMatchObject({ id: 'w-01', owner: 'session-1' })
    expect(await ledger.start('dev', { conversation: 'REQ-1', sessionId: 'session-2' }))
      .toMatchObject({ owner: 'session-1' })
  })

  it('ends a turn that names no reason as completed', async () => {
    await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })
    await ledger.start('dev', { conversation: 'REQ-1', sessionId: 'session-1' })
    expect((await ledger.end('dev', { sessionId: 'session-1' }))?.closed)
      .toMatchObject({ state: 'done', reason: 'completed' })
  })

  it('keeps an unfamiliar id and still numbers the next one', async () => {
    await store.ensureDir(store.dir('dev'))
    writeFileSync(store.taskPath('dev'), `${JSON.stringify({
      id: 'legacy', from: 'pm', to: 'dev', conversation: 'REQ-1', state: 'queued', createdAt: '2026-01-01T00:00:00Z',
    })}\n`)
    expect((await ledger.assign('dev', { from: 'pm', conversation: 'REQ-1' })).id).toBe('w-01')
  })
})

describe('endStateOf', () => {
  it('folds a turn ending into one of four states', () => {
    expect(endStateOf({ kind: 'completed' })).toEqual({ state: 'done', reason: 'completed' })
    expect(endStateOf({ kind: 'error', error: { code: 'RATE_LIMIT' } }))
      .toEqual({ state: 'failed', reason: 'RATE_LIMIT' })
    expect(endStateOf({ kind: 'error' })).toEqual({ state: 'failed', reason: 'error' })
    expect(endStateOf({ kind: 'max-tokens' })).toEqual({ state: 'failed', reason: 'truncated' })
    expect(endStateOf({ kind: 'aborted', reason: { kind: 'user' } }))
      .toEqual({ state: 'stopped', reason: 'aborted' })
    expect(endStateOf({ kind: 'blocked' })).toEqual({ state: 'blocked', reason: 'blocked' })
    // Interrupted and forked turns were stopped from outside, never completed.
    expect(endStateOf({ kind: 'interrupted' })).toEqual({ state: 'stopped', reason: 'restart' })
    expect(endStateOf({ kind: 'forked' })).toEqual({ state: 'stopped', reason: 'forked' })
    // A Host that reports no reason at all still finished the turn.
    expect(endStateOf(undefined)).toEqual({ state: 'done', reason: 'completed' })
  })
})