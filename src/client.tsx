/**
 * Browser half of the digital-human platform — JSX source.
 *
 * Two columns: the left is the registry list, the right is the selected record.
 * The settings page and the sidebar panel render this one component, so there is
 * a single editing surface. Data arrives from the Host half over the Connection
 * service's `/api` channel.
 *
 * Built by Vite into `client.js`. See `vite.config.mjs` and
 * `tools/wrap-client.mjs`. Do not edit `client.js` by hand.
 */

import React from 'react'
import type { Human, HumanPatch, ImBot, SkillSummary, WorkspaceView } from './lib/types.js'
import {
  Button,
  Checkbox,
  IconChevronDownOutlineRegular,
  Input,
  Menu,
  Pill,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'


/** Connection endpoint that carries this page's Host methods. */
const RPC_ENDPOINT = 'digital-human'
/** Slot id of the sidebar panel. */
const PANEL_ID = 'digital-humans'

/**
 * Page stylesheet, injected once.
 *
 * A stylesheet is required rather than inline styles: hover, focus, and
 * descendant states have no inline equivalent.
 */
const STYLE = `
.dh-root { display: flex; flex-direction: column; gap: 14px; min-width: 0; flex: 1 1 auto; }
.dh-panel { display: flex; flex-direction: column; gap: 12px; padding: 16px; overflow: auto; height: 100%; box-sizing: border-box; }
.dh-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dh-title { font-size: 15px; line-height: 22px; color: var(--dsw-alias-label-primary); margin: 0; font-weight: 600; }
.dh-meta { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); font-family: ui-monospace, monospace; overflow-wrap: anywhere; margin: 0; }
.dh-columns { display: flex; align-items: stretch; min-height: 0; flex: 1 1 auto; flex-wrap: wrap; }
.dh-listpane { display: flex; flex-direction: column; gap: 2px; flex: 0 0 220px; min-width: 180px; padding-right: 14px; border-right: 1px solid var(--dsw-alias-border-l1); }
.dh-detail { display: flex; flex-direction: column; gap: 12px; flex: 1 1 320px; min-width: 260px; padding-left: 14px; }
.dh-list { display: flex; flex-direction: column; gap: 1px; }
.dh-item {
  display: flex; flex-direction: column; gap: 1px; width: 100%;
  text-align: left; padding: 7px 9px; border: 0; border-radius: var(--dsw-radius-md, 8px);
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; cursor: pointer;
}
.dh-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dh-item[data-active="true"] { background: var(--dsw-alias-interactive-bg-hover); }
.dh-item:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.dh-item-name { font-size: 14px; line-height: 20px; display: flex; align-items: center; gap: 6px; }
.dh-item-id { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); font-family: ui-monospace, monospace; }
.dh-item-off .dh-item-name, .dh-item-name[data-off="true"] { color: var(--dsw-alias-label-tertiary); }
.dh-section { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--dsw-radius-lg, 10px); border: 1px solid var(--dsw-alias-border-l1); }
.dh-section-title { font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary); margin: 0; font-weight: 600; }
.dh-field { display: flex; flex-direction: column; gap: 4px; }
.dh-label { font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
/* Match the library Input wrapper exactly, so a multi-line field and a
   single-line one read as the same control. */
.dh-area {
  box-sizing: border-box; width: 100%; min-height: 130px; padding: 6px 8px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 14px; line-height: 22px; font-family: inherit;
  resize: vertical;
}
.dh-area:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
/* Button renders its icon before the children; reversing puts the chevron on
   the right, where a picker keeps it. */
.dh-trigger { width: 100%; flex-direction: row-reverse; justify-content: space-between; }
.dh-trigger-text { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
/* The card is sized to the anchor by default; full labels need their own width. */
.dh-menu { min-width: 380px; max-width: min(760px, 92vw); }
.dh-menu [role="menuitem"] { font-size: 14px; }
.dh-choices { display: flex; flex-direction: column; gap: 4px; }
.dh-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.dh-error { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); margin: 0; }
.dh-notice { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-business-primary); margin: 0; }
.dh-hint { font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-tertiary); margin: 0; }
.dh-empty { font-size: 14px; color: var(--dsw-alias-label-tertiary); padding: 8px 0; margin: 0; }
`

let styleInjected = false

/** Inject the stylesheet once per document. */
function ensureStyle(): void {
  if (styleInjected || typeof document === 'undefined') return
  styleInjected = true
  const element = document.createElement('style')
  element.setAttribute('data-digital-human', 'styles')
  element.textContent = STYLE
  document.head.appendChild(element)
}

/** One Host method call, already unwrapped from the Connection envelope. */
type RpcCall = (method: string, payload?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>

/** The editable form state for one record. */
interface Draft {
  id: string
  name: string
  description: string
  systemPrompt: string
  workspace: string
  skills: string[]
  peers: string[]
  botId: string
  enabled: boolean
  memory: boolean
  creating: boolean
}

/** One choice of a picker. `short` keeps the trigger readable; `label` stays full. */
interface Choice {
  id: string
  label: string
  short?: string
}

/** Explain how a bound bot's Workspace relates to the digital human's. */
function botWorkspaceNote(bot: ImBot | undefined, workspace?: string): string {
  if (!bot) return '别名在「设置 → IM机器人」里设置；没设别名时按绑定的工作区区分。'
  if (!workspace) return '数字人还没选工作区。不选就在「数字人」工作区里跑。'
  if (!bot.workspace) {
    return `这个 bot 还没有工作区。去「设置 → IM机器人」把它设为 ${workspace}。`
  }
  if (bot.workspace !== workspace) {
    return `bot 的工作区是 ${bot.workspace}，与数字人的 ${workspace} 不同。以数字人为准 —— 去「设置 → IM机器人」把 bot 改成 ${workspace}。`
  }
  return `已对齐：数字人和 bot 都在 ${workspace} 里跑。`
}

/** Name a bot for a trigger: alias first, then the raw id. Never the path. */
function botShortLabel(bot: ImBot): string {
  const channel = bot.channel ? `${bot.channel} · ` : ''
  return `${channel}${bot.alias || bot.botId}`
}

/** Name a bot for a picker: alias first, then its directory, then the raw id. */
function botLabel(bot: ImBot): string {
  const channel = bot.channel ? `${bot.channel} · ` : ''
  if (bot.alias) return `${channel}${bot.alias} — ${bot.botId}`
  if (bot.workspace) return `${channel}${bot.botId} — ${bot.workspace}`
  return `${channel}${bot.botId}`
}

/** A new record's form state. */
const BLANK: Draft = {
  id: '',
  name: '',
  description: '',
  systemPrompt: '',
  workspace: '',
  skills: [],
  peers: [],
  botId: '',
  enabled: true,
  memory: true,
  creating: false,
}

/** Form state for a stored record. */
function toDraft(human: Human): Draft {
  return {
    id: human.id,
    name: human.name,
    description: human.description,
    systemPrompt: human.systemPrompt,
    workspace: human.workspace,
    skills: [...(human.skills ?? [])],
    peers: [...(human.peers ?? [])],
    botId: human.im?.botId ?? '',
    enabled: human.enabled !== false,
    memory: human.memory !== false,
    creating: false,
  }
}

/** The patch a save sends. */
function toPatch(draft: Draft): HumanPatch {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt,
    workspace: draft.workspace.trim(),
    skills: draft.skills ?? [],
    peers: draft.peers ?? [],
    im: { botId: draft.botId.trim(), targetId: '' },
    enabled: draft.enabled,
    memory: draft.memory,
  }
}

/** One labelled single-line field. */
function Field({ label, value, onChange, hint, mono, disabled }: {
  label: string
  value?: string
  onChange: (value: string) => void
  hint?: string
  mono?: boolean
  disabled?: boolean
}) {
  return (
    <label className="dh-field">
      <span className="dh-label">{label}</span>
      <Input
        style={{ width: '100%', ...(mono ? { fontFamily: 'ui-monospace, monospace' } : {}) }}
        value={value ?? ''}
        disabled={disabled === true}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <span className="dh-hint">{hint}</span> : null}
    </label>
  )
}

/**
 * One labelled picker, built from the library's anchored menu.
 *
 * The library ships no select atom; its settings pages open a `Menu` from a
 * button trigger, so this does the same and keeps the page's keyboard walk.
 */
function MenuField({ label, value, options, onChange, hint, placeholder }: {
  label: string
  value: string
  options: Choice[]
  onChange: (value: string) => void
  hint?: string
  placeholder?: string
}) {
  const [open, setOpen] = React.useState(false)
  const current = options.find((option) => option.id === value)
  return (
    <div className="dh-field">
      <span className="dh-label">{label}</span>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        selectedId={value}
        align="start"
        side="bottom"
        // The card is sized to the anchor by default, which clips a long label.
        listClassName="dh-menu"
        items={options.map((option) => ({ id: option.id, label: option.label }))}
        onSelect={(id: string) => { onChange(id); setOpen(false) }}
        anchor={(
          <Button
            variant="outline"
            className="dh-trigger"
            onClick={() => setOpen((wasOpen) => !wasOpen)}
            icon={<IconChevronDownOutlineRegular />}
          >
            <span className="dh-trigger-text">
              {current ? (current.short ?? current.label) : (placeholder ?? '请选择')}
            </span>
          </Button>
        )}
      />
      {hint ? <span className="dh-hint">{hint}</span> : null}
    </div>
  )
}

/** The configuration page: list on the left, the selected record on the right. */
function DigitalHumansPage({ rpc }: { rpc: RpcCall }) {
  const [phase, setPhase] = React.useState('loading')
  const [humans, setHumans] = React.useState<Human[]>([])
  const [file, setFile] = React.useState<string>('')
  const [draft, setDraft] = React.useState<Draft | null>(null)
  const [bots, setBots] = React.useState<ImBot[]>([])
  const [skills, setSkills] = React.useState<SkillSummary[]>([])
  // Always this exact shape. The Host returns `workspaces`; reading a
  // differently named field during render once blanked the whole panel.
  const [workspaces, setWorkspaces] = React.useState<{ items: WorkspaceView[]; defaultTitle: string; defaultPath: string | null }>({ items: [], defaultTitle: '数字人', defaultPath: null })
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<boolean>(false)
  const mounted = React.useRef<boolean>(true)

  React.useEffect(() => () => { mounted.current = false }, [])
  React.useEffect(() => { ensureStyle() }, [])

  /** Call one Host method, unwrapping the Connection envelope. */
  const call = React.useCallback(async (method: string, payload: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const result = await rpc(method, payload, signal)
    if (result?.ok !== true) throw new Error(result?.error?.message ?? '宿主拒绝了这次请求')
    return result.value
  }, [rpc])

  const load = React.useCallback(async (signal?: AbortSignal) => {
    const value = await call('registry.list', {}, signal)
    if (signal?.aborted || !mounted.current) return
    setHumans(value.humans)
    setFile(value.file)
    setDraft((current) => {
      if (current?.creating === true) return current
      if (current) {
        const fresh = value.humans.find((entry) => entry.id === current.id)
        if (fresh) return toDraft(fresh)
      }
      return value.humans.length > 0 ? toDraft(value.humans[0]) : { ...BLANK, creating: true }
    })
    setPhase('ready')
  }, [call])

  React.useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).catch((caught) => {
      if (controller.signal.aborted || caught?.name === 'AbortError') return
      setError(String(caught.message ?? caught))
      setPhase('ready')
    })
    return () => controller.abort()
  }, [load])

  React.useEffect(() => {
    const controller = new AbortController()
    call('im.bots', {}, controller.signal)
      .then((value) => { if (!controller.signal.aborted && mounted.current) setBots(value.bots) })
      .catch(() => {})
    return () => controller.abort()
  }, [call])

  React.useEffect(() => {
    const controller = new AbortController()
    call('workspaces.list', {}, controller.signal)
      .then((value) => {
        if (controller.signal.aborted || !mounted.current) return
        setWorkspaces({
          items: Array.isArray(value?.workspaces) ? value.workspaces : [],
          defaultTitle: value?.defaultTitle ?? '数字人',
          defaultPath: value?.defaultPath ?? null,
        })
      })
      .catch(() => {})
    return () => controller.abort()
  }, [call])

  React.useEffect(() => {
    const controller = new AbortController()
    call('skills.list', {}, controller.signal)
      .then((value) => { if (!controller.signal.aborted && mounted.current) setSkills(value.skills) })
      .catch(() => {})
    return () => controller.abort()
  }, [call])

  /** Run one mutation, then refresh from the Host. */
  const act = async (work: () => Promise<string>): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const message = await work()
      await load()
      if (mounted.current) setNotice(message)
    } catch (caught) {
      if (mounted.current) setError(String(caught.message ?? caught))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const patch = (fields: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...fields } : current))

  if (phase === 'loading') {
    return <div className="dh-root"><p className="dh-hint">正在读取数字人注册表…</p></div>
  }

  const creating = draft?.creating === true
  const peers = draft?.peers ?? []
  const others = humans.filter((entry) => entry.id !== draft?.id)
  const chosen = draft?.skills ?? []
  // A configured skill the catalog no longer offers must stay visible, or saving
  // the form would silently drop it.
  const catalog = skills.map((entry) => entry.name)
  const skillChoices = [
    ...skills,
    ...chosen.filter((name) => !catalog.includes(name))
      .map((name) => ({ name, description: '这个技能当前不在目录里。' })),
  ]
  const boundBot = bots.find((entry) => entry.botId === draft?.botId)

  return (
    <div className="dh-root">
      <div className="dh-head">
        <h3 className="dh-title">数字人（{humans.length}）</h3>
        <Button
          size="sm"
          style={{ marginLeft: 'auto' }}
          disabled={busy}
          onClick={() => { setNotice(null); setError(null); setDraft({ ...BLANK, creating: true }) }}
        >
          新建
        </Button>
        <Button size="sm" disabled={busy} onClick={() => act(async () => { await load(); return '已刷新' })}>
          刷新
        </Button>
      </div>

      {file ? <p className="dh-meta">注册表：{file}</p> : null}
      {error ? <p className="dh-error" role="alert">{error}</p> : null}
      {notice ? <p className="dh-notice">{notice}</p> : null}

      <div className="dh-columns">
        <div className="dh-listpane">
          <div className="dh-list">
            {humans.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="dh-item"
                data-active={draft?.id === entry.id && !creating ? 'true' : 'false'}
                onClick={() => { setNotice(null); setError(null); setDraft(toDraft(entry)) }}
              >
                <span className="dh-item-name" data-off={entry.enabled ? 'false' : 'true'}>
                  <StateDot state={entry.enabled ? 'done' : 'idle'} />
                  {entry.name}{entry.enabled ? '' : '（已停用）'}
                </span>
                <span className="dh-item-id">{entry.id}</span>
              </button>
            ))}
            {creating ? (
              <button type="button" className="dh-item" data-active="true">
                <span className="dh-item-name">新建数字人</span>
                <span className="dh-item-id">未保存</span>
              </button>
            ) : null}
          </div>
          {humans.length === 0 && !creating ? <p className="dh-empty">还没有数字人。</p> : null}
        </div>

        <div className="dh-detail">
          <Field
            label="ID"
            value={draft?.id}
            mono
            disabled={!creating}
            onChange={(value) => patch({ id: value })}
          />
          <Field label="显示名称" value={draft?.name} onChange={(value) => patch({ name: value })} />
          <Field label="一句话说明" value={draft?.description} onChange={(value) => patch({ description: value })} />

          <label className="dh-field">
            <span className="dh-label">人设</span>
            <textarea
              className="dh-area"
              value={draft?.systemPrompt ?? ''}
              onChange={(event) => patch({ systemPrompt: event.target.value })}
            />
          </label>

          <MenuField
            label="工作区"
            value={draft?.workspace ?? ''}
            options={[
              { id: '', label: `（默认：${workspaces.defaultTitle}）` },
              ...(workspaces.items ?? []).map((item) => ({
                id: item.path,
                label: item.title || item.path,
              })),
            ]}
            onChange={(value) => patch({ workspace: value })}
            hint={draft?.workspace
              ? `会话在 ${draft.workspace} 里跑。`
              : `不选就在「${workspaces.defaultTitle}」工作区里跑。`}
          />

          <div className="dh-field">
            <span className="dh-label">技能</span>
            {skillChoices.length === 0
              ? <p className="dh-empty">没有可用的技能。</p>
              : (
                <div className="dh-choices">
                  {skillChoices.map((entry) => (
                    <Checkbox
                      key={entry.name}
                      checked={chosen.includes(entry.name)}
                      label={entry.name}
                      title={entry.description}
                      onChange={(next) => patch({
                        skills: next ? [...chosen, entry.name] : chosen.filter((name) => name !== entry.name),
                      })}
                    />
                  ))}
                </div>
              )}
          </div>

          <div className="dh-field">
            <span className="dh-label">数字人间通讯</span>
            {others.length === 0
              ? <p className="dh-empty">还没有别的数字人可以联系。</p>
              : (
                <div className="dh-choices">
                  {others.map((entry) => (
                    <Checkbox
                      key={entry.id}
                      checked={peers.includes(entry.id)}
                      label={`${entry.name}（${entry.id}）`}
                      onChange={(next) => patch({
                        peers: next ? [...peers, entry.id] : peers.filter((id) => id !== entry.id),
                      })}
                    />
                  ))}
                </div>
              )}
          </div>

          <MenuField
            label="IM bot"
            value={draft?.botId ?? ''}
            options={[
              { id: '', label: '（不绑定）' },
              ...bots.map((bot) => ({
                id: bot.botId,
                label: botLabel(bot),
                short: botShortLabel(bot),
              })),
            ]}
            // The digital human owns its workspace. Binding a bot must not move
            // it; a mismatch is reported for the IM page instead.
            onChange={(value) => patch({ botId: value })}
            hint={bots.length === 0
              ? '还没有 bot。去「设置 → IM机器人」选一个通道，扫码创建。'
              : botWorkspaceNote(boundBot, draft?.workspace)}
          />

          <Checkbox
            checked={draft?.enabled !== false}
            label="启用"
            onChange={(next) => patch({ enabled: next })}
          />
          <Checkbox
            checked={draft?.memory !== false}
            label="持久记忆"
            onChange={(next) => patch({ memory: next })}
          />

          <div className="dh-actions">
            <Button
              variant="primary"
              disabled={busy || !(draft?.id ?? '').trim()}
              onClick={() => act(async () => {
                const current = draft
                if (!current) return '没有可选的数字人'
                const value = await call('registry.save', {
                  id: current.id.trim(),
                  patch: toPatch(current),
                  partial: !creating,
                })
                setDraft((existing) => (existing ? { ...existing, id: value.human.id, creating: false } : existing))
                return `已保存 ${value.human.name}（preset ${value.presetId}）`
              })}
            >
              {creating ? '创建' : '保存'}
            </Button>
            {creating ? null : (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => act(async () => {
                  const current = draft
                  if (!current) return '没有可选的数字人'
                  await call('registry.remove', { id: current.id })
                  setDraft(null)
                  return `已删除 ${current.id}`
                })}
              >
                删除
              </Button>
            )}
            {creating ? null : <Pill>preset：dh-{draft?.id}</Pill>}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Sidebar icon for the panel. */
function DigitalHumansIcon({ size }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx={9} cy={9} r={3} />
      <circle cx={16.5} cy={15.5} r={2.5} />
      <path d="M3.5 19.5c0-2.5 2.4-4.2 5.5-4.2s5.5 1.7 5.5 4.2" />
    </svg>
  )
}

/** The main-column panel: the same page in a full-height container. */
function DigitalHumansPanel({ rpc }: { rpc: RpcCall }) {
  return <div className="dh-panel"><DigitalHumansPage rpc={rpc} /></div>
}

export const inject = ['slots', 'connection']

export function apply(ctx) {
  /** One Host call, with transport failure kept distinct from a refused call. */
  const rpc = async (method, payload, signal) => {
    try {
      return await ctx.connection.rpc.call('/api', RPC_ENDPOINT, { method, payload }, signal)
    } catch (cause) {
      if (signal?.aborted || cause?.name === 'AbortError') throw cause
      throw new Error('无法访问 DSH 管理接口，请检查连接后重试。')
    }
  }

  ctx.effect(() => ctx.slots.inject('settings.section', () => {
    const dispose = ctx.slots.register({
      name: 'settings.section',
      id: PANEL_ID,
      order: 25,
      label: () => '数字人',
      inject: () => ({ rpc }),
    }, DigitalHumansPage)
    return () => dispose()
  }), 'digital-human: settings section')

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => {
    const dispose = ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 20,
      label: () => '数字人',
    }, DigitalHumansIcon)
    return () => dispose()
  }), 'digital-human: sidebar panel entry')

  ctx.effect(() => ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      inject: () => ({ rpc }),
    }, DigitalHumansPanel)
    return () => dispose()
  }), 'digital-human: main panel')
}
