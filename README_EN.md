# @harrywan/dsh-digital-human

Configurable **digital humans** for DeepSeek Harness.

A digital human is not a hard-coded entity: it is **a record in a registry**. The
plugin turns each enabled record into a live Agent preset (`dh-<id>`), so adding,
changing, disabling or deleting a digital human needs **no YAML edit**.

> 中文文档见 [README.md](./README.md)。

## Design

### Two halves and a browser

```
┌─ Host row (src/index.ts, platform level, mounted once)
│    registers presets · provides the digitalHumans service · owns the RPC routes
│    subscribes to session events · aligns IM · claims the owner · import/export
│
├─ Preset row (src/tools.ts, mounted once per digital human)
│    registers that human's tools · injects its memory · mounts its skills
│
└─ Browser half (src/client.tsx)
     one sidebar entry + a full-height configuration page
```

The preset row exists once per digital human, so its tools already know **who they
are**. The model never has to state its own identity.

### Core concepts

| Concept | What it is |
| --- | --- |
| **Record** | One entry in `humans.json`: id, name, persona, workspace, peers, IM bot, declared config, skills |
| **Preset** | `dh-<id>`, generated from the record: baseline rows + persona + that human's tool row |
| **Session** | A DSH Session; one digital human can own many |
| **Address** | How a message is targeted: a **conversation name** (a thread, such as a requirement slug) or a **session id** (`session-…`) |

### Config → persona

The record holds `systemPrompt`, with `{{key}}` placeholders. `configSchema`
declares those keys: type (text/number/boolean/select), source (platform fact or
default), and whether the field is hidden.

Rendering resolves **config > platform fact > default**, replacing only **declared**
keys. An unresolved placeholder becomes `〔unset: key〕` instead of breaking the turn.

**Six platform facts**: `self_name` `self_id` `owner_id` `owner_chat` `peer_name`
`peer_id`.

### IM binding and alignment

The record is pushed to its bound bot (`bot.workspace.set`, `bot.preset.set`,
`bot.context-enhancement.set`), together with the injected source block and the
owner identity. Every bound bot is aligned at startup, and a failure is retried
(`alignRetryMs` / `alignRetryMax`) because a missed push is silent.

### Digital human to digital human

- Tools: `digital_human_send` / `_status` / `_stop` / `_messages` /
  `_conversations` / `_list`
- **Addressing**: with an address, an existing session is **adopted** (by id, so an
  idle or archived one is reused); without one, a session is created; with
  **neither address, the call fails** rather than silently landing in a shared
  `main` bucket
- **The message header carries the sender**:

  ```
  <dsh_peer_source from="pm-assistant" session="session-…" conversation="rtcpc-…" />
  ```

  The receiver replies to that `session`, so **the work returns to whoever asked**
- **Mailbox**: one append-only JSONL per digital human, keyed by session id (older
  conversation-keyed files are migrated)

### Memory

One `memory.md` per digital human: `# now` (working memory, injected every step)
and `# History` (a timeline). `# now` is injected under a 16 KB budget: an oversized
block keeps its leading `##` sections, or the head (State) and the newest tail of one
overlong section, and always says how much was omitted. A large file also carries the
titles of the latest 8 History entries, never their bodies.
Above 100 KB, or when `# now` alone passes 16 KB, the plugin suggests compaction: the
file is archived to `memory/<timestamp>.md` and rebuilt. Above 100 KB the host also
archives the oldest History entries on turn end, keeping the newest 60; `# now` is
never moved automatically.
Tools: `memory_status` (inspect, with per-section bytes) and `memory_compact`
(archive everything, or `scope: "history"` for the timeline alone).

### Skill space

Skills live in two layers that do not interfere:

```
global ~/.agents/skills/  ─┐
the project's skills/      ─┼─→  loaded by every digital human, no configuration
bundled skills            ─┘

the plugin's skill space  ──→  only what the record selects, for that human alone
~/.dsh/digital-human/skills/
```

- A skill is a directory: `SKILL.md` plus any resources beside it
- Mounted through a **preset-scoped** `ctx.skills.register`, so it is visible to
  that digital human only — the global directory is untouched and no symlinks are
  needed
- A runtime registration **outranks** a user (global) entry of the same name, so a
  private skill can replace a global one
- The page can **upload** (pick a directory; relative paths are kept), **select**
  and **remove** skills
- A directory without a readable `SKILL.md` is still listed, so a broken upload is
  visible; escaping paths, more than 2000 files or more than 32 MB are refused

### Import and export

One digital human is one `.tar.gz`:

```
pm-assistant-202610131954.dh.tar.gz
├── manifest.json      format, exported time, id, which skills travel
├── human.json         the record, with machine-local fields stripped
├── memory.md          optional
└── skills/<name>/…    the selected skills, as real directory trees
```

- The tar container is written by hand and compressed with the built-in
  `zlib.gzipSync`: the plugin keeps **zero runtime dependencies**
- Binary-safe; `tar tzf` shows the contents, which matters because **importing runs
  someone else's prompt**
- Long paths use tar's `prefix` field; an over-long path is **refused, not
  truncated**
- Symlink and device entries are **skipped, not followed**
- Export **strips** `im.botId`, `im.targetId` and `im.owner` — all machine-local
- Two binary endpoints, so the browser downloads and uploads a file the ordinary
  way, with no base64 detour:

  ```
  GET  /api/digital-human/bundle/<id>    export
  POST /api/digital-human/bundle         import (?preview=1 reads only, ?id= renames)
  ```

### Tools

| Tool | Purpose | Scope |
| --- | --- | --- |
| `digital_human_send` | Send a message to a peer and start a turn (`to` accepts an array: one independent work item each) | preset |
| `digital_human_status` | Is the peer working? | preset |
| `digital_human_stop` | Abort the peer's turn | preset |
| `digital_human_messages` | Read the peer's replies | preset |
| `digital_human_conversations` | List both address forms per peer | preset |
| `digital_human_list` | List every digital human | preset |
| `digital_human_usage` | Token usage over a window, optionally for another record | preset |
| `notify_bot` | Send IM to a person or group (target names only, never chat ids) | preset |
| `list_bot_targets` | List the targets that bot can reach | preset |
| `memory_status` / `memory_compact` | Inspect (per-section bytes) / archive all or history only | preset |
| `digital_human` | Registry CRUD | global |

### Host surface

- **RPC** (one exact `/api/digital-human` route): `registry.list/get/save/remove`,
  `im.bots`, `im.targets`, `skills.list`, `skills.library/upload/remove`,
  `workspaces.list`, `permissions.list`
- **Events**: `session/created` (apply permissions, retry alignment),
  `session/event` (mirror the mailbox, notice a preset switch), `session/disposed`
  (clean up)
- **Services read optionally**, degrading when absent: `permissionPresets`,
  `workspaceController`, `dshIm`, `skills`, `connection`

### Configuration page

One entry: the sidebar's "数字人" opens a full-height page. Its fields are driven by
the record's own `configSchema`.

- Controls follow the declared type; a field with a `from` source is a read-only
  platform fact and **never echoes the actual value**
- `hidden: true` fields are not shown, but are still resolved and still reach the prompt
- Undeclared keys get their own "undeclared" block and can be removed
- A record without a schema falls back to a name/value row editor
- Saving is a partial merge and **never sends what the page cannot see** (such as
  `targetId`)
- A failed side load says so instead of pretending the list is empty

### On disk

```
~/.dsh/digital-human/
├── humans.json                    the registry (records + declared config)
├── skills/                        the plugin's skill space
├── humans/<id>/
│   ├── memory.md                  # now + # History
│   ├── sessions.json              address → session id
│   ├── tasks.jsonl                work-item ledger (one line per change)
│   └── conversations/<addr>.jsonl mailbox
└── workspace/                     the workspace digital humans share
```

### Plugin options

`home` · `humans` · `basePreset` · `toolsPlugin` · `permissionPreset` ·
`platformVariables` · `alignRetryMs` · `alignRetryMax`

`humans` is empty by default: **a fresh install grows no digital humans**. Configure
one in the page, or import a bundle. The plugin does not decide anyone's personas.

### Staying generic

| Decision | Effect |
| --- | --- |
| Only **six platform facts** in the vocabulary | No business key name appears in the plugin |
| Business keys are declared by the record's `configSchema` | Another team's personas need no code change |
| The IM channel is derived from the bot id prefix (`dsh-<channel>`) | Another channel needs no code change |
| Permission presets come from the host's `permissions.list` | A renamed or new preset is picked up automatically |
| The workspace roster, the skill catalog and the bot list are all asked of the host | Same |
| Shipped prose explains mechanism, never business rules | One plugin fits any team |
| Targets are used only under the names the IM plugin reports | No id guessing |

### Tests

```
720 unit tests (vitest, 19 files)       lines 96.5%  branches 90.4%
430 integration checks (6 .mjs suites)  statements 95.4%  functions 95.2%
zero runtime dependencies (node built-ins only)
```

### Known limits

1. Whether a peer-triggered turn is posted to the IM group is unverified — the
   reliable path is an explicit `notify_bot`
2. The IM plugin can only send to a chat it has already seen: a new group or
   contact needs one inbound message first
3. An existing ungrouped session cannot be back-filled — DSH has no API to file an
   old session into a workspace
4. An archived session is blocked by DSH when a message arrives, so a mapping must
   not point at one
5. A session cannot change its preset or its directory — changing either in the
   record forces a new session, and the plugin logs why
6. The skill space holds text only; binary resources wait for a zip-based bundle
7. `digital_human_usage` counts only Sessions this process still holds live — cold
   history counts after it is reloaded

## Borrowed from Halo

The layering follows Halo's digital humans (record/preset separation, conversation
isolation, a durable mailbox, memory split into `# now` and history), rebuilt on
Harness primitives:

| Halo | This plugin |
| --- | --- |
| Chat system (`/chat/send` …) | `sessionController` + one durable mailbox per session |
| `conversationId` isolation | One `(digital human, address)` maps to one durable Session |
| Execution system (`/trigger`) | The official `@deepseek-ai/dsh-schedule` |
| `notify_bot` to WeCom | The bound IM bot, through `dshIm.send` |
| `platform/memory` app scope | One `memory.md` per human, `# now` preloaded every step |

Halo's business personas (a dev assistant and a PM assistant) once shipped as seed
data. They no longer do: the plugin provides mechanism, and records carry the rules.

## Install

```bash
# 1. link this directory into a profile
ln -sfn /path/to/dsh-plugins/digital-human \
  ~/.dsh/profiles/web/node_modules/@harrywan/dsh-digital-human

# 2. enable it in the profile's cordis.patch.yml
#    - id: digital-human
#      disabled: false

# 3. restart dsh web
```

After changing `src/client.tsx`, run `pnpm run build` and refresh the page. Changing
the host half needs a restart.
