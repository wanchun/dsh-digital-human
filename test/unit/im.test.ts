import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { claimOwner, directSenders, syncBotToHuman } from '../../src/lib/im'

let root = ''
let home = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dh-im-'))
  home = join(root, 'digital-human')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Write one bot's session state, the file the IM plugin owns. */
const stateFor = (botId: string, sessions: Record<string, string>) => {
  const dir = join(root, 'integrations', `dsh-${botId.split('_', 1)[0]}`, 'bots', botId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, sessions }))
  return dir
}

/** A Connection stub that records every dispatched request. */
function connectionStub(answer?: (body: any) => Response) {
  const seen: Array<{ channel: string; url: string; body: any }> = []
  return {
    seen,
    createSharedFetchHandler(channel: string) {
      return {
        async fetch(request: Request) {
          const body = await request.json()
          seen.push({ channel, url: request.url, body })
          if (answer) return answer(body)
          return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } })
        },
      }
    },
  }
}

describe('directSenders', () => {
  it('lists every direct sender in first-contact order', () => {
    stateFor('wecom_1', {
      'group:wrGROUP': 'session-group',
      'direct:wohR_first': 'session-a',
      'direct:wohR_second': 'session-b',
    })
    expect(directSenders(home, 'wecom_1')).toEqual(['wohR_first', 'wohR_second'])
  })

  it('never offers a group chat id as a sender', () => {
    stateFor('wecom_1', { 'group:wrGROUP': 'session-group' })
    expect(directSenders(home, 'wecom_1')).toEqual([])
  })

  it('derives the channel directory from the bot id', () => {
    // Hardcoding `dsh-wecom` would tie the plugin to one channel.
    const dir = stateFor('slack_9', { 'direct:U1': 's' })
    expect(dir).toContain('dsh-slack')
    expect(directSenders(home, 'slack_9')).toEqual(['U1'])
  })

  it('is empty for a missing file, a malformed file and a bad id', () => {
    expect(directSenders(home, 'wecom_missing')).toEqual([])
    expect(directSenders(home, undefined)).toEqual([])
    expect(directSenders(home, '1234')).toEqual([])
    const dir = join(root, 'integrations', 'dsh-wecom', 'bots', 'wecom_bad')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), '{ not json')
    expect(directSenders(home, 'wecom_bad')).toEqual([])
  })

  it('is empty when the state holds no sessions object', () => {
    const dir = join(root, 'integrations', 'dsh-wecom', 'bots', 'wecom_empty')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1 }))
    expect(directSenders(home, 'wecom_empty')).toEqual([])
  })
})

describe('claimOwner', () => {
  it('takes the first direct sender', () => {
    stateFor('wecom_1', { 'direct:wohR_first': 'a', 'direct:wohR_second': 'b' })
    expect(claimOwner(home, 'wecom_1')).toBe('wohR_first')
  })

  it('claims nothing without a sender', () => {
    expect(claimOwner(home, 'wecom_none')).toBeUndefined()
    expect(claimOwner(home, undefined)).toBeUndefined()
  })
})

describe('syncBotToHuman', () => {
  const target = { botId: 'wecom_571e4e3104d704d7e99bcf79', workspace: '/w', presetId: 'dh-pm' }

  it('is a no-op without a bot', async () => {
    const connection = connectionStub()
    const results = await syncBotToHuman({ get: () => connection }, { botId: '' })
    expect(results).toEqual([])
    expect(connection.seen).toEqual([])
  })

  it('reports an absent connection instead of throwing', async () => {
    const results = await syncBotToHuman({ get: () => undefined }, target)
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(false)
    expect(results[0].reason).toContain('connection service is absent')
  })

  it('refuses a bot id that names no channel, before any call', async () => {
    const connection = connectionStub()
    const results = await syncBotToHuman({ get: () => connection }, { ...target, botId: '1234' })
    expect(connection.seen).toEqual([])
    expect(results[0].reason).toContain('names no channel')
  })

  it('pushes the workspace, the preset and the source block', async () => {
    const connection = connectionStub()
    const results = await syncBotToHuman({ get: () => connection }, { ...target, owner: 'wohR_owner' })
    expect(results.map((entry) => entry.ok)).toEqual([true, true, true])
    const methods = connection.seen.map((entry) => entry.body.payload.method)
    expect(methods).toEqual(['bot.workspace.set', 'bot.preset.set', 'bot.context-enhancement.set'])
    expect(connection.seen[0].body.payload.payload).toEqual({ botId: target.botId, workspace: '/w' })
    expect(connection.seen[1].body.payload.payload).toEqual({ botId: target.botId, agentPreset: 'dh-pm' })
  })

  it('uses the shared channel and the namespace derived from the bot id', async () => {
    const connection = connectionStub()
    await syncBotToHuman({ get: () => connection }, target)
    expect(connection.seen.every((entry) => entry.channel === '/api')).toBe(true)
    expect(connection.seen[0].url).toBe('http://localhost/api/dsh-im/wecom')
    expect(connection.seen[0].body.method).toBe('dsh-im/wecom')
    expect(connection.seen[0].body.type).toBe('client-request')
  })

  it('gives each call its own rpcId', async () => {
    const connection = connectionStub()
    await syncBotToHuman({ get: () => connection }, target)
    const ids = connection.seen.map((entry) => entry.body.rpcId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries the owner into the source block', async () => {
    const connection = connectionStub()
    await syncBotToHuman({ get: () => connection }, { ...target, owner: 'wohR_owner' })
    const context = connection.seen[2].body.payload.payload
    expect(context.config.group.guidance).toContain('wohR_owner')
    expect(context.config.direct.guidance).toContain('wohR_owner')
    expect(context.config.group.enabled).toBe(true)
    expect(context.config.direct.enabled).toBe(true)
    expect(Object.keys(context.config).sort()).toEqual(['direct', 'group'])
    expect(Object.keys(context.config.group).sort()).toEqual(['enabled', 'fields', 'guidance'])
  })

  it('omits the owner clause when there is no owner', async () => {
    const connection = connectionStub()
    await syncBotToHuman({ get: () => connection }, target)
    expect(connection.seen[2].body.payload.payload.config.group.guidance).not.toContain('负责人')
  })

  it('ships no business rule in the guidance', async () => {
    // A persona's own rules belong to the persona; a plugin that shipped them would
    // fit exactly one deployment.
    const connection = connectionStub()
    await syncBotToHuman({ get: () => connection }, { ...target, owner: 'wohR_owner' })
    const guidance = connection.seen[2].body.payload.payload.config.group.guidance
    expect(guidance).not.toMatch(/成员登记表|新成员流程|维护者|最高权限/)
  })

  it('reports a missing route', async () => {
    const connection = connectionStub(() => new Response('nope', { status: 404 }))
    const results = await syncBotToHuman({ get: () => connection }, target)
    expect(results.every((entry) => entry.ok === false)).toBe(true)
    expect(results[0].reason).toContain('no IM route')
  })

  it('reports any other status', async () => {
    const connection = connectionStub(() => new Response('no', { status: 401 }))
    const results = await syncBotToHuman({ get: () => connection }, target)
    expect(results[0].reason).toContain('answered 401')
  })

  it('preserves the code the plugin refused with', async () => {
    const connection = connectionStub((body) => Response.json({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: false, error: { code: 'wecom-initializing', message: '稍后重试' } },
    }))
    const results = await syncBotToHuman({ get: () => connection }, target)
    expect(results[0].code).toBe('wecom-initializing')
    expect(results[0].reason).toBe('稍后重试')
  })

  it('reports a response that is not JSON', async () => {
    const connection = connectionStub(() => new Response('<html>', { status: 200 }))
    const results = await syncBotToHuman({ get: () => connection }, target)
    expect(results[0].reason).toContain('did not answer with JSON')
  })

  it('reports a response with no result', async () => {
    const connection = connectionStub(() => Response.json({ type: 'server-response' }))
    const results = await syncBotToHuman({ get: () => connection }, target)
    expect(results[0].reason).toContain('without a result')
  })

  it('reports a refusal that carries no message', async () => {
    const connection = connectionStub((body) => Response.json({
      type: 'server-response', rpcId: body.rpcId, result: { ok: false },
    }))
    const results = await syncBotToHuman({ get: () => connection }, target)
    expect(results[0].reason).toContain('refused the change')
  })

  it('reports a transport failure instead of throwing', async () => {
    const connection = {
      createSharedFetchHandler: () => ({ fetch: async () => { throw new Error('socket closed') } }),
    }
    const results = await syncBotToHuman({ get: () => connection }, target)
    expect(results[0].reason).toBe('socket closed')
  })

  it('logs every endpoint outcome', async () => {
    const connection = connectionStub()
    const log = vi.fn()
    await syncBotToHuman({ get: () => connection }, { ...target, log })
    expect(log).toHaveBeenCalledTimes(3)
    expect(log.mock.calls.every(([line]) => String(line).startsWith('aligned '))).toBe(true)
  })

  it('logs a failure with its reason', async () => {
    const connection = connectionStub(() => new Response('nope', { status: 404 }))
    const log = vi.fn()
    await syncBotToHuman({ get: () => connection }, { ...target, log })
    expect(String(log.mock.calls[0][0])).toContain('could not align')
  })

  it('skips the workspace and preset pushes when the record names none', async () => {
    const connection = connectionStub()
    const results = await syncBotToHuman({ get: () => connection }, { botId: target.botId })
    expect(results).toHaveLength(1)
    expect(connection.seen[0].body.payload.method).toBe('bot.context-enhancement.set')
  })

  it('derives the mount from the channel prefix', async () => {
    const connection = connectionStub()
    await syncBotToHuman({ get: () => connection }, { ...target, botId: 'dingtalk_9' })
    expect(connection.seen[0].url).toBe('http://localhost/api/dsh-im/dingtalk')
  })

  it('resolves the integration directory next to the registry root', async () => {
    // `home` is `<dshRoot>/digital-human`, so the data sits one level up.
    const connection = connectionStub()
    await syncBotToHuman({ get: () => connection }, target)
    expect(dirname(home)).toBe(root)
  })
})
