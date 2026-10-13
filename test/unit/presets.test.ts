import { describe, expect, it } from 'vitest'

import {
  buildPresetDefinition,
  builtinConfig,
  effectiveConfig,
  neutralizePlaceholders,
  presetIdOf,
  renderConfigBlock,
  renderOperatingContext,
  resolveConfig,
  resolveConfigValues,
} from '../../src/lib/presets'
import { normalizeHuman } from '../../src/lib/store'

/** A record with just enough filled in to be valid. */
const record = (patch: Record<string, unknown> = {}) => normalizeHuman({
  id: 'pm',
  name: '研发PM助手',
  systemPrompt: 'x',
  ...patch,
})

/** The store stand-in `buildPresetDefinition` reads paths from. */
const store = {
  file: '/home/humans.json',
  memoryPath: (id: string) => `/home/humans/${id}/memory.md`,
}

const build = (human: Record<string, unknown>, extra: Record<string, unknown> = {}) => buildPresetDefinition(
  human,
  { store, toolsPluginName: '@local/tools', order: 100, ...extra },
).plugins[0].config

describe('presetIdOf', () => {
  it('prefixes the human id', () => {
    expect(presetIdOf('pm')).toBe('dh-pm')
  })
})

describe('builtinConfig', () => {
  const human = record({
    name: '研发PM助手',
    peers: ['dev'],
    im: { botId: 'wecom_1', owner: 'wohR_owner' },
  })

  it('reports the record itself', () => {
    expect(builtinConfig(human)).toMatchObject({ self_id: 'pm', self_name: '研发PM助手' })
  })

  it('reports the owner as both id and address', () => {
    const facts = builtinConfig(human)
    expect(facts.owner_id).toBe('wohR_owner')
    expect(facts.owner_chat).toBe(facts.owner_id)
  })

  it('resolves a peer from the supplied names', () => {
    expect(builtinConfig(human, { dev: '开发助手' })).toMatchObject({ peer_id: 'dev', peer_name: '开发助手' })
  })

  it('omits the peer facts when the id does not resolve', () => {
    const facts = builtinConfig(human, {})
    expect(facts.peer_id).toBeUndefined()
    expect(facts.peer_name).toBeUndefined()
  })

  it('omits the owner facts when there is no owner', () => {
    expect(builtinConfig(record({ im: { botId: 'wecom_1' } })).owner_chat).toBeUndefined()
  })

  it('survives a record with nothing in it', () => {
    expect(builtinConfig({})).toEqual({})
    expect(builtinConfig(undefined)).toEqual({})
  })
})

describe('resolveConfigValues', () => {
  it('uses the entries as written when nothing is declared', () => {
    const human = record({ config: { team_name: 'TCTP', blank: '' } })
    const { values, sources } = resolveConfigValues(human)
    expect(values.team_name).toBe('TCTP')
    expect(sources.team_name).toBe('配置')
  })

  it('drops a key the schema does not declare', () => {
    const human = record({ config: { stale: 'x', keep: 'y' }, configSchema: [{ key: 'keep' }] })
    const { values } = resolveConfigValues(human)
    expect(values.keep).toBe('y')
    expect(values.stale).toBeUndefined()
  })

  it('prefers an explicit value over the fact it names', () => {
    const human = record({
      im: { botId: 'wecom_1', owner: 'wohR_owner' },
      config: { where: 'explicit' },
      configSchema: [{ key: 'where', from: 'owner_chat' }],
    })
    expect(resolveConfigValues(human).values.where).toBe('explicit')
  })

  it('falls back to the fact, then to the default', () => {
    const human = record({
      name: 'N',
      configSchema: [
        { key: 'a', from: 'self_name' },
        { key: 'b', from: 'self_name', default: 'D' },
        { key: 'c', default: 'D' },
        { key: 'd' },
      ],
    })
    const { values, sources } = resolveConfigValues(human)
    expect(values.a).toBe('N')
    expect(values.b).toBe('N')
    expect(values.c).toBe('D')
    expect(sources.c).toBe('默认')
    expect(values.d).toBeUndefined()
    expect(sources.d).toBe('未配置')
  })

  it('does not offer a fact the schema omits', () => {
    const human = record({ configSchema: [{ key: 'only' }] })
    expect(resolveConfigValues(human).values.self_id).toBeUndefined()
  })
})

describe('resolveConfig', () => {
  it('replaces a configured key', () => {
    expect(resolveConfig('组长 {{leader}}。', { leader: '万纯' })).toBe('组长 万纯。')
  })

  it('tolerates padding inside the braces', () => {
    expect(resolveConfig('{{ leader }}', { leader: '万纯' })).toBe('万纯')
  })

  it('replaces a key the store would accept but a character class would not', () => {
    expect(resolveConfig('{{团队名称}}', { 团队名称: 'TCTP' })).toBe('TCTP')
  })

  it('leaves a key it does not know', () => {
    expect(resolveConfig('{{cwd}}', { leader: 'x' })).toBe('{{cwd}}')
  })

  it('leaves an empty value alone', () => {
    expect(resolveConfig('{{a}}', { a: '' })).toBe('{{a}}')
  })

  it('is a no-op without config', () => {
    expect(resolveConfig('{{a}}', undefined)).toBe('{{a}}')
    expect(resolveConfig('{{a}}', {})).toBe('{{a}}')
  })
})

describe('neutralizePlaceholders', () => {
  it('keeps a registered variable', () => {
    expect(neutralizePlaceholders('dir {{cwd}}')).toBe('dir {{cwd}}')
  })

  it('keeps every registered name', () => {
    const text = '{{provider}} {{model}} {{cwd}}'
    expect(neutralizePlaceholders(text)).toBe(text)
  })

  it('marks an unknown name', () => {
    expect(neutralizePlaceholders('{{nope}}')).toBe('〔未配置：nope〕')
  })

  it('marks a non-ASCII name, which is what a hand-written example looks like', () => {
    expect(neutralizePlaceholders('{{名称}}')).toBe('〔未配置：名称〕')
  })

  it('rejects padding the renderer would refuse', () => {
    // The renderer throws on inner whitespace, so passing this through would kill
    // the very turn this function exists to protect.
    expect(neutralizePlaceholders('{{ cwd }}')).toBe('〔未配置：cwd〕')
    expect(neutralizePlaceholders('{{cwd }}')).toBe('〔未配置：cwd〕')
    expect(neutralizePlaceholders('{{ cwd}}')).toBe('〔未配置：cwd〕')
  })

  it('breaks a group glued to another brace', () => {
    const out = neutralizePlaceholders('{{{cwd}}}')
    expect(out).not.toContain('{{')
    expect(out).toContain('cwd')
  })

  it('breaks a lone opener that could pair with a later closer', () => {
    // The valid group is kept — that is the point of the function — while the bare
    // opener is spaced apart so the renderer cannot trip over it.
    const out = neutralizePlaceholders('a {{ b {{cwd}}')
    expect(out).toBe('a { { b {{cwd}}')
  })

  it('leaves a trailing closer alone, because the renderer advances past a group', () => {
    expect(neutralizePlaceholders('{{cwd}}}')).toBe('{{cwd}}}')
  })

  it('honours an extended allow-list', () => {
    expect(neutralizePlaceholders('{{tenant}}', ['cwd', 'tenant'])).toBe('{{tenant}}')
  })

  it('is safe on empty input', () => {
    expect(neutralizePlaceholders(undefined)).toBe('')
    expect(neutralizePlaceholders('')).toBe('')
  })

  it('produces text the renderer accepts, for every shape it rejects', () => {
    const rendererAccepts = (text: string) => {
      let last = 0
      for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
        const group = /^\{\{([^{}]*)\}\}/.exec(text.slice(open))
        if (group === null) {
          if (text.indexOf('}}', open + 2) >= 0) return false
          last = open + 2
          continue
        }
        const name = group[0].slice(2, -2)
        if (!/^[a-z][a-z0-9_]*$/.test(name)) return false
        if (!['provider', 'model', 'cwd'].includes(name)) return false
        last = open + group[0].length
      }
      return true
    }
    const shapes = [
      '{{cwd}}', '{{ cwd }}', '{{cwd }}', '{{ cwd}}', '{{{cwd}}}', '{{{{cwd}}}}',
      'a {{ b {{cwd}}', '{{名称}}', '{{nope}}', 'plain', '{{cwd}}}', 'x{{',
    ]
    for (const shape of shapes) {
      expect(rendererAccepts(neutralizePlaceholders(shape)), shape).toBe(true)
    }
  })
})

describe('renderConfigBlock', () => {
  it('is empty when nothing is declared or configured', () => {
    expect(renderConfigBlock(record())).toEqual([])
  })

  it('states a configured value, an automatic one and a default', () => {
    const human = record({
      name: 'N',
      config: { team: 'T' },
      configSchema: [{ key: 'team' }, { key: 'who', from: 'self_name' }, { key: 'dir', default: 'docs' }],
    })
    const block = renderConfigBlock(human).join('\n')
    expect(block).toContain('| `team` | T | 配置 |')
    expect(block).toContain('| `who` | N | 自动 |')
    expect(block).toContain('| `dir` | docs | 默认 |')
  })

  it('names what is declared but unset', () => {
    const block = renderConfigBlock(record({ configSchema: [{ key: 'missing' }] })).join('\n')
    expect(block).toContain('missing')
    expect(block).toContain('未配置')
  })

  it('never leaks an undeclared key', () => {
    const human = record({ config: { stale: 'x' }, configSchema: [{ key: 'kept' }] })
    expect(renderConfigBlock(human).join('\n')).not.toContain('stale')
  })
})

describe('renderOperatingContext', () => {
  it('names the record, the registry and the memory path', () => {
    const lines = renderOperatingContext(record(), store)
    expect(lines).toContain('`pm`')
    expect(lines).toContain(store.file)
    expect(lines).toContain(store.memoryPath('pm'))
  })

  it('omits the memory line when memory is off', () => {
    expect(renderOperatingContext(record({ memory: false }), store)).not.toContain('durable memory')
  })

  it('names peers, or tells the model to look them up', () => {
    expect(renderOperatingContext(record({ peers: ['dev'] }), store)).toContain('`dev`')
    expect(renderOperatingContext(record(), store)).toContain('digital_human_list')
  })

  it('states the owner as an identity, not as a policy', () => {
    const lines = renderOperatingContext(record({ im: { botId: 'wecom_1', owner: 'wohR_x' } }), store)
    expect(lines).toContain('wohR_x')
    // A business rule here would fit one persona only.
    expect(lines).not.toMatch(/authority|new-member|组长|维护者/)
  })

  it('lists only the wake-ups that are enabled', () => {
    const human = record({
      subscriptions: [
        { cron: '0 22 * * *', prompt: 'a', enabled: true },
        { cron: '0 3 * * *', prompt: 'b', enabled: false },
      ],
    })
    const lines = renderOperatingContext(human, store)
    expect(lines).toContain('0 22 * * *')
    expect(lines).not.toContain('0 3 * * *')
  })

  it('omits the wake-up line when every one is disabled', () => {
    const human = record({ subscriptions: [{ cron: '0 3 * * *', prompt: 'b', enabled: false }] })
    expect(renderOperatingContext(human, store)).not.toContain('wake-ups')
  })
})

describe('buildPresetDefinition', () => {
  it('puts the persona first and the tools row last', () => {
    const definition = buildPresetDefinition(record(), { store, toolsPluginName: '@local/tools', order: 7 })
    expect(definition.id).toBe('dh-pm')
    expect(definition.order).toBe(7)
    expect(definition.plugins[0].id).toBe('persona')
    expect(definition.plugins.at(-1)?.id).toBe('digital-human-tools')
  })

  it('carries the memory switch on the tools row, because apply is synchronous', () => {
    const off = buildPresetDefinition(record({ memory: false }), { store, toolsPluginName: '@local/tools', order: 1 })
    expect(off.plugins.at(-1)?.config).toMatchObject({ human: 'pm', memory: false })
  })

  it('resolves the prose and keeps the platform suffix variable', () => {
    const human = record({ systemPrompt: '你是「{{bot}}」。', config: { bot: '研发PM助手' } })
    const config = buildPresetDefinition(human, { store, toolsPluginName: '@local/tools', order: 1 }).plugins[0].config
    expect(config.prefix).toContain('你是「研发PM助手」。')
    expect(config.suffix).toContain('{{cwd}}')
  })

  it('leaves no placeholder the renderer would refuse', () => {
    const human = record({ systemPrompt: '{{ cwd }} 与 {{团队}}', config: { 团队: 'T' } })
    const config = buildPresetDefinition(human, { store, toolsPluginName: '@local/tools', order: 1 }).plugins[0].config
    expect(config.prefix).not.toContain('{{ ')
  })

  it('extends the platform variable set instead of replacing it', () => {
    const human = record({ systemPrompt: '{{cwd}} {{tenant}}' })
    const config = buildPresetDefinition(human, {
      store, toolsPluginName: '@local/tools', order: 1, platformVariables: ['tenant'],
    }).plugins[0].config
    expect(config.prefix).toContain('{{cwd}}')
    expect(config.prefix).toContain('{{tenant}}')
  })

  it('leaves the deployment skill roots alone, so global skills keep loading', () => {
    // Only the plugin's own skill space is opt-in. Everything outside it — the global
    // directory, the project's, the bundled set — keeps loading for every agent, so a
    // digital human must not have to re-declare what the deployment already mounts.
    const rows = buildPresetDefinition(record({ skills: ['qs'] }), { store, toolsPluginName: '@local/tools', order: 1 }).plugins
    const skills = rows.find((row) => row.id === 'skill-filesystem')
    expect(skills?.config?.includeDefaultRoots).toBeUndefined()
    expect(skills?.disabled).toBeFalsy()
  })

  it('carries the mounted plugin-space skills on the tools row', () => {
    // The row is where they are registered, and it is synchronous, so the list
    // travels with it rather than being read back from the registry.
    const rows = buildPresetDefinition(record({ skills: ['qs', 'dpms'] }), { store, toolsPluginName: '@local/tools', order: 1 }).plugins
    expect(rows.at(-1)?.config).toMatchObject({ skills: ['qs', 'dpms'] })
  })

  it('carries an empty list when the record mounts none', () => {
    const rows = buildPresetDefinition(record(), { store, toolsPluginName: '@local/tools', order: 1 }).plugins
    expect(rows.at(-1)?.config).toMatchObject({ skills: [] })
  })

  it('drops a disabled shell for the other platform', () => {
    const rows = buildPresetDefinition(record(), { store, toolsPluginName: '@local/tools', order: 1 }).plugins
    const bash = rows.find((row) => row.id === 'tool-bash')
    const pwsh = rows.find((row) => row.id === 'tool-pwsh')
    if (process.platform === 'win32') {
      expect(bash?.disabled).toBe(true)
      expect(pwsh?.disabled).toBeFalsy()
    } else {
      expect(bash?.disabled).toBeFalsy()
      expect(pwsh?.disabled).toBe(true)
    }
  })

  it('keeps every row id unique and every isolate satisfied', () => {
    const rows = buildPresetDefinition(record(), { store, toolsPluginName: '@local/tools', order: 1 }).plugins
    const ids = rows.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    // A group's `isolate` key names a service the group must supply, or the preset
    // strands at "waiting for X" and the agent never loads.
    const PROVIDERS: Record<string, string> = {
      compaction: '@deepseek-ai/dsh-compaction-basic',
      toolResultPruner: '@deepseek-ai/dsh-compaction-tool-result-pruner',
      workflowEngine: '@deepseek-ai/dsh-workflow-ptc',
    }
    for (const group of rows.filter((row) => row.group === true)) {
      const inner = Array.isArray(group.config) ? group.config : []
      for (const service of Object.keys(group.isolate ?? {})) {
        const provider = PROVIDERS[service]
        expect(provider, `unmapped isolate: ${service}`).toBeDefined()
        expect(inner.some((row: { name?: string }) => row.name === provider), `${group.id}/${service}`).toBe(true)
      }
    }
  })
})

describe('effectiveConfig', () => {
  it('merges the facts under the configured values', () => {
    const human = record({ name: 'N', config: { self_name: 'overridden' } })
    expect(effectiveConfig(human).self_name).toBe('overridden')
  })
})
