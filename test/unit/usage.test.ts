import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildHumanTools } from '../../src/lib/tools'

/** One day, for windows that the tests state as a number of days. */
const DAY = 24 * 60 * 60 * 1000

/** A fixed "now", so a window is a value rather than a race with the clock. */
const NOW = Date.UTC(2026, 9, 28, 4, 0, 0)

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dh-usage-'))
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(home, { recursive: true, force: true })
})

/** The records the usage tool talks about. */
const people: Record<string, any> = {
  pm: { id: 'pm', name: '研发PM助手', enabled: true, peers: ['dev'], im: { botId: 'wecom_1', targetId: 'leader' } },
  dev: { id: 'dev', name: '开发助手', enabled: true, im: { botId: '', targetId: '' } },
  off: { id: 'off', name: '停用', enabled: false, im: { botId: '', targetId: '' } },
}

/** The `digitalHumans` surface the usage tool reads. */
function serviceStub(addresses: Record<string, any[]> = {}) {
  return {
    require: async (id: string) => {
      if (!people[id]) throw new Error(`unknown digital human: ${JSON.stringify(id)}`)
      return people[id]
    },
    resolve: async (ref: string) => people[ref] ?? Object.values(people).find((entry) => entry.name === ref),
    chat: { addresses: async (id: string) => addresses[id] ?? [] },
  }
}

/**
 * One live Session, as much of it as a replay needs.
 *
 * The meter reads `seq` and `eventAt`; the window filter reads the last event's
 * time. A single event is enough to state both.
 */
function sessionStub(id: string, { preset = 'dh-pm', lastAt = NOW - DAY, createdAt = lastAt } = {}) {
  return {
    seq: 1,
    header: { id, agentPreset: preset, createdAt },
    eventAt: (seq: number) => (seq === 0 ? { seq, time: lastAt } : undefined),
  }
}

/** A token meter whose figures the test states, and which records what it measured. */
function meterStub(tokens: Record<string, number>, broken: string[] = []) {
  const measured: string[] = []
  return {
    measured,
    measure: (session: any) => {
      const id = session.header.id
      if (broken.includes(id)) throw new Error(`corrupt log in ${id}`)
      measured.push(id)
      return { totalTokens: tokens[id] ?? 0, surfaceTokens: 0, nodes: [] }
    },
  }
}

/** The context the usage tool reads: optional metering and optional session registry. */
const ctxWith = ({ meter, sessions }: { meter?: unknown; sessions?: unknown } = {}) => ({
  get: (name: string) => (name === 'tokenMeter' ? meter : name === 'sessions' ? sessions : undefined),
})

const usageTool = (ctx: any, service: any = serviceStub(), humanId = 'pm') =>
  buildHumanTools({ ctx, service, humanId }).find((tool) => tool.name === 'digital_human_usage') as any

describe('the usage tool', () => {
  it('is offered to a record with no IM bot', () => {
    // Metering needs neither a bot nor a memory file, so neither switch trims it.
    const names = buildHumanTools({ ctx: ctxWith(), service: serviceStub(), humanId: 'dev', im: false, memory: false })
      .map((tool) => tool.name)
    expect(names).toContain('digital_human_usage')
  })

  it('reports the total and one line per session of the caller', async () => {
    const sessions = {
      list: () => [
        sessionStub('session-main', { lastAt: NOW - DAY }),
        sessionStub('session-r1', { lastAt: NOW - 2 * DAY }),
      ],
    }
    const meter = meterStub({ 'session-main': 1000, 'session-r1': 2000 })
    const result = await usageTool(ctxWith({ meter, sessions }), serviceStub({
      pm: [{ conversationId: 'REQ-1', sessionId: 'session-r1' }],
    })).execute({})

    expect(result).toMatchObject({ humanId: 'pm', measured: true, sessions: 2, totalTokens: 3000 })
    expect(result.detail).toContain('- REQ-1 (session-r1): 2,000 tokens')
    expect(result.detail).toContain('- session-main: 1,000 tokens')
    expect(result.detail).toContain('Total: 3,000 tokens across 2 session(s).')
    // Every figure is a replay of the durable log; nothing may reach a model.
    expect(meter.measured.sort()).toEqual(['session-main', 'session-r1'])
  })

  it('counts only sessions active inside the days window', async () => {
    const sessions = {
      list: () => [
        sessionStub('session-fresh', { lastAt: NOW - DAY }),
        sessionStub('session-old', { lastAt: NOW - 3 * DAY }),
      ],
    }
    const result = await usageTool(
      ctxWith({ meter: meterStub({ 'session-fresh': 10, 'session-old': 99 }), sessions }),
    ).execute({ days: 1 })
    expect(result.totalTokens).toBe(10)
    expect(result.detail).not.toContain('session-old')
  })

  it('lets since override days', async () => {
    const sessions = {
      list: () => [
        sessionStub('session-fresh', { lastAt: NOW - DAY }),
        sessionStub('session-old', { lastAt: NOW - 3 * DAY }),
      ],
    }
    // days would include both here; since is what decides.
    const result = await usageTool(
      ctxWith({ meter: meterStub({ 'session-fresh': 10, 'session-old': 99 }), sessions }),
    ).execute({ since: new Date(NOW - 2 * DAY).toISOString(), days: 30 })
    expect(result.totalTokens).toBe(10)
    expect(result.detail).not.toContain('session-old')
  })

  it('refuses a since that is not a date', async () => {
    const sessions = { list: () => [] }
    await expect(usageTool(ctxWith({ meter: meterStub({}), sessions })).execute({ since: 'last week' }))
      .rejects.toThrow(/since/)
  })

  it('reports another digital human, even one with no IM bot', async () => {
    // Metering is independent of the IM binding: a record with no bot still holds
    // Sessions, so it still has usage worth reporting.
    const sessions = {
      list: () => [
        sessionStub('session-dev', { preset: 'dh-dev', lastAt: NOW - DAY }),
        sessionStub('session-pm', { lastAt: NOW - DAY }),
      ],
    }
    const meter = meterStub({ 'session-dev': 700, 'session-pm': 30 })
    const result = await usageTool(ctxWith({ meter, sessions })).execute({ to: '开发助手' })
    expect(result).toMatchObject({ humanId: 'dev', measured: true, totalTokens: 700 })
    expect(meter.measured).toEqual(['session-dev'])
  })

  it('refuses an unknown target', async () => {
    const sessions = { list: () => [] }
    await expect(usageTool(ctxWith({ meter: meterStub({}), sessions })).execute({ to: 'nobody' }))
      .rejects.toThrow(/unknown digital human/)
  })

  it('answers one sentence for a disabled record instead of measuring it', async () => {
    const sessions = { list: () => [sessionStub('session-off', { preset: 'dh-off' })] }
    const meter = meterStub({ 'session-off': 500 })
    const result = await usageTool(ctxWith({ meter, sessions })).execute({ to: 'off' })
    expect(result).toMatchObject({ humanId: 'off', measured: false, totalTokens: 0 })
    expect(result.detail).toContain('disabled')
    expect(meter.measured).toEqual([])
  })

  it('degrades to one sentence when the token meter is absent', async () => {
    // The meter is an optional service: a Host without it must still answer.
    const sessions = { list: () => [] }
    const result = await usageTool(ctxWith({ sessions })).execute({})
    expect(result).toMatchObject({ measured: false, totalTokens: 0 })
    expect(result.detail).toContain('token meter')
  })

  it('degrades to one sentence when the session registry is absent', async () => {
    const result = await usageTool(ctxWith({ meter: meterStub({}) })).execute({})
    expect(result.measured).toBe(false)
    expect(result.detail).toContain('session registry')
  })

  it('degrades to one sentence when the session registry cannot be read', async () => {
    const sessions = { list: () => { throw new Error('store offline') } }
    const result = await usageTool(ctxWith({ meter: meterStub({}), sessions })).execute({})
    expect(result.measured).toBe(false)
    expect(result.detail).toContain('store offline')
  })

  it('leaves out a session whose log cannot be read, and names it', async () => {
    const sessions = {
      list: () => [
        sessionStub('session-good', { lastAt: NOW - DAY }),
        sessionStub('session-broken', { lastAt: NOW - DAY }),
      ],
    }
    const meter = meterStub({ 'session-good': 40 }, ['session-broken'])
    const result = await usageTool(ctxWith({ meter, sessions })).execute({})
    expect(result).toMatchObject({ measured: true, sessions: 1, totalTokens: 40 })
    expect(result.detail).toContain('could not be read: session-broken')
  })

  it('does not claim an empty window when every session failed to read', async () => {
    // "Nothing was active" and "nothing could be read" are different answers, and
    // only one of them means the window was quiet.
    const sessions = { list: () => [sessionStub('session-broken', { lastAt: NOW - DAY })] }
    const result = await usageTool(ctxWith({ meter: meterStub({}, ['session-broken']), sessions })).execute({})
    expect(result.detail).toContain('could not be read')
    expect(result.detail).not.toContain('no session was active')
  })

  it('says when the window holds no session at all', async () => {
    const result = await usageTool(ctxWith({ meter: meterStub({}), sessions: { list: () => [] } })).execute({})
    expect(result).toMatchObject({ measured: true, sessions: 0, totalTokens: 0 })
    expect(result.detail).toContain('no session was active')
  })
})
