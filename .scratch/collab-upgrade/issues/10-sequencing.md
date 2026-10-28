# 10 · 排序与首批

Type: grilling
Status: resolved

## Question

六条决策定下来后，第一批做哪几条、按什么顺序、怎么验证？

## 要回答

- 哪些条目共享同一次改动（例如 04 的工作项与 08 的升级是同一套 deadline）。
- 第一批的验收标准：用什么场景跑通（哪个数字人、哪条链路）。
- 哪些条目要等 DSH 接口，先挂起。
## Answer

**四批。每批一个可跑场景，批间可独立回滚。**

### 批次 0（已完成）

- 11：一 Session 一名的写时守卫 + 载入告警；`buildSnapshot` 改列 `archiveDir`；数据修复。

### 批次 1 · 地基（最大一块）

**内容**：04 的账本与状态机 + 09 的 `status` 读账本。

- `humans/<id>/tasks.jsonl`；`assign / amend / cancel` 三意图；四态；同会话一条 `in_progress` + 队列。
- 订阅 `turn/start` / `turn/end`，只关这一轮的所有者；启动清扫。
- `digital_human_status` 追加 `state / reason / endedAt / note`。

**验收**：PM 连派三条给 dev（一条正常、一条故意报错、一条在对方忙时发）。账本显示 `done / failed / queued` 三态；报错那条的 `turn/end` 只关它自己；队列在第一条结束后自动开跑。

### 批次 2 · 成本与噪声

**内容**：07 记忆预算 + 05 的一对多展开。

- `# now` 16KB 注入上限（头 + 尾，中间省略并说明）；最近 8 条 History 标题。
- `needsCompaction` 双触发；`memory_status` 报分节字节。
- History 超限由宿主在 `turn/end` 归档（与批次 1 共用订阅）。
- `to` 接受数组，展开成 N 条工作项。

**验收**：PM 的 `# now` 从 20KB 降到注入 ≤16KB，且最新内容仍在；触发一次 History 归档，`memory_status` 能列出归档文件（11 的修复生效）。

### 批次 3 · 喊人

**内容**：08 升级到人。

- 工作项 `failed / blocked / 超时` → 私聊 owner；一条一次；5 分钟合并。
- `deadline` 缺省值（记录配置，默认 30 分钟）。

**验收**：人为把一条工作项超时，owner 收到恰好一条私聊；`done` 不产生消息。

### 批次 4 · 观测

**内容**：09 的用量工具。

- `digital_human_usage`：按时间窗扫 `ctx.tokenMeter.measure`，按会话汇总。

**验收**：对 PM 跑一周窗口，返回各会话 token 与合计；不产生落盘文件。

### 不做（已定的）

接管压缩（06）、群形态（05 之外的 C）、密钥卡片（09）、`park`（12）、topics 分层（07）。

### 顺序理由

批次 1 先做，因为 08 和 09 的验收都依赖它的终态数据；批次 2 独立于拓扑，可并行；批次 3、4 都建立在批次 1 的数据上但不改它。
