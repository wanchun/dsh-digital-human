# 09 · 治理：失败可见、用量、密钥

Type: grilling
Status: resolved

## Question

要不要补"跑挂了看得见、花了多少看得见、密钥不进提示词"？

## 现状

- `digital_human_status` 只返回 `isGenerating`，没有终态与错误。
- 没有用量统计；没有密钥卡片（工具直接用环境变量）。
- ds-bot：secrets 卡片（模型看不到值）、usage 按 Bot/模型统计（从日志读）、角色矩阵。
- Halo：capability-policy（能力策略按 App 收口）。

## 可选

- **A 失败可见**：status 增加"最近一次 turn 的终态/错误码/耗时"。
- **B 用量**：按数字人聚合 token（DSH 日志已有）。
- **C 密钥**：需要模型看不见值的投递通道。

➡️ 推荐 A → B。C 依赖 DSH 是否提供 secret 注入，先不动。
## 侦察补充

Halo 的 `capability-policy`：strict/permissive 两档 + **未分类的 MCP 默认不注入** + 逐调用门 `delegation-gate`（`capability-policy.ts`、`delegation-gate.ts`）。

➡️ **修订**：A 仍先做。`delegation-gate` 依赖引擎的逐回合钩子，列进「依赖平台」，不进第一批。
## Decisions

- Q1 失败可见：**status 改读账本**。返回该会话最近一条工作项的 `state / reason / endedAt`。
- Q2 用量：**按数字人聚合**，用 `ctx.tokenMeter.measure` 扫它的会话；**按需计算**，不常驻、不落盘。
- Q3 密钥：**不做卡片**，维持环境变量/凭证文件。
- Q4 可见性：**只给工具**，配置页不加面板。

## Answer

**失败可见**（零成本，04 已经把数据落了）

- `digital_human_status` 不再只答 `isGenerating`，追加：最近一条工作项的 `state`、`reason`、`endedAt`、`note`。
- 数据源是 `humans/<id>/tasks.jsonl`，不新增存储。

**用量**（按需，不常驻）

- 新工具 `digital_human_usage`：给一个时间窗，扫该数字人所有会话的 `ctx.tokenMeter.measure`，按会话汇总 token。
- 纯回放、确定性、无模型调用（`dsh-token-meter` README）。
- 不落盘、不起定时任务：每次调用现算。

**密钥**

- 不做卡片。理由：要同时拦 `tools/execute`、`llm/stream`、`shellEnv` 三个出口，任一处漏就是明文泄漏；当前三个数字人共用一套凭证，收益不抵风险。
- **重新开单条件**：某个数字人需要第三方 key，且这个 key 不能给它所在的 shell 看见。

**不做**：配置页的账本/用量面板、独立健康视图、独立用量库。
