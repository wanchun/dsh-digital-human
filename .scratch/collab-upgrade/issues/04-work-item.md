# 04 · 派活要不要变成工作项

Type: grilling
Status: resolved

## Question

数字人之间的"派活"现在是**聊天消息 + 轮询**，要不要升级成带状态的**工作项**？

## 现状（有据）

- `src/lib/tools.ts:192` `digital_human_send`：投递即返回，`wait_seconds` 只是轮询对方 `isGenerating`。
- 回执靠约定：消息体里写"回给派单会话"，对方按 `<dsh_peer_source session>` 反向路由（`chat.ts:266` threadTarget）。
- 超时/阻塞靠人设纪律：需求流程 spec 里写"每 1 分钟轮询，30 分钟超时"，插件不知道。
- 没有"谁在等谁"的全局视图；`digital_human_status` 只给 `isGenerating`。
- 现场已出现地址漂移：`pm-assistant/sessions.json` 里两个线程名指向同一个 session（`rtcpc-…` 与 `tumss-…` 都是 `session-49ec01ab`），派单与回执因此可能落进同一条历史。

## 可选

- **A 薄工作项**：`tasks.jsonl`（谁派/派给谁/会话/状态/截止/产物）；send 自动开工单；turn 结束回写；新增 `digital_human_tasks` 查询。
- **B 只加回执与超时**：send 返回 task id，对方 turn 结束自动回一条 acks，超时自动标阻塞。
- **C 不动**：维持现状，靠人设写纪律。
- **D 用 DSH 的 `dsh-experimental-agent-team`**：它自带 Lead + teammates + 持久任务板，但绑定"一个共享工作区"，和"数字人各占一个工作区"不一致。

➡️ 推荐 A 的最小版 + B 的回执：先做到"派单有 id、有截止、有终态"，不做优先级与依赖图。
## 侦察补充：Halo 把这件事拆成三件小事（都不需要"板"）

- 任务行只有五态：`pending → in_progress → done|rejected|blocked`（`team-types.ts:15`）；"收敛"只看 `done|rejected`。
- 回执是协议不是礼貌：异步回执 `{messageId, delivery: undelivered|queued|mid_turn}`（`team-types.ts:874-906`）；送不到就返回 `undelivered`，不假装成功（`message-bus.ts:655-690`）。
- **完成以回合结束为准，不以模型自报为准**——`orchestration.ts` 头注释原话："Completion is authoritative from the turn's agent-loop ending, not from the member calling report."；失败/超时/没送到也要发一条（`turn-report.ts:237-260`）。
- 产物用路径引用，发布瞬间校验存在/归属/唯一（`team-tools.ts:150-200`）。

➡️ **修订**：A 的成本比我原估的低。不建板，只加三件：任务行、`turn/end` 消费、三态回执。插件已订阅回合事件（`src/index.ts:833-850`），不用新接缝。
## Decisions

- **Q1 粒度：A**（2026-10-28）。一次 `digital_human_send` = 一条工作项，id 唯一，线程名只是地址。
  - 线程视图靠聚合：同一 `conversation` 下未终态的工作项。
  - 代价：一条会话里可能有两条未终态项，`turn/end` 要说清关哪一条 → 见 Q3。
- **Q1 修订（2026-10-28）**：一次 **`assign`** 一条；`amend` 是挂在在办项上的事件，`cancel` 是状态转移。忙时默认不产生新项。

### 意图三层（已认）

1. **机械兜底**：空闲 → `assign`；在跑且是回答对方刚问的问题（同会话 + `fromSession` 接续）→ `amend`；其余 → `assign`（进队列）。
2. **模型覆盖**：`send` 加可选 `mode: 'new' | 'amend' | 'cancel'`，不填走第一层。
3. **回声**：返回必须说清"已作为对 w-01 的修改投递"或"已排队为 w-02"。

**硬规则**：`amend` 必须锚定——会话里只有一条未终态就锚它；两条以上报错要求 `task_id`。

**偏置**：不确定时选 `assign`（排队可见 ≫ 静默丢失）。

### 状态机（已定）

```
queued ──turn/start──> in_progress ──turn/end──> done | failed | stopped | blocked
   └──cancel──> cancelled
```

- `turn/end` 关「这一轮的所有者」：`turn/start` 时那条 `in_progress`。
- 同一会话永远只有一条 `in_progress`；一轮结束且有队列 → 投递队首并标 `in_progress`。
- 抢占 = `stop` 当前回合 + 被抢占项记 `stopped(superseded)` + 新项 `assign`。默认不抢占。
- 兜底：启动清扫（`in_progress` 但会话空闲 → `stopped(restart)`）；惰性超时（查询时按 deadline 算）。
- **Q2 存储：A**（2026-10-28）。每个数字人一份 `humans/<id>/tasks.jsonl`，派单方与被派方各写一份。
- **Q3 状态来源：A**（2026-10-28）。宿主订阅 `turn/start` / `turn/end` 写状态；模型只能填一行 `note`。
- **Q4 终态：四态**。`done`(completed) / `failed`(error、max-tokens→`truncated`) / `stopped`(aborted、interrupted→`restart`、被抢占→`superseded`) / `blocked`(blocked)。

## Answer

**工作项**是一条派活的台账记录，不是消息、不是会话、不是需求：

```
{ id, from, to, conversation, state, createdAt,
  owner?: sessionId, deadline?, endedAt?, reason?, note?, amendments?: [{at, text}] }
```

**状态机**

```
queued ──turn/start──> in_progress ──turn/end──> done | failed | stopped | blocked
   └──cancel──> cancelled
```

**四条不变量**

1. 一次 `assign` 一条；`amend` 不建项，只追加。
2. 同一会话最多一条 `in_progress`；`turn/end` 只关**这一轮的所有者**。
3. 一轮结束且队列非空 → 投递队首，标 `in_progress`。
4. 不确定意图时按 `assign` 处理（排队可见 ≫ 静默丢失）。

**投递意图三层**：机械兜底（空闲 assign / 回答 amend / 其余 assign）→ 模型 `mode` 覆盖 → 返回值回声。`amend` 必须锚定在唯一未终态项上，否则报错要 `task_id`。

**兜底**：启动清扫把"在办但会话已空闲"的项记 `stopped(restart)`；超时在查询时惰性判定，不起定时器。

**不做**：共享看板、父子任务/依赖图、活动流。线程视图 = 同 `conversation` 下未终态项的聚合。
