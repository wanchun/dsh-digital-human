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
import { DEFAULT_PERMISSION_PRESET } from './lib/types.js'
import type { ConfigField, Human, HumanPatch, ImBot, SkillSummary, WorkspaceView } from './lib/types.js'
import {
  Button,
  Checkbox,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconFolderCloseRegular,
  IconNewChatOutlineRegular,
  IconUserOutlineRegular,
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
.dh-detail { display: flex; flex-direction: column; gap: 18px; flex: 1 1 320px; min-width: 260px; padding-left: 14px; }
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
.dh-item-icon { width: 14px; height: 14px; border-radius: 50%; object-fit: cover; flex: 0 0 auto; }
.dh-icon-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dh-icon-empty { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dh-icon-input { font-size: 12px; max-width: 220px; }
.dh-session-icon { width: 14px; height: 14px; border-radius: 50%; object-fit: cover; flex: 0 0 auto; }
.dh-icon-preview { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.dh-item-id { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); font-family: ui-monospace, monospace; }
.dh-item-off .dh-item-name, .dh-item-name[data-off="true"] { color: var(--dsw-alias-label-tertiary); }
.dh-section {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px; border-radius: var(--dsw-radius-lg, 10px);
  /* A second level: a record's own settings, not another row of the page. */
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.dh-section-title { font-size: 14px; line-height: 20px; color: var(--dsw-alias-label-primary); margin: 0; font-weight: 600; }
.dh-field { display: flex; flex-direction: column; gap: 6px; }
/* A field name is a heading for its control, so it carries the primary label
   colour and a medium weight. It used to sit one step from the hint in both size
   and colour, which made a name and its explanation read as the same kind of
   text. */
.dh-label { font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary); font-weight: 500; }
/* One field per group, separated by a rule: the page is a long list of unrelated
   controls, and spacing alone did not say where one ended. */
/* Every block is separated the same way, except a card, which carries its own
   border. Matching only the plain field blocks left the pickers and the switches
   without a rule, so some boundaries showed a line and some did not. */
/* Every block is separated by the same rule, cards included. Excluding them left
   their boundary to the card's own box border, so the one place the eye most wants
   a separator — under the large blocks — was the one place it was not drawn. */
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
/* An unchecked skill stays visible but dimmed: the page has to show what exists,
   and a row the record does not enable is still a fact about the deployment. */
.dh-skill { display: flex; flex-direction: column; gap: 1px; }
.dh-skill[data-checked="false"] { opacity: 0.45; }
.dh-skill-desc {
  padding-inline-start: 22px; font-size: 12px; line-height: 17px;
  color: var(--dsw-alias-label-tertiary);
}
/* A repeatable name/value pair. The Input primitive puts className on its
   wrapper span and style on the native input, so the wrapper takes the width and
   the input fills it — the same split Field relies on. No backticks in here: this
   block is a template literal, and one would end it. */
.dh-rows { display: flex; flex-direction: column; gap: 6px; }
.dh-row { display: flex; gap: 6px; align-items: center; }
.dh-row-name { flex: 0 0 34%; min-width: 0; }
.dh-row-value { flex: 1 1 auto; min-width: 0; }
.dh-row-name input, .dh-row-value input { width: 100%; }
.dh-row-remove { flex: 0 0 auto; }
.dh-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.dh-error { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); margin: 0; }
.dh-notice { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-business-primary); margin: 0; }
.dh-hint { font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-tertiary); margin: 0; }
/* A read-only value is content, not chrome: it keeps body size and weight. */
.dh-hint code { font-family: ui-monospace, monospace; font-size: 12px; }
.dh-empty { font-size: 13px; line-height: 19px; color: var(--dsw-alias-label-secondary); padding: 6px 0; margin: 0; }
.dh-warn {
  font-size: 13px; line-height: 19px; color: var(--dsw-alias-label-primary);
  padding: 8px 10px; margin: 0; border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1));
  background: var(--dsw-alias-bg-layer-1);
}
.dh-readonly { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); font-weight: 500; }
.dh-readonly code { font-family: ui-monospace, monospace; font-size: 13px; }
/* The tree is the column: it scrolls inside itself, so the footer stays reachable
   however many requirements there are. The metrics below are the native workspace
   list's own — a 34px project row, a 32px Session row, a 16px icon slot — so the
   column reads as the same surface rather than a second design. */
.dh-tree {
  display: flex; flex-direction: column;
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 4px 8px 12px;
}
.dh-tree-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 4px 4px; }
.dh-tree-title {
  font-size: 12px; line-height: 16px; font-weight: 600; letter-spacing: 0.02em;
  color: var(--dsw-alias-label-tertiary);
}
.dh-tree-link {
  flex: 0 0 auto; border: 0; background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 12px; line-height: 16px;
  padding: 4px 8px; border-radius: var(--dsw-radius-md); cursor: pointer;
}
.dh-tree-link:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dh-tree-link:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
/* The native list's rhythm: sections 4px apart, everything inside one 2px apart. */
.dh-tree-group { display: flex; flex-direction: column; }
.dh-tree-group + .dh-tree-group { margin-top: 4px; }
.dh-tree-group > * + * { margin-top: 2px; }
/* A chat role's two conversation kinds, each under its own small heading. The
   heading is indented to the Session rows' own lead, so it reads as their parent
   rather than as another role. */
.dh-tree-subgroup { display: flex; flex-direction: column; }
.dh-tree-subgroup + .dh-tree-subgroup { margin-top: 4px; }
.dh-tree-subgroup > * + * { margin-top: 2px; }
.dh-tree-subtitle {
  margin: 0; padding: 2px 8px 2px 40px;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary);
}
/* The native project row: 34px, one line of primary text, a folder glyph. */
.dh-tree-summary {
  display: flex; align-items: center; gap: 6px;
  box-sizing: border-box; height: 34px; padding: 0 8px; margin: 0;
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-primary);
  font-size: 14px; line-height: 20px;
  list-style: none; cursor: pointer; user-select: none;
}
.dh-tree-summary::-webkit-details-marker { display: none; }
.dh-tree-summary:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dh-tree-summary:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
/* The disclosure arrow the native list animates; it turns a quarter on open. */
.dh-tree-chevron {
  display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center;
  width: 16px; height: 20px; color: var(--dsw-alias-label-tertiary);
  transition: transform 0.15s var(--ds-ease-in-out, ease-in-out);
}
.dh-tree-group[open] > .dh-tree-summary .dh-tree-chevron { transform: rotate(90deg); }
/* One icon slot for every node, so a folder, a role mark and a chat glyph share a
   left edge and a baseline — the same rule the native list follows. */
.dh-tree-icon {
  display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center;
  width: 16px; height: 20px; color: var(--dsw-alias-label-tertiary);
}
.dh-tree-icon img { width: 16px; height: 16px; border-radius: 50%; object-fit: cover; }
.dh-tree-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The native Session row: 32px, no gap, one indent level (12px) in from the group
   row, and the title carrying its own 4px lead — the same numbers the native list
   uses for a nested row. */
.dh-tree-row {
  display: flex; align-items: center; gap: 0;
  box-sizing: border-box; width: 100%; height: 32px; padding: 0 8px;
  padding-inline-start: 40px;
  border: 0; border-radius: var(--dsw-radius-md); background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 14px; line-height: 20px; text-align: left;
  cursor: pointer; user-select: none;
}
.dh-tree-row .dh-tree-label { flex: 1; margin: 0 6px 0 4px; }
/* The running mark the native row carries: one 16px spinner, centered on the same
   line as the label and gone when the turn ends. It is the row's last child, so
   the role mark keeps the column's left edge. */
.dh-tree-running {
  display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center;
  width: 16px; height: 16px;
}
.dh-tree-row:hover, .dh-tree-row[data-current="true"] { background: var(--dsw-alias-interactive-bg-hover); }
.dh-tree-row:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
.dh-tree-hint { margin: 0; padding: 4px 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dh-tree-error {
  display: flex; flex-direction: column; gap: 8px; margin: 4px 0; padding: 8px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1);
}
.dh-tree-error-text { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.dh-tree-actions { display: flex; gap: 8px; flex-wrap: wrap; }
/* The view switch inside the sidebar's "more" menu, built to the menu's own row
   metrics (34px, 6/8 padding, 13px text) so it sits among the shipped rows. */
.dh-menu-item-wrap { position: relative; }
.dh-menu-item {
  display: flex; align-items: center; gap: 6px; width: 100%;
  min-height: 34px; padding: 6px 8px; border: 0;
  border-radius: var(--dsw-radius-md); background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 20px; text-align: left;
  cursor: pointer;
}
.dh-menu-item:hover, .dh-menu-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.dh-menu-item-icon {
  display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center;
  width: 16px; height: 16px; color: var(--dsw-alias-menu-icon, var(--dsw-alias-label-tertiary));
}
.dh-menu-item-icon svg { width: 16px; height: 16px; }
.dh-menu-item-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

/** One editable name/value pair of a digital human's config. */
interface ConfigRow {
  name: string
  value: string
}

/** The editable form state for one record. */
interface Draft {
  id: string
  name: string
  description: string
  systemPrompt: string
  config: ConfigRow[]
  workspace: string
  skills: string[]
  peers: string[]
  botId: string
  owner: string
  permissionPreset: string
  sessionMode: 'thread' | 'single'
  icon: string
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

/**
 * Fold the edited rows back into the config map.
 *
 * A half-typed row is dropped rather than stored: the store treats an empty
 * value as "not configured", and a row with no name has nothing to key on.
 */
function configFromRows(rows: ConfigRow[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows ?? []) {
    const name = row.name.trim()
    const value = row.value.trim()
    if (name && value) out[name] = value
  }
  return out
}

/**
 * The declared config fields, one control per field.
 *
 * The record's schema decides the control and whether the operator may type at
 * all: a field the platform already knows — the bot's own name, the owner's
 * address — is shown read-only, because there is nothing to fill in.
 *
 * Every control holds what the operator set, and nothing else. The effective value
 * is the Host's to resolve, and it is deliberately not echoed here: this page
 * edits choices, so showing a resolved value next to an empty input invites the
 * operator to read a default as something they chose.
 */
function SchemaFields({ schema, rows, onChange }: {
  schema: ConfigField[]
  rows: ConfigRow[]
  onChange: (rows: ConfigRow[]) => void
}) {
  const valueOf = (key: string) => rows.find((row) => row.name === key)?.value ?? ''
  const setValue = (key: string, value: string) => {
    const at = rows.findIndex((row) => row.name === key)
    if (at === -1) {
      if (value) onChange([...rows, { name: key, value }])
      return
    }
    onChange(rows.map((row, index) => (index === at ? { ...row, value } : row)))
  }
  // The declaration decides what the form shows. A hidden field still resolves and
  // still reaches the prompt; it is only absent from here, because the operator has
  // no reason to look at it.
  const shown = schema.filter((field) => field.hidden !== true)
  // A key the declaration does not carry is invisible to the fields above, yet the
  // save keeps sending it — so it would round-trip forever with no way to drop it.
  const declared = new Set(schema.map((field) => field.key))
  const undeclared = rows.filter((row) => row.name !== '' && !declared.has(row.name))
  return (
    // A bordered box, because the declared fields are a second level: they belong to
    // the record rather than sitting beside it, and the page is otherwise a flat list.
    <div className="dh-section">
      <span className="dh-section-title">配置</span>
      {shown.map((field) => {
        const label = field.label || field.key
        if (field.from) {
          return (
            <div className="dh-field" key={field.key}>
              <span className="dh-label">{label}</span>
              <span className="dh-hint">
                平台自动提供，不用填。{field.description ?? ''}
              </span>
            </div>
          )
        }
        if (field.type === 'boolean') {
          return (
            <Checkbox
              key={field.key}
              checked={valueOf(field.key) === 'true'}
              label={label}
              onChange={(next) => setValue(field.key, next ? 'true' : '')}
            />
          )
        }
        if (field.type === 'number') {
          return (
            <Field
              key={field.key}
              label={label}
              value={valueOf(field.key)}
              inputType="number"
              hint={field.description}
              onChange={(next) => setValue(field.key, next)}
            />
          )
        }
        if (field.type === 'select') {
          return (
            <MenuField
              key={field.key}
              label={label}
              value={valueOf(field.key)}
              options={[
                { id: '', label: '（未设置）' },
                ...(field.options ?? []).map((option) => ({ id: option.value, label: option.label })),
              ]}
              onChange={(next) => setValue(field.key, next)}
              hint={field.description}
            />
          )
        }
        return (
          <Field
            key={field.key}
            label={label}
            value={valueOf(field.key)}
            onChange={(next) => setValue(field.key, next)}
            hint={field.description}
          />
        )
      })}
      {undeclared.length > 0 ? (
        <div className="dh-field">
          <span className="dh-hint">未声明</span>
          {undeclared.map((row) => (
            <div className="dh-row" key={`undeclared-${row.name}`}>
              <span className="dh-row-name">{row.name}</span>
              <span className="dh-row-value">{row.value}</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`移除未声明的配置项 ${row.name}`}
                onClick={() => onChange(rows.filter((entry) => entry.name !== row.name))}
              >
                移除
              </Button>
            </div>
          ))}
          <span className="dh-hint">这些键不在记录的声明里，宿主解析时会忽略它们；保存仍会原样带回，所以留在这里可以移除。</span>
        </div>
      ) : null}
    </div>
  )
}

/**
 * One labelled repeatable name/value editor.
 *
 * A persona names its own config keys, so the form has no schema to lay out —
 * the operator adds the pairs the persona asks for. This replaces a plain
 * textarea: a `name=value` line is easy to mistype and gives no feedback about
 * which half is missing.
 */
function ConfigField({ rows, onChange, hint }: {
  rows: ConfigRow[]
  onChange: (rows: ConfigRow[]) => void
  hint?: string
}) {
  const setAt = (index: number, patch: Partial<ConfigRow>) => {
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  }
  return (
    <div className="dh-section">
      <span className="dh-section-title">配置</span>
      {rows.length === 0
        ? <p className="dh-empty">还没有配置项。未配置的项由宿主按人设自己的规则处理。</p>
        : (
          <div className="dh-rows">
            {rows.map((row, index) => (
              // Index keys are correct here: a row is identified by its position
              // until it is saved, and the name is what the operator is typing.
              <div className="dh-row" key={index}>
                <Input
                  className="dh-row-name"
                  placeholder="名称"
                  value={row.name}
                  onChange={(event) => setAt(index, { name: event.target.value })}
                />
                <Input
                  className="dh-row-value"
                  placeholder="值"
                  value={row.value}
                  onChange={(event) => setAt(index, { value: event.target.value })}
                />
                <Button
                  className="dh-row-remove"
                  variant="ghost"
                  size="sm"
                  aria-label={`删除配置项 ${index + 1}`}
                  onClick={() => onChange(rows.filter((_, at) => at !== index))}
                >
                  删除
                </Button>
              </div>
            ))}
          </div>
        )}
      <div className="dh-actions">
        <Button variant="outline" size="sm" onClick={() => onChange([...rows, { name: '', value: '' }])}>
          添加一项
        </Button>
      </div>
      {hint ? <span className="dh-hint">{hint}</span> : null}
    </div>
  )
}

/**
 * The owner is claimed, never typed, so this page only reports it.
 *
 * The WeCom channel sends no display name, so the claimed value is an opaque
 * sender id — which is exactly why the field is read-only: nobody could type it.
 */

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
  config: [],
  workspace: '',
  skills: [],
  peers: [],
  botId: '',
  owner: '',
  permissionPreset: DEFAULT_PERMISSION_PRESET,
  sessionMode: 'thread',
  icon: '',
  enabled: true,
  memory: true,
  creating: false,
}

/** Form state for a stored record. */
function toDraft(human: Human): Draft {
  return {
    id: human.id,
    name: human.name,
    // Every string is defaulted: `toPatch` trims them, and a record that arrived
    // without one would throw inside the save instead of saving.
    description: human.description ?? '',
    systemPrompt: human.systemPrompt ?? '',
    config: Object.entries(human.config ?? {}).map(([name, value]) => ({ name, value })),
    workspace: human.workspace ?? '',
    skills: [...(human.skills ?? [])],
    peers: [...(human.peers ?? [])],
    botId: human.im?.botId ?? '',
    owner: human.im?.owner ?? '',
    permissionPreset: human.permissionPreset ?? DEFAULT_PERMISSION_PRESET,
    sessionMode: human.sessionMode === 'single' ? 'single' : 'thread',
    icon: human.icon ?? '',
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
    config: configFromRows(draft.config),
    workspace: draft.workspace.trim(),
    skills: draft.skills ?? [],
    peers: draft.peers ?? [],
    // `targetId` is deliberately absent. The host merges this patch over the stored
    // record, so an omitted key keeps its value — while sending `''` would erase a
    // target the page cannot even show, and that target is what `notify_bot`
    // defaults to.
    im: { botId: draft.botId.trim(), owner: draft.owner.trim() },
    permissionPreset: draft.permissionPreset,
    sessionMode: draft.sessionMode,
    icon: draft.icon,
    enabled: draft.enabled,
    memory: draft.memory,
  }
}

/** One labelled single-line field. */
function Field({ label, value, onChange, hint, mono, disabled, inputType }: {
  label: string
  value?: string
  onChange: (value: string) => void
  hint?: string
  mono?: boolean
  disabled?: boolean
  /** The native input type; a declared `number` field uses it for the keypad. */
  inputType?: string
}) {
  return (
    <label className="dh-field">
      <span className="dh-label">{label}</span>
      <Input
        style={{ width: '100%', ...(mono ? { fontFamily: 'ui-monospace, monospace' } : {}) }}
        value={value ?? ''}
        disabled={disabled === true}
        type={inputType}
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
  // A stored value the list does not carry must still be visible: showing the
  // placeholder would tell the operator the field is unset while it is set.
  const outside = value !== '' && !current ? value : undefined
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
        // Portaled, because the panel scrolls and would clip a menu opened near the
        // bottom of the form.
        portal
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
              {current
                ? (current.short ?? current.label)
                : (outside ? `${outside}（不在选项中）` : (placeholder ?? '请选择'))}
            </span>
          </Button>
        )}
      />
      {hint ? <span className="dh-hint">{hint}</span> : null}
    </div>
  )
}

/**
 * One record as this page receives it: the stored record plus the config its
 * persona will actually see. The resolution happens on the Host, so the page
 * never reimplements the precedence rules.
 */
type HumanView = Human & {
  /** The effective value of each declared field, resolved by the Host. */
  resolved?: { values: Record<string, string>; sources: Record<string, string> }
  /** The last push onto this record's bound bot, one entry per endpoint. */
  alignment?: Array<{ endpoint?: string; ok?: boolean; reason?: string }>
  /** The preset id the Host actually registered, which may be absent. */
  presetId?: string
}

/** The configuration page: list on the left, the selected record on the right. */
function DigitalHumansPage({ rpc }: { rpc: RpcCall }) {
  const [phase, setPhase] = React.useState('loading')
  const [humans, setHumans] = React.useState<HumanView[]>([])
  const [file, setFile] = React.useState<string>('')
  const [draft, setDraft] = React.useState<Draft | null>(null)
  const [bots, setBots] = React.useState<ImBot[]>([])
  // One entry per side load that failed, so the page can say "could not read"
  // instead of claiming the profile is empty.
  const [sideErrors, setSideErrors] = React.useState<{
    bots?: string
    skills?: string
  }>({})
  // The platform's own permission roster, so a renamed or newly contributed preset
  // needs no release here. Empty until the Host answers.
  const [permissionChoices, setPermissionChoices] = React.useState<Array<{ value: string; label: string; description: string }>>([])
  /** Whether the delete button has been armed by a first click. */
  const [confirmingDelete, setConfirmingDelete] = React.useState(false)
  // Every skill installed in the global root. A record's list is a subset of it.
  const [skills, setSkills] = React.useState<SkillSummary[]>([])
  const importRef = React.useRef<HTMLInputElement | null>(null)
  // Always this exact shape. The Host returns `workspaces`; reading a
  // differently named field during render once blanked the whole panel.
  const [workspaces, setWorkspaces] = React.useState<{ items: WorkspaceView[]; defaultTitle: string; defaultPath: string | null }>({ items: [], defaultTitle: '数字人', defaultPath: null })
  const [error, setError] = React.useState<string | null>(null)
  const [iconError, setIconError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<boolean>(false)
  const mounted = React.useRef<boolean>(true)

  React.useEffect(() => {
    // Set on mount as well as cleared on unmount: a remount of the same fiber would
    // otherwise stay "unmounted" and drop every later update.
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
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
    invalidateSessionIcons()
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
      // Coerced, because a Host answer that omits the list must not take the page
      // down: `bots.map` runs on every render.
      .then((value) => { if (!controller.signal.aborted && mounted.current) setBots(Array.isArray(value?.bots) ? value.bots : []) })
      // Recorded rather than swallowed: an empty list and a failed load look
      // identical on screen, and only one of them is the operator's to fix.
      .catch((caught) => {
        if (controller.signal.aborted || !mounted.current) return
        setSideErrors((current) => ({ ...current, bots: String(caught?.message ?? caught) }))
      })
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
      // Nothing on the page shows a roster failure: the Workspace line only uses
      // the default title. Swallow it instead of keeping a write-only error field.
      .catch(() => {})
    return () => controller.abort()
  }, [call])

  React.useEffect(() => {
    const controller = new AbortController()
    call('permissions.list', {}, controller.signal)
      .then((value) => {
        if (controller.signal.aborted || !mounted.current) return
        setPermissionChoices(Array.isArray(value?.presets) ? value.presets : [])
      })
      .catch(() => {})
    return () => controller.abort()
  }, [call])

  React.useEffect(() => {
    const controller = new AbortController()
    call('skills.catalog', {}, controller.signal)
      .then((value) => { if (!controller.signal.aborted && mounted.current) setSkills(Array.isArray(value?.skills) ? value.skills : []) })
      .catch((caught) => {
        if (controller.signal.aborted || !mounted.current) return
        setSideErrors((current) => ({ ...current, skills: String(caught?.message ?? caught) }))
      })
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

  /**
   * Download one digital human as a bundle.
   *
   * A plain navigation, so the browser saves the file itself: routing a package
   * through the JSON channel would base64 it and hold it twice, and a skill set can
   * be tens of megabytes.
   */
  /**
   * Download every enabled digital human as one bundle.
   *
   * The whole registry, not the selected record: a bundle carries one or many, so the
   * page has a single export that is also the backup. The id travels as a query
   * parameter because the route table matches an exact pathname.
   */
  const exportAll = () => {
    window.open('/api/digital-human/bundle?all=1&memory=1', '_blank')
  }

  /** Read one bundle into the registry. */
  const importHuman = async (picked: FileList | null) => {
    const file = [...(picked ?? [])][0]
    if (!file) return
    await act(async () => {
      const response = await fetch('/api/digital-human/bundle', {
        method: 'POST',
        credentials: 'same-origin',
        body: file,
      })
      const answer = await response.json().catch(() => undefined)
      if (answer?.ok !== true) throw new Error(answer?.error?.message ?? '导入失败：宿主没有返回可读的结果')
      const value = answer.value ?? {}
      const ids = Array.isArray(value.ids) ? value.ids : []
      return `已导入 ${ids.length} 个数字人（${ids.join('、')}）${value.memory ? '，含记忆' : ''}`
    })
    if (importRef.current) importRef.current.value = ''
  }

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
  const unlisted = chosen.filter((name) => !catalog.includes(name))
  // Every installed skill is offered, checked or not: the page's job is to show
  // what exists, so a skill the record does not enable is a dimmed row, not a
  // missing one. A name the record carries but the root does not is listed too, so
  // it stays visible and can be unchecked.
  const skillRows = [
    ...skills,
    ...unlisted.map((name) => ({ name, description: '这个技能当前不在全局技能目录里。' })),
  ]
  // The schema is authored in the record, not edited here, so it is read from the
  // loaded list rather than carried in the draft.
  const selected: HumanView | undefined = humans.find((entry) => entry.id === draft?.id)
  const selectedSchema: ConfigField[] = selected?.configSchema ?? []
  // The preset id comes from the Host, which is the only side that knows whether
  // the registration actually succeeded. Rebuilding `dh-{id}` here would assert a
  // preset that may not exist.
  const selectedPresetId = selected?.presetId ?? ''
  // A failed push leaves the bot without its workspace, preset or source block, and
  // nothing else on this page would say so.
  const failedAlignment = (selected?.alignment ?? []).filter((entry) => entry.ok !== true)
  const boundBot = bots.find((entry) => entry.botId === draft?.botId)

  /** Read one icon file into a data URI the registry will accept. */
  const chooseIcon = (file: File | undefined) => {
    if (!file) return
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
    if (!allowed.includes(file.type)) {
      setIconError('只支持 png、jpeg、webp、svg')
      return
    }
    // The record stores the data URI, and the registry caps it at 64KB; base64 adds
    // about a third, so the file itself has to stay under 48KB.
    if (file.size > 48 * 1024) {
      setIconError('图片不能超过 48KB（编码后约 64KB）')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const uri = typeof reader.result === 'string' ? reader.result : ''
      if (!uri.startsWith('data:image/') || uri.length > 64 * 1024) {
        setIconError('图片读取失败或编码后超过 64KB')
        return
      }
      setIconError(null)
      patch({ icon: uri })
    }
    reader.onerror = () => setIconError('图片读取失败')
    reader.readAsDataURL(file)
  }

  return (
    <div className="dh-root">
      <div className="dh-head">
        <h3 className="dh-title">数字人（{humans.length}）</h3>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || humans.length === 0}
          onClick={exportAll}
        >
          导出全部
        </Button>
        <input
          ref={importRef}
          type="file"
          accept=".gz,.tgz,application/gzip"
          style={{ display: 'none' }}
          onChange={(event) => { void importHuman(event.target.files) }}
        />
        <Button variant="outline" size="sm" disabled={busy} onClick={() => importRef.current?.click()}>
          导入
        </Button>
        <Button
          size="sm"
          style={{ marginLeft: 'auto' }}
          disabled={busy}
          onClick={() => {
            setNotice(null)
            setError(null)
            setConfirmingDelete(false)
            // A new record starts with every global skill enabled: the operator
            // unchecks what this role must not use, instead of hunting for what it needs.
            setDraft({ ...BLANK, creating: true, skills: skills.map((entry) => entry.name) })
          }}
        >
          新建
        </Button>
        <Button size="sm" disabled={busy} onClick={() => act(async () => { await load(); return '已刷新' })}>
          刷新
        </Button>
      </div>

      {file ? <p className="dh-meta">注册表目录：{file}</p> : null}
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
                onClick={() => { setNotice(null); setError(null); setConfirmingDelete(false); setDraft(toDraft(entry)) }}
              >
                <span className="dh-item-name" data-off={entry.enabled ? 'false' : 'true'}>
                  {entry.icon ? <img className="dh-item-icon" src={entry.icon} alt="" width={14} height={14} /> : null}
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

          <div className="dh-field">
            <span className="dh-label">图标</span>
            <div className="dh-icon-row">
              {draft?.icon
                ? <img className="dh-icon-preview" src={draft.icon} alt="图标预览" />
                : <span className="dh-icon-empty">未配置</span>}
              <input
                className="dh-icon-input"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                onChange={(event) => { chooseIcon(event.target.files?.[0]); event.target.value = '' }}
              />
              {draft?.icon
                ? (
                  <Button size="sm" onClick={() => { setIconError(null); patch({ icon: '' }) }}>
                    清除
                  </Button>
                )
                : null}
            </div>
            <span className="dh-hint">
              支持 png / jpeg / webp / svg，最大 48KB；只随记录保存在本机，不请求外部地址。没有图标就不显示。
            </span>
            {iconError ? <p className="dh-error" role="alert">{iconError}</p> : null}
          </div>

          <label className="dh-field">
            <span className="dh-label">人设</span>
            <textarea
              className="dh-area"
              value={draft?.systemPrompt ?? ''}
              onChange={(event) => patch({ systemPrompt: event.target.value })}
            />
          </label>

          {selectedSchema.length > 0
            ? (
              <SchemaFields
                schema={selectedSchema}
                rows={draft?.config ?? []}
                onChange={(rows) => patch({ config: rows })}
              />
            )
            : (
              <ConfigField
                rows={draft?.config ?? []}
                onChange={(rows) => patch({ config: rows })}
                hint={'人设里写 {{名称}} 会被替换成这里的值，实际值同时注入提示词。这条记录还没有声明字段，所以按名称/值手填。'}
              />
            )}

          {/* One workspace for the whole platform: a digital human is a role, not a
              place, so there is nothing to pick here. */}
          <div className="dh-field">
            <span className="dh-label">工作区</span>
            <div className="dh-hint">所有数字人都在「{workspaces.defaultTitle}」工作区里运行，不可更改。</div>
          </div>

          <div className="dh-section">
            <span className="dh-section-title">技能</span>
            {skillRows.length === 0
              ? (
                <p className="dh-empty">
                  {sideErrors.skills
                    ? `技能目录读取失败：${sideErrors.skills}`
                    : '全局技能目录里没有技能。把技能放进 ~/.agents/skills/<名字>/SKILL.md，再刷新。'}
                </p>
              )
              : (
                <div className="dh-choices">
                  {skillRows.map((entry) => {
                    const checked = chosen.includes(entry.name)
                    return (
                      // An unchecked row is dimmed rather than dropped: the page shows
                      // what exists, and a grey row is what "not enabled here" looks like.
                      <div className="dh-skill" key={entry.name} data-checked={checked ? 'true' : 'false'}>
                        <Checkbox
                          checked={checked}
                          label={entry.name}
                          title={entry.description || entry.name}
                          onChange={(next) => patch({
                            skills: next ? [...chosen, entry.name] : chosen.filter((name) => name !== entry.name),
                          })}
                        />
                        {entry.description ? <span className="dh-skill-desc">{entry.description}</span> : null}
                      </div>
                    )
                  })}
                </div>
              )}
            {sideErrors.skills
              ? null
              : (
                <span className="dh-hint">
                  勾选即启用：这个数字人只加载勾选的技能，未勾选的在本数字人里不可见。新建记录默认勾选全部。
                </span>
              )}
            {unlisted.length > 0
              ? (
                <span className="dh-hint">
                  {`已勾选但全局技能目录里没有的：${unlisted.join('、')}。这些不会被加载 —— 把技能放进去，或者从勾选里去掉。`}
                </span>
              )
              : null}
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
            key={`bot-${draft?.id ?? 'new'}`}
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
              ? (sideErrors.bots
                ? `bot 列表读取失败：${sideErrors.bots}`
                : '还没有 bot。去「设置 → IM机器人」选一个通道，扫码创建。')
              : botWorkspaceNote(boundBot, draft?.workspace)}
          />

          {/* Read-only on purpose. The first person to write to the bot is the
              owner by the same reasoning Halo uses: a fresh bot is visible only
              to its creator. Nobody has to know an opaque sender id, and the
              plugin already reads it out of the IM state. */}
          <div className="dh-field">
            <span className="dh-label">负责人</span>
            <span className="dh-readonly">
              {draft?.owner
                ? <code>{draft.owner}</code>
                : '还没认领 —— 第一个私聊该 bot 的人自动成为负责人。'}
            </span>
            <span className="dh-hint">
              自动认领，不用填。通道不传显示名时，这里就是不透明的 senderId。
            </span>
          </div>

          {failedAlignment.length > 0 ? (
            <p className="dh-warn" role="status">
              {`有 ${failedAlignment.length} 项没有推送到绑定的 bot：`
                + failedAlignment.map((entry) => `${entry.endpoint ?? '未知端点'}（${entry.reason ?? '未知原因'}）`).join('、')
                + '。bot 可能缺工作区、预设或来源块，重启或重新保存会再试一次。'}
            </p>
          ) : null}

          <MenuField
            key={`session-mode-${draft?.id ?? 'new'}`}
            label="会话模式"
            value={draft?.sessionMode ?? 'thread'}
            options={[
              { id: 'thread', label: '按线程 —— 每个线程标识一条会话，消息插话进入' },
              { id: 'single', label: '共享一条 —— 所有派活进同一条会话，任务排队' },
            ]}
            onChange={(value) => patch({ sessionMode: value === 'single' ? 'single' : 'thread' })}
            hint="共享一条适合自测类助手：一条常驻会话，后到的任务等当前回合结束再处理。"
          />

          <MenuField
            key={`permission-${draft?.id ?? 'new'}`}
            label="权限预设"
            value={draft?.permissionPreset ?? ''}
            options={[
              ...permissionChoices.map((choice) => ({
                id: choice.value,
                label: choice.description ? `${choice.label} —— ${choice.description}` : choice.label,
              })),
            ]}
            onChange={(value) => patch({ permissionPreset: value })}
            hint="只作用于这个数字人自己的会话。IM 里没有人工应答批准，选一个需要批准的预设会让它卡住。"
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
                // Keep the list in step with what was just stored: a create adds a row
                // and a rename must show the new name without a reload.
                const saved = { ...value.human, presetId: value.presetId }
                setHumans((existing) => {
                  const at = existing.findIndex((entry) => entry.id === saved.id)
                  if (at === -1) return [...existing, saved]
                  return existing.map((entry, index) => (index === at ? saved : entry))
                })
                invalidateSessionIcons()
                if (mounted.current) {
                  setDraft((existing) => (existing ? { ...existing, id: value.human.id, creating: false } : existing))
                }
                return `已保存 ${value.human.name}（preset ${value.presetId}）`
              })}
            >
              {creating ? '创建' : '保存'}
            </Button>
            {creating ? null : (
              <Button
                variant="outline"
                disabled={busy}
                // Two steps: this also drops the record's agent preset, and the
                // button sits beside 保存, so one stray click is too cheap.
                onClick={() => {
                  if (!confirmingDelete) {
                    setConfirmingDelete(true)
                    return
                  }
                  void act(async () => {
                  const current = draft
                  if (!current) return '没有可选的数字人'
                  await call('registry.remove', { id: current.id })
                  // Dropping only the draft left the deleted row in the list until a reload.
                  if (mounted.current) {
                    setHumans((existing) => existing.filter((entry) => entry.id !== current.id))
                    invalidateSessionIcons()
                    setDraft(null)
                  }
                  return `已删除 ${current.id}`
                  })
                }}
              >
                {confirmingDelete ? '确认删除' : '删除'}
              </Button>
            )}
            {creating ? null : <Pill>{selectedPresetId ? `preset：${selectedPresetId}` : 'preset：未注册'}</Pill>}
          </div>
        </div>
      </div>
    </div>
  )
}

/** One entry per Session: its digital human's icon, or null once resolved. */
const sessionIconCache = new Map<string, string | null>()
const sessionIconFlights = new Map<string, Promise<void>>()
const sessionIconListeners = new Set<() => void>()
let sessionIconEpoch = 0

function notifySessionIcons() {
  for (const listener of [...sessionIconListeners]) listener()
}

/** Drop every resolved icon so the next render asks again (after a record changes). */
function invalidateSessionIcons() {
  sessionIconCache.clear()
  sessionIconEpoch += 1
  notifySessionIcons()
}

function useSessionIcon(rpc: RpcCall, sessionId?: string) {
  const [icon, setIcon] = React.useState<string | null>(sessionId ? sessionIconCache.get(sessionId) ?? null : null)
  const [epoch, setEpoch] = React.useState(sessionIconEpoch)
  React.useEffect(() => {
    let live = true
    const update = () => {
      if (!live) return
      setIcon(sessionId ? sessionIconCache.get(sessionId) ?? null : null)
      setEpoch(sessionIconEpoch)
    }
    sessionIconListeners.add(update)
    return () => {
      live = false
      sessionIconListeners.delete(update)
    }
  }, [sessionId])
  React.useEffect(() => {
    if (!sessionId || sessionIconCache.has(sessionId) || sessionIconFlights.has(sessionId)) return
    const flight = rpc('registry.sessionIcon', { sessionId })
      .then((result) => {
        sessionIconCache.set(sessionId, result?.ok === true ? result.value?.icon ?? null : null)
      })
      .catch(() => { sessionIconCache.set(sessionId, null) })
      .finally(() => {
        sessionIconFlights.delete(sessionId)
        notifySessionIcons()
      })
    sessionIconFlights.set(sessionId, flight)
  }, [rpc, sessionId, epoch])
  return icon
}

/** The leading mark on one session row: its digital human's icon, or nothing. */
function SessionRowIcon({ sessionId, rpc }: { sessionId?: string; rpc: RpcCall }) {
  const icon = useSessionIcon(rpc, sessionId)
  if (!icon) return null
  return <img className="dh-session-icon" src={icon} alt="" width={14} height={14} />
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

/** Which column the sidebar shows; remembered so a reload keeps the choice. */
const VIEW_KEY = 'dh.sidebar.view'
/** The Host caller, set by apply(); a slot face is not guaranteed to carry it. */
let hostRpc: RpcCall | null = null
/** Whether the tree is the chosen column. A host without storage shows the native list. */
const wantsTree = () => {
  try { return localStorage.getItem(VIEW_KEY) === 'tree' } catch { return false }
}
/** Remember the chosen column; a host without storage keeps the one it has. */
const rememberTree = (on: boolean) => {
  try { localStorage.setItem(VIEW_KEY, on ? 'tree' : 'native') } catch { /* no storage, no memory */ }
}

/** One Session behind a requirement or a chat. */
interface TreeRow {
  /** The role's name for a requirement row, the chat's name for a chat row. */
  label: string
  sessionId: string
  /** The role's own position; smaller comes first, ties keep the record order. */
  order: number
  /** The role's own mark, a data URI; the row falls back to a neutral icon. */
  icon?: string
}

/** One digital human as `tree.read` reports it. */
interface TreeHuman {
  humanId: string
  name: string
  description?: string
  /** The role's own mark, a data URI the row renders instead of the neutral icon. */
  icon?: string
  /** Sidebar position of this role; smaller comes first. No role is named in code. */
  order?: number
  /** What this role's Sessions are keyed by: a chat, or a requirement thread. */
  sessionKey?: string
  requirements?: Array<{
    /** The Session key; the requirement menu never shows it. */
    conversation?: string
    /** Directory name under `reqs/`, read from the directory's `meta.json`. */
    dir?: string
    /** Requirement name the menu shows; falls back to the thread name. */
    name?: string
    /**
     * Phase derived from the requirement's nodes. Absent on a chat-keyed row: a
     * chat has no nodes, so the Host has nothing to derive it from.
     */
    phase?: string
    sessions?: Array<{ sessionId?: string }>
  }>
}

/** One subheading inside a chat role: the personal chats or the group chats. */
interface TreeGroup {
  key: 'personal' | 'group'
  /** Chinese label the operator reads. */
  title: string
  rows: TreeRow[]
}

/** One menu in the column: a chat-keyed role's Sessions, or one requirement's. */
interface TreeSection {
  /** Stable key: the role id for a chat, the thread name for a requirement. */
  key: string
  title: string
  /** A chat-keyed role reads as an entry; a requirement reads as a folder. */
  kind: 'chat' | 'requirement'
  rows: TreeRow[]
  /** Chat sections split their rows into 个人 and 群聊; requirements have none. */
  groups?: TreeGroup[]
}

/** One session row inside a requirement menu. */
function TreeSession({ label, sessionId, icon, current, running, openSession }: {
  label: string
  sessionId: string
  /** The role's own mark; the row falls back to a neutral Session icon. */
  icon?: string
  /** Whether the main column is showing this Session. */
  current?: boolean
  /** Whether the Session is working right now, as the native row reports it. */
  running?: boolean
  openSession: (sessionId: string) => void
}) {
  return (
    <button
      type="button"
      className="dh-tree-row"
      data-current={current === true ? 'true' : undefined}
      aria-current={current === true ? 'true' : undefined}
      onClick={() => openSession(sessionId)}
      title={sessionId}
    >
      {/* The record's own mark when it has one, so the tree reads like the native
          list; otherwise a neutral Session glyph. */}
      <span className="dh-tree-icon">
        {icon ? <img src={icon} alt="" width={16} height={16} /> : <IconNewChatOutlineRegular size={16} />}
      </span>
      <span className="dh-tree-label">{label}</span>
      {/* The same 16px spinner the native row shows while a turn runs. It sits at
          the row's end, so the role mark keeps the column's left edge. */}
      {running === true ? (
        <span className="dh-tree-running" role="img" aria-label="运行中">
          <StateDot state="ongoing" size={16} />
        </span>
      ) : null}
    </button>
  )
}

/**
 * The Session ids the Workspace catalog lists right now.
 *
 * The tree reads its rows from the digital-human index, and that index outlives a
 * Session: a Session removed outside the platform leaves its address behind, and
 * clicking the stale row clears the main area. `null` means "no authoritative
 * catalog yet", so the tree keeps what it has instead of hiding everything.
 */
function liveSessionIds(workspace: any): Set<string> | null {
  const snapshot = workspace?.sessions?.list?.getSnapshot?.()
  if (!snapshot || snapshot.phase === 'pending' || !Array.isArray(snapshot.ids)) return null
  return new Set(snapshot.ids)
}

/**
 * The Sessions the runtime reports as running right now.
 *
 * Two sources are read because a host may register either one: the Session status
 * store is the same one the native row draws its spinner from, and the Workspace
 * catalog carries `running` on every row. The union is what the tree shows.
 */
function runningSessionIds(status: any, workspace: any): Set<string> {
  const found = new Set<string>()
  const snapshot = status?.getSnapshot?.()
  if (snapshot && typeof snapshot.forEach === 'function') {
    snapshot.forEach((entry: any, sessionId: string) => {
      if (entry?.running === true) found.add(sessionId)
    })
  }
  const byId = workspace?.sessions?.list?.getSnapshot?.()?.byId
  for (const [sessionId, row] of Object.entries(byId ?? {})) {
    if ((row as any)?.running === true) found.add(sessionId)
  }
  return found
}

/**
 * The digital-human column: chat-keyed roles first, then one menu per requirement.
 *
 * The tree is read whole from the Host; nothing here holds its own state. A
 * requirement is the conversation a Session was filed under, and the rows inside
 * it are ordered by the role's own `order`, so adding or reordering a role needs
 * no change here. Chat-keyed roles are their own sections because a chat is not a
 * requirement. Clicking a row only selects that Session; the conversation pane
 * never changes.
 */
function DigitalHumansTree({ rpc: injected, openSession, onClose, getWorkspace, getSessionStatus }: {
  rpc?: RpcCall
  openSession?: (sessionId: string) => void
  onClose?: () => void
  /** The workspace service, read lazily: it may register after this plugin. */
  getWorkspace?: () => any
  /** The Session runtime status store, read lazily for the same reason. */
  getSessionStatus?: () => any
}) {
  const rpc = injected ?? hostRpc
  const [state, setState] = React.useState<{ loading: boolean; error: string; humans: TreeHuman[] }>({
    loading: true,
    error: '',
    humans: [],
  })
  const [current, setCurrent] = React.useState<string | undefined>(undefined)

  const load = React.useCallback(async () => {
    // A face that lost its caller cannot read anything. Say so instead of showing
    // an empty tree, which would read as "no requirements".
    if (typeof rpc !== 'function') {
      console.warn('[digital-human] the tree has no Host caller:', typeof rpc)
      setState({ loading: false, error: '没有拿到 Host 调用器', humans: [] })
      return
    }
    setState((value) => ({ ...value, loading: true, error: '' }))
    try {
      // The caller returns the Connection envelope, not the value: a refusal
      // arrives as `ok: false` with the Host's own message, and reading past it
      // would turn every failure into an empty tree.
      const result = await rpc('tree.read', {})
      if (result?.ok !== true) throw new Error(result?.error?.message ?? '宿主拒绝了这次请求')
      const humans = result.value?.humans
      setState({ loading: false, error: '', humans: Array.isArray(humans) ? humans : [] })
    } catch (error) {
      // The caller's own message is what tells a refusal from a dead channel.
      console.warn('[digital-human] tree.read failed', error)
      setState({ loading: false, error: error?.message ?? String(error), humans: [] })
    }
  }, [rpc])

  React.useEffect(() => {
    console.debug('[digital-human] the tree caller is', typeof rpc)
    void load()
  }, [load, rpc])

  // Mark the Session the main column shows. It is read from the workspace service
  // rather than remembered here: another surface may change the selection, and the
  // tree must not claim a row is current after that.
  React.useEffect(() => {
    const selection = typeof getWorkspace === 'function' ? getWorkspace()?.selection : undefined
    if (typeof selection?.getSnapshot !== 'function' || typeof selection?.subscribe !== 'function') return
    const read = () => setCurrent(selection.getSnapshot()?.sessionId)
    read()
    return selection.subscribe(read)
  }, [getWorkspace])

  // The catalog and the Session status arrive asynchronously, and a row filtered or
  // marked against an empty first frame would stay wrong. Re-render on every change
  // of either; the filter and the running mark read the latest snapshot.
  const [, refreshStatus] = React.useState(0)
  React.useEffect(() => {
    const workspace = typeof getWorkspace === 'function' ? getWorkspace() : undefined
    const status = typeof getSessionStatus === 'function' ? getSessionStatus() : undefined
    const bump = () => refreshStatus((value) => value + 1)
    const disposers: Array<() => void> = []
    for (const store of [workspace?.sessions?.list, status]) {
      if (typeof store?.subscribe !== 'function') continue
      const dispose = store.subscribe(bump)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
    return () => { for (const dispose of disposers) dispose() }
  }, [getWorkspace, getSessionStatus])

  const open = (sessionId: string) => {
    if (typeof openSession !== 'function') {
      console.warn('[digital-human] the tree has no session opener')
      return
    }
    openSession(sessionId)
  }

  // One pass over the roles in their own order: a chat-keyed role becomes its own
  // section with the two chat kinds as subheadings, the rest fill the menu of the
  // requirement they were filed under. Rows whose Session the catalog no longer
  // lists are dropped: clicking one would clear the main area.
  const workspace = typeof getWorkspace === 'function' ? getWorkspace() : undefined
  const live = liveSessionIds(workspace)
  const running = runningSessionIds(typeof getSessionStatus === 'function' ? getSessionStatus() : undefined, workspace)
  const sections: TreeSection[] = []
  // Keyed by the thread, because that is the Session key; the title comes from the
  // directory's meta.json, so the menu reads the requirement's name.
  const byRequirement = new Map<string, { title: string; rows: TreeRow[] }>()
  const ordered = [...state.humans].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
  for (const human of ordered) {
    const role = human.name || human.humanId
    const chat: TreeSection | undefined = human.sessionKey === 'chat'
      ? {
          key: `chat:${human.humanId}`,
          title: role,
          kind: 'chat',
          rows: [],
        }
      : undefined
    if (chat) sections.push(chat)
    for (const requirement of human.requirements ?? []) {
      const conversation = String(requirement.conversation ?? '')
      for (const session of requirement.sessions ?? []) {
        const sessionId = session?.sessionId
        if (!sessionId) continue
        if (live && !live.has(sessionId)) continue
        const row: TreeRow = { label: role, sessionId, order: human.order ?? 100, icon: human.icon }
        if (chat) {
          // "direct:…" and "group:…" name the kind of chat; what follows the prefix
          // is the name the operator reads.
          const name = conversation.replace(/^(group|direct):/, '')
          chat.rows.push({ ...row, label: name || '聊天' })
          continue
        }
        // A Session reached by id has no thread, so it belongs to no requirement.
        if (!conversation) continue
        const entry = byRequirement.get(conversation) ?? { title: requirement.name || conversation, rows: [] }
        entry.rows.push(row)
        byRequirement.set(conversation, entry)
      }
    }
  }
  const requirements: TreeSection[] = [...byRequirement.entries()]
    .map(([thread, entry]) => ({
      key: thread,
      title: entry.title,
      kind: 'requirement' as const,
      rows: [...entry.rows].sort((a, b) => a.order - b.order),
    }))
    .sort((a, b) => a.title.localeCompare(b.title))
  const empty = !state.loading && state.error === '' && requirements.length === 0

  return (
    <div className="dh-tree">
      <div className="dh-tree-head">
        <span className="dh-tree-title">数字人视图</span>
        {/* An escape hatch, not the switch: the way in and out is the foot's row. */}
        <button type="button" className="dh-tree-link" onClick={onClose}>回到原生</button>
      </div>
      {state.loading ? <p className="dh-tree-hint">加载中…</p> : null}
      {state.error ? (
        <div className="dh-tree-error">
          <p className="dh-tree-error-text">读取需求失败：{state.error}</p>
          <div className="dh-tree-actions">
            <Button variant="outline" size="sm" onClick={() => { void load() }}>重试</Button>
            <Button variant="ghost" size="sm" onClick={onClose}>回到原生列表</Button>
          </div>
        </div>
      ) : null}
      {[...sections, ...requirements].map((section) => (
        // A chat role opens by default; a requirement starts folded, so the operator
        // scans several before opening the one they are working on.
        <details
          className="dh-tree-group"
          key={section.key}
          {...(section.kind === 'chat' ? { open: true } : {})}
        >
          <summary className="dh-tree-summary">
            <span className="dh-tree-chevron"><IconChevronRightOutlineRegular size={16} /></span>
            <span className="dh-tree-icon">
              {section.kind === 'chat' ? <IconUserOutlineRegular size={16} /> : <IconFolderCloseRegular size={16} />}
            </span>
            <span className="dh-tree-label">{section.title}</span>
          </summary>
          {section.rows.map((row) => (
                <TreeSession
                  key={row.sessionId}
                  {...row}
                  current={row.sessionId === current}
                  running={running.has(row.sessionId)}
                  openSession={open}
                />
              ))}
        </details>
      ))}
      {empty ? <p className="dh-tree-hint">还没有需求</p> : null}
    </div>
  )
}

/**
 * Add the view switch to the sidebar's "more" menu.
 *
 * That menu is a `single` slot with a fixed item list, so there is no contribution
 * point: the row is added to the menu's own DOM when it opens, first, and carries
 * `role="menuitem"` so the menu's keyboard walk treats it like the rows beside it.
 * A shell that replaces that menu simply gets no row — the tree's own header still
 * offers a way back.
 */
function installMenuSwitch(onPick: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  let expected = false
  // Only the account trigger counts: other menus in the page open the same way.
  const expectMenu = (event: Event) => {
    const target = event.target
    if (target instanceof Element && target.closest('[data-slot="settings.launcher"] [aria-haspopup="menu"]')) {
      expected = true
    }
  }
  const inject = (menu: Element) => {
    if (menu.querySelector('[data-dh-view-switch]')) return
    const wrap = document.createElement('div')
    wrap.className = 'dh-menu-item-wrap'
    const item = document.createElement('button')
    item.type = 'button'
    item.setAttribute('role', 'menuitem')
    item.setAttribute('data-dh-view-switch', '')
    item.className = 'dh-menu-item'
    // Static markup: the row's icon is the same folder the tree uses, drawn small.
    item.innerHTML = '<span class="dh-menu-item-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z"/></svg></span><span class="dh-menu-item-label">切换数字人视图</span>'
    item.addEventListener('click', () => { onPick() })
    wrap.appendChild(item)
    menu.prepend(wrap)
  }
  const observer = new MutationObserver((records) => {
    if (!expected) return
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue
        const menu = node.matches('[role="menu"]') ? node : node.querySelector('[role="menu"]')
        if (!menu) continue
        expected = false
        inject(menu)
        return
      }
    }
  })
  document.addEventListener('pointerdown', expectMenu, true)
  document.addEventListener('click', expectMenu, true)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    document.removeEventListener('pointerdown', expectMenu, true)
    document.removeEventListener('click', expectMenu, true)
    observer.disconnect()
  }
}

export const inject = ['slots', 'connection']

export function apply(ctx) {
  // The session-row mark renders without the settings page, so the sheet cannot wait
  // for that page's effect: without it the <img> would keep its intrinsic 64px size.
  ensureStyle()

  /** One Host call, with transport failure kept distinct from a refused call. */
  const rpc = async (method, payload, signal) => {
    try {
      return await ctx.connection.rpc.call('/api', RPC_ENDPOINT, { method, payload }, signal)
    } catch (cause) {
      if (signal?.aborted || cause?.name === 'AbortError') throw cause
      // The cause is what says *why* — a refused call, an unreadable route, a
      // malformed response. Replacing it with one sentence made every failure look
      // like a dropped connection, so it is kept for the console and the surface.
      console.warn(`[digital-human] ${method} failed`, cause)
      throw new Error(`无法访问 DSH 管理接口：${cause?.message ?? String(cause)}`)
    }
  }

  /** The workspace service, resolved on use: it may register after this plugin. */
  const workspaceService = () => {
    try {
      return ctx.get?.('uiWorkspace') ?? (ctx as any).uiWorkspace
    } catch {
      return undefined
    }
  }

  /**
   * The Session runtime status store, resolved the same way.
   *
   * It is the source the native row reads for its spinner, so the tree marks a
   * running Session exactly when the native list would.
   */
  const sessionStatusService = () => {
    try {
      return (ctx.get?.('uiSession') ?? (ctx as any).uiSession)?.sessionStatus
    } catch {
      return undefined
    }
  }

  hostRpc = rpc

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => {
    const dispose = ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 20,
      label: () => '数字人',
    }, DigitalHumansIcon)
    return () => dispose()
  }), 'digital-human: sidebar panel entry')

  // ds-bot's pattern: claim the column once, at startup, through inject(). A
  // later re-register after dispose proved unreliable, so the switch flips a flag
  // and reloads — the startup path is the one that is known to work.
  const showTree = (on: boolean) => {
    rememberTree(on)
    try { window.location.reload() } catch { /* a host without reload keeps the old column */ }
  }

  if (wantsTree()) {
    ctx.effect(() => ctx.slots.inject('sidebar.workspaces', () => {
      /**
       * Select one Session in the main column.
       *
       * Resolved on every click, not at registration: the workspace service may
       * register after this plugin, and a captured miss would stay a miss. Only the
       * selection moves — the conversation pane is not reopened or reset here.
       */
      const openSession = (sessionId: string) => {
        try {
          const workspace = workspaceService()
          if (typeof workspace?.openSession !== 'function') {
            console.warn('[digital-human] no workspace service to open a Session with')
            return
          }
          workspace.openSession(sessionId)
        } catch (error) {
          // Navigation is a convenience: a failure must not take the column down.
          console.warn('[digital-human] could not open the Session', error)
        }
      }
      const dispose = ctx.slots.register({
        name: 'sidebar.workspaces',
        priority: -20,
        inject: () => ({
          rpc,
          openSession,
          onClose: () => showTree(false),
          getWorkspace: workspaceService,
          getSessionStatus: sessionStatusService,
        }),
      } as any, DigitalHumansTree as any)
      return () => dispose()
    }), 'digital-human: sidebar column')
  }

  // The one switch entry: the first row of the sidebar's "more" menu. The tree's
  // own header keeps an escape hatch, but the way in is there.
  ctx.effect(() => installMenuSwitch(() => showTree(!wantsTree())), 'digital-human: sidebar view switch')

  ctx.effect(() => ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      inject: () => ({ rpc }),
    }, DigitalHumansPanel)
    return () => dispose()
  }), 'digital-human: main panel')

  // Leading mark on a session row. The seat only renders on an idle row, which is
  // the accepted visibility rule; a host without a session list simply has no seat.
  try {
    ctx.effect(() => ctx.slots.inject('sidebar.session.row.leading', () => {
      const dispose = ctx.slots.register({
        name: 'sidebar.session.row.leading',
        id: 'digital-human-icon',
        order: 20,
        inject: () => ({ rpc }),
      }, SessionRowIcon)
      return () => dispose()
    }), 'digital-human: session row icon')
  } catch {
    // No session list in this host; the settings page still works.
  }
}
