# @local/dsh-digital-human

给 DeepSeek Harness 用的**可配置数字人**平台。

数字人不是写死的两个实体，而是**一份注册表里的记录**。插件把每条启用的记录变成
一个实时的 Agent preset（`dh-<id>`），所以新增、修改、停用、删除数字人都不需要改 YAML。

设计照搬 Halo 数字人的分层，但用 Harness 原生能力重建。

## 它解决什么

Halo 里每个数字人有两套独立系统：Chat 系统（数字人之间互发消息）和执行系统（定时/手动触发）。
本插件把两者都映射到 Harness 原生能力上：

| Halo | 本插件 |
| --- | --- |
| Chat 系统 `/chat/send` `/chat/status` `/chat/messages` `/chat/stop` | `sessionController` + 每个会话一份持久化信箱 |
| `conversationId` 隔离 | 一个 `(数字人, conversationId)` 对应一个持久 Session |
| 执行系统 `/trigger` `/state` | 官方 `@deepseek-ai/dsh-schedule`（`schedule_*` 工具） |
| `notify_bot` 推企微 | 绑定到该数字人的 IM bot，走 `dshIm.send` |
| `platform/memory` app scope | 每个数字人一份 `memory.md`，`# now` 每次组装预载 |

## 目录结构

```
index.js              宿主平台行：注册表、preset 生成、会话事件镜像
tools.js              preset 作用域行：每个数字人自己的工具面
client.js             客户端半：Web 设置页 + 侧栏面板
lib/store.js          注册表读写与校验
lib/chat.js           Chat 系统：Session 生命周期 + 信箱
lib/memory.js         持久记忆：# now / # History、快照、归档压缩
lib/presets.js        记录 -> Agent preset 投影
lib/tools.js          模型可见的工具定义
lib/rpc.js            管理通道：宿主 ctx.connection.fetch.register
lib/seed.js           首次启动的种子数字人（开发助手 / 研发PM助手）
test/                 四套离线测试，不需要跑 Harness
```

## 注册表

默认位置 `~/.dsh/digital-human/humans.json`（`home` 配置项可改）。一条记录：

```jsonc
{
  "id": "pm-assistant",              // slug，preset 名为 dh-pm-assistant
  "name": "研发PM助手",
  "description": "一句话角色说明",
  "enabled": true,
  "systemPrompt": "你是……",          // 成为 preset 的 persona 前缀
  "workspace": "/path/to/repo",      // 它的会话工作目录
  "skills": ["qs-assistant"],        // 额外挂载的技能目录
  "peers": ["dev-assistant"],        // 它可以发消息的数字人
  "im": { "botId": "", "targetId": "" },
  "subscriptions": [                 // 声明的唤醒时机（提示模型去建 schedule）
    { "cron": "0 22 * * *", "prompt": "汇总今日进展", "enabled": true }
  ],
  "memory": true,
  "escalation": { "enabled": false, "timeoutHours": 24 }
}
```

修改注册表后调用 `digital_human` 工具的 `update`，或重启，preset 会重新注册。

## 工具

每个数字人在自己的 preset 作用域里拿到：

- `digital_human_send` — 给另一个数字人发消息并触发它的一轮工作（异步，像派活）。
- `digital_human_status` — 对方那一轮跑完没有。
- `digital_human_messages` — 读回信。
- `digital_human_list` — 我能联系到谁。
- `notify_bot` — 通过绑定到我的 IM bot 推消息给人（仅文本；要发文件/图片/@ 用 `tctp-send` 技能）。
- `list_bot_targets` — 这个 bot 能发给谁。
- `memory_status` / `memory_compact` — 记忆的结构与归档。

全局只有一个：

- `digital_human` — 注册表增删改查（`list|show|create|update|remove`）。

## 记忆

每个数字人一份 `memory.md`，分 `# now`（工作记忆）和 `# History`（时间线，新的在上）。

- `# now` 在**每次组装**时预载进提示，所以模型一上来就知道自己的状态，不用先读文件。
- 模型用普通的 Edit/Write 改记忆，只有结构性元数据是工具（`memory_status`）。
- 超过 100KB 时归档到 `memory/<时间戳>.md` 并重建。

## 测试

```bash
node test/smoke.mjs    # 注册表校验 + preset 投影          34 项
node test/memory.mjs   # 记忆：# now 解析、快照、归档压缩   30 项
node test/apply.mjs    # 用 stub context 跑真实的 apply()，端到端   65 项
node test/wiring.mjs   # 管理 RPC 路由 + 客户端槽位注册      41 项
```

四套都不需要运行 Harness。

## 配置界面

设置面板里有一页「数字人」（排在 IM 设置之后），侧栏也有一条同名入口（排在「定时」之后，
点开是主列的全高配置页）。两边是同一份数据、同一组操作：列表、新建、编辑、删除、刷新。

字段：id、显示名称、说明、人设、工作目录、技能目录、可联系的数字人、绑定的 IM bot、
默认推送目标、启用、持久记忆。bot 和目标是从 `dshIm` 实时读出来的下拉框。

数据通路是宿主 `ctx.connection.fetch.register` 注册一条 `/api/digital-human` 精确路由，
客户端用 `connection.rpc.call('/api', 'digital-human', {method, payload})` 调它。
这条路走 DSH 自己的浏览器鉴权与 Host/Origin 校验，所以不需要额外做认证。

设置页和会话里的 `digital_human` 工具调的是同一个 service，所以界面和对话不会各说各话。

## 安装

用 `plugin_manager` 的 `install_bundle`，目标是本目录的绝对路径。
本包**不导入任何外部依赖**（只用 node 内置模块），因为 profile 的依赖树不归它所有。

装完需要**重启 `dsh web`**：bundle 列表在启动时组装。
