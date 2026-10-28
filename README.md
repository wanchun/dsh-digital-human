# @harrywan/dsh-digital-human

给 DeepSeek Harness 用的**可配置数字人**平台。

数字人不是写死的实体，而是**一份注册表里的记录**。插件把每条启用的记录变成一个实时的
Agent preset（`dh-<id>`），所以新增、修改、停用、删除数字人都**不需要改 YAML**。

## 设计

### 两个半

```
┌─ 宿主行（src/index.ts，平台级，只挂一次）
│    注册 preset · 提供 digitalHumans 服务 · 管 RPC · 订阅会话事件
│    对齐 IM · 认领负责人 · 设权限 · 导入导出
│
├─ 预设行（src/tools.ts，每个数字人挂一次）
│    注册该数字人的工具 · 注入记忆 · 挂载它的技能
│
└─ 浏览器半（src/client.tsx）
     侧栏入口 + 主列配置页
```

预设行是「每个数字人一份」的，所以工具天然知道「我是谁」，不需要模型自报身份。

### 核心概念

| 概念 | 是什么 |
| --- | --- |
| **数字人记录** | `humans.json` 里的一条：id、名字、人设、工作区、同伴、IM bot、配置声明、技能 |
| **Preset** | `dh-<id>`，由记录生成：baseline 行 + persona + 该数字人的工具行 |
| **会话** | DSH 的 Session，一个数字人可以有很多条 |
| **地址** | 发消息时指定的目标：**会话名**（线程名，如需求 slug）或**会话 id**（`session-…`） |

### 配置 → persona

记录里写 `systemPrompt`（人设），其中用 `{{键名}}` 占位。`configSchema` 声明这些键：
类型（text/number/boolean/select）、来源（平台事实/默认值）、是否隐藏。

渲染时按 **配置 > 平台事实 > 默认值** 取值，只替换**声明的**键；未解析的占位符变成
`〔未配置：键〕`，防止整轮崩。

**六个通用事实**：`self_name` `self_id` `owner_id` `owner_chat` `peer_name` `peer_id`。

### 记录落盘：人设与配置分开

每条记录是一个目录，人设和机器配置分开存：

- `persona.md`：名称、描述（frontmatter）+ 人设正文。可直接编辑、可 diff、可回滚。
- `config.json`：启用、工作目录、技能、同伴、IM 绑定、权限预设、会话模式、自由配置、时间戳。

目录是唯一权威，不再有合并的 `humans.json`；旧格式用迁移命令转过来（见「落盘布局」）。

### 与 IM 的绑定与对齐

把记录推给绑定的 bot（`bot.workspace.set`、`bot.preset.set`、`bot.context-enhancement.set`），
并注入来源块与负责人身份。启动时对齐所有绑定的 bot；失败就重试
（`alignRetryMs` / `alignRetryMax`），因为漏推是静默的。

### 数字人之间通讯

- 工具：`digital_human_send` / `_status` / `_stop` / `_messages` / `_conversations` / `_list`
- **寻址**：传地址 → 表里有就**沿用**那条会话（按 id「收养」，归档/闲置的也能续上）；
  没传或找不到 → 新建；**两个地址都不传 → 报错**，不给静默的 `main` 桶
- **消息头**带发送方身份与会话 id：

  ```
  <dsh_peer_source from="pm-assistant" session="session-…" conversation="rtcpc-…" />
  ```

  接收方按 `session` 回，**活是谁派的就回给谁**
- **信箱**：每个数字人一份 append-only JSONL，按**会话 id** 记账（旧文件自动迁移）

### 会话模式

- `thread`（默认）：一个 `conversation_id` 一条会话，消息**插话**进入正在跑的回合。研发助手按需求分线程。
- `single`：固定一条常驻会话，`conversation_id` 只作标签；消息**排队**到当前回合之后；会话建立时用记录名命名。适合自测类助手。
- 两种模式都是长期会话；区别只在"每个线程一条"还是"共用一条"。
- 回执按 `<dsh_peer_source session>` 的来路回到派活会话，不按线程名猜。

### 记忆

每个数字人一份 `memory.md`：`# now`（工作记忆，每轮注入）+ `# History`（时间线）。
`# now` 的注入上限是 16KB：超出按 `##` 边界保留前几节；单节超长则保留头部 State 与尾部最新内容，中间省略并写明省略量。大文件另注入最近 8 条 History 标题，不带正文。
整份超过 100KB 或 `# now` 超过 16KB 时提示压缩：归档到 `memory/<时间戳>.md` 并重建。
文件超过 100KB 时，宿主在回合结束自动把最旧的 History 条目归档到 `memory/<时间戳>.md`（保留最近 60 条）；`# now` 永不自动搬。
工具：`memory_status`（看结构与分节字节）、`memory_compact`（整份归档，或只用 `scope: "history"` 归档时间线）。

### 技能空间

技能分两层，互不干扰：

```
全局 ~/.agents/skills/  ─┐
项目目录的 skills/       ─┼─→  每个数字人默认加载，不用配置
bundled 内置技能        ─┘

插件技能空间            ──→  只有记录里勾选的才挂给这个数字人
~/.dsh/digital-human/skills/
```

- 挂在 `~/.dsh/digital-human/skills/<名字>/SKILL.md`（+ `references/` 等资源）
- 通过**预设作用域**的 `ctx.skills.register` 注册 —— 只对该数字人可见，
  不碰全局目录，也不用符号链接
- runtime 注册**压过** user（全局）同名技能，所以私有技能能覆盖全局的
- 界面可**上传**（选目录，保留相对路径）、**勾选**启用、**移除**
- 缺 `SKILL.md` 的目录照样列出（上传出错要看得见）；路径逃逸、超 2000 文件/32MB 会被拒

### 导入导出

一个数字人 = 一个 `.tar.gz` 包：

```
pm-assistant-202610131954.dh.tar.gz
├── manifest.json              格式版本（dsh-digital-human/2）、导出时间、id、带了哪些技能
├── humans/<id>/persona.md     人设（剥掉本机字段）
├── humans/<id>/config.json    机器配置
├── memory/<id>.md             可选
└── skills/<名字>/…            勾选的那些技能，原样目录树
```

旧格式（`humans/<id>.json` 合并记录）仍可导入，按文件布局自动识别。

- **tar 容器手写 + 内置 `zlib.gzipSync`** —— 插件零运行时依赖
- 二进制安全；`tar tzf` 能直接看内容 —— **导入等于接受别人的提示词，先看得见很重要**
- 长路径用 tar 的 `prefix` 字段承载，超长**拒绝**而不是截断
- 符号链接/设备条目**跳过不跟随**
- 导出**剥掉** `im.botId` / `im.targetId` / `im.owner`（都指向本机）
- 两个二进制端点，浏览器就是普通下载/上传，不走 base64：

  ```
  GET  /api/digital-human/bundle/<id>    导出
  POST /api/digital-human/bundle         导入（?preview=1 只读预览，?id= 换 id）
  ```

### 工具清单

| 工具 | 作用 | 注册范围 |
| --- | --- | --- |
| `digital_human_send` | 给同伴发消息并起一轮（`to` 可传数组，展开成 N 条独立工作项） | 预设内 |
| `digital_human_status` | 同伴在干活吗 | 预设内 |
| `digital_human_stop` | 中止同伴的那一轮 | 预设内 |
| `digital_human_messages` | 读同伴回复 | 预设内 |
| `digital_human_conversations` | 列出与同伴的两种地址 | 预设内 |
| `digital_human_list` | 列出所有数字人 | 预设内 |
| `digital_human_usage` | 按时间窗汇总 token（可选 `to`） | 预设内 |
| `notify_bot` | 给人发 IM（`to` 必填：已登记目标或原始 chatId） | 预设内 |
| `list_bot_targets` | 列出可投递目标 | 预设内 |
| `set_session_title` | 给自己的会话改名（不依赖 IM bot） | 预设内 |
| `memory_status` / `memory_compact` | 记忆结构（含分节字节）/ 整份或仅时间线归档 | 预设内 |
| `digital_human` | 注册表增删改查 | 全局 |

### 宿主能力

- **RPC**（一条 `/api/digital-human` 精确路由）：`registry.list/get/save/remove/sessionIcon`、
  `im.bots`、`im.targets`、`skills.list`、`skills.library/upload/remove`、
  `workspaces.list`、`permissions.list`
- **订阅事件**：`session/created`（上权限、重试对齐）、`session/event`（记信箱、识别 preset 切换）、
  `session/disposed`（清理）
- **读的服务**（都可选，缺了就降级）：`permissionPresets`、`workspaceController`、`dshIm`、
  `skills`、`connection`

### 配置界面

一个入口：侧栏「数字人」→ 主列全高配置页。字段由记录自己的 `configSchema` 驱动。

- 按类型渲染控件；声明 `from` 的是平台事实，只读且**不回显实际值**
- `hidden: true` 的不显示（仍解析、仍进提示词）
- 未声明的键单独一块「未声明」，可移除
- 没声明 schema 的记录退回「名称 + 值」行编辑器
- 保存是 partial merge，**不发送页面看不到的东西**（如 `targetId`）
- 侧载失败会说明「读取失败」，而不是假装「空」

### 图标

每条数字人可选一个图标：png/jpeg/webp/svg 的 base64 data URI，上限 64KB。设置页上传、预览、清除；数字人列表与会话行共用同一张图。

会话行在标题前显示图标：宿主按 `sessionId` 解析该会话的 `agentPreset`，再映射到记录。只在**空闲行**渲染——运行中让位给状态点，归档行留空；标题文字、自动命名与置顶都不变。没有图标就不显示。

### 落盘布局

```
~/.dsh/digital-human/
├── humans/<id>/
│   ├── persona.md                 人设（frontmatter + 正文）
│   ├── config.json                机器配置
│   ├── memory.md                  记忆（# now + # History）
│   ├── sessions.json              地址 → 会话 id
│   ├── edges.jsonl                往来边（谁问谁的记录）
│   └── conversations/<会话>.jsonl  信箱
├── humans.json.legacy-<时间>      迁移备份（迁移后才有）
├── skills/                        插件技能空间
└── workspace/                     数字人共享的工作区
```

### 旧注册表迁移

旧版本把记录放在 `humans.json`。停宿主后执行：

```bash
node tools/migrate.mjs --dry-run
node tools/migrate.mjs
```

宿主运行时命令会拒绝；迁移先备份，再逐条写入并从目录读回、逐字段比对，全部通过才删除旧文件。
`tools/cutover.sh` 把"停宿主 → 迁移 → 重启"串成一次操作。

### 插件配置项

`home` · `seed` · `basePreset` · `toolsPluginName` · `permissionPreset` ·
`platformVariables` · `alignRetryMs` · `alignRetryMax`

`seed` 默认 **false**：全新安装从**空注册表**开始，数字人由你在页面上配，或导入一个包。
插件不替谁决定业务人设。

### 通用性

| 设计 | 效果 |
| --- | --- |
| 配置词汇只有 **6 个平台事实** | 插件里**没有**任何业务键名 |
| 业务键名由记录自己的 `configSchema` 声明 | 换一套人设不用改插件 |
| IM 通道从 botId 前缀推导（`dsh-<channel>`） | 换通道不用改插件 |
| 权限预设从宿主 `permissions.list` 读 | 平台改名/新增自动跟上 |
| 工作区名册、技能目录、bot 列表都问宿主 | 同上 |
| 自带文案只讲机制，不讲业务规则 | 一份插件适配任意团队 |
| 目标名只用 IM 插件报出来的 | 不猜 id |

### 测试

```
单测 609 项（vitest，17 个文件）      分支覆盖率 ≥ 90%
集成 423 项（6 个 .mjs，跑编译产物）  零运行时依赖
零运行时依赖（只用 node 内置）
```

### 已知限制

1. 同伴触发的 turn 会不会自动推到 IM 群，未验证 —— 目前靠主动 `notify_bot`
2. IM 插件只能对「已经跟它说过话的会话」主动发 —— 新群/新联系人要先有入站消息
3. 已存在的未分组会话补不回来 —— DSH 没有把旧会话登记进工作区的接口
4. 归档的会话收到消息会被 DSH 拦下（`blocked`）—— 映射不能指向归档会话
5. 会话改不了预设或目录 —— 记录改了这两样，那条会话只能重开（插件会写日志说明）
6. 技能空间只收文本 —— 二进制资源要等 zip 方案
7. 未绑定 IM bot 的数字人没有 `notify_bot` / `list_bot_targets` —— 它只能在自己的会话里回复同伴。
   `notify_bot` 给未登记联系人发原始 chatId 一直可用；IM 插件暴露 `createTarget` 后，同一次发送会顺手登记为 `auto-<chatId 后 8 位>`
8. `digital_human_usage` 只算本进程还活着的会话 —— 冷存的历史会话要等重新载入才计入

## 参考借鉴 Halo

分层思路参考了 Halo 数字人（记录/预设分离、会话隔离、持久信箱、记忆分 `# now` 与历史），
并用 Harness 原生能力重建：

| Halo | 本插件 |
| --- | --- |
| Chat 系统 `/chat/send` 等 | `sessionController` + 每个会话一份持久化信箱 |
| `conversationId` 隔离 | 一个 `(数字人, 地址)` 对应一个持久 Session |
| 执行系统 `/trigger` | 官方 `@deepseek-ai/dsh-schedule` |
| `notify_bot` 推企微 | 绑定到该数字人的 IM bot，走 `dshIm.send` |
| `platform/memory` app scope | 每个数字人一份 `memory.md`，`# now` 每轮预载 |

Halo 的业务人设（开发助手 / 研发PM助手）曾作为种子随插件发布，现已**默认关闭**：
插件只提供机制，业务规则由记录承载。

## 安装

```bash
# 1. 把本目录链进 profile
ln -sfn /path/to/dsh-plugins/digital-human \
  ~/.dsh/profiles/web/node_modules/@harrywan/dsh-digital-human

# 2. 在 profile 的 cordis.patch.yml 里启用
#    - id: digital-human
#      disabled: false

# 3. 重启 dsh web
```

改完 `src/client.tsx` 只需 `pnpm run build` + 刷新页面；改宿主侧要重启。
