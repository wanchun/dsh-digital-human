# 02 · Halo 借什么

Type: research
Status: resolved

## Question

Halo（WeBank 桌面端）的多数字人协作机制，哪些是纯协议可搬的，哪些绑死它自己的 runtime？

## 线索

- 协作：`src/main/apps/runtime/team/`（blackboard、message-bus、orchestration、turn-report、work-items、board-digest）
- 会话：`src/main/apps/runtime/app-chat*.ts`、`dispatch-inbound.ts`、`escalation-cut.ts`、`delegation-gate.ts`
- IM：`src/main/apps/runtime/im-channels/`（binding、identity-resolve、owner-claim、connection-arbiter）
- 记忆：`src/main/platform/memory/`（consolidation、topics、snapshot）

答案见 `~/tmp/research/halo-mechanisms.md`。
## Answer

完整报告：`~/tmp/research/halo-mechanisms.md`（353 行）。

**能搬的（纯协议，判据是"不假设 Electron / SQLite / Claude SDK"）**
- 信封 + 触发上下文 + 三态回执（`team-types.ts:531-543,874-906`）
- 任务五态 + 产物引用（`resultRef`，发布即校验，`team-tools.ts:150-200`）
- turn-gate：邮箱 FIFO（128 上限）、同键折叠、`park`（人按停止后冻结）、TTL 回收（`turn-gate/index.ts:78` 起，543 行零 Electron 依赖）
- 记忆注入预算 + consolidation 三档 + 三道安全阀
- 升级到人的切点规则（`escalation-cut.ts:49-65`）

**搬不动的**
- IM provider 实现（企微/飞书/ilink）、federation（约 1 万行）、`sendIntoLiveTurn`（依赖 SDK 流形状）、逐调用门 `delegation-gate`（依赖引擎回合钩子）。

**最重要的一条判断**
Halo 的协作不是"黑板让人看见"，而是三条强制：**产物必须显式 `team_send` 回传**（回合结束什么都不送，`message-bus.ts:100-110`）、**完成以回合结束为准**（模型自报只作补充）、**送不到就返回 undelivered**（不假装成功）。

**对地图的影响**
- 04 的成本下调：不建板，只做任务行 + 回合消费 + 三态回执。
- 05 的证据加强：Halo 默认也是星型 lead，不是圆桌。
- 06 的判断加固：Halo 不接管压缩，靠预算与检索。
