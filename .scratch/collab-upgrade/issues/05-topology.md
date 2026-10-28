# 05 · 多方形态：链式还是群

Type: grilling
Status: resolved

## Question

多个数字人一起干活时，是"主线数字人派活"的链式，还是"群聊圆桌"？

## 三方各有什么

- 本插件：只有点对点，一个 conversation 属于两个数字人。
- Halo：team / space / lead / work-items / blackboard（task + finding + activity，带 epoch 与归档）。
- ds-bot：群聊，一人一轮，@Name 传回合，没人有新话就 [PASS]。
- DSH：`dsh-experimental-agent-team`（Lead + teammates + 共享任务板 + inbox）。

## 可选

- **A 链式**：保持点对点，用 04 的工作项串起来；PM 事实上已是 Lead。
- **B 群**：引入多对多，代价是回合仲裁、[PASS] 判定、每人隐藏 Session。
- **C 复用 DSH agent-team**：能力最全，但它要求一个共享工作区，和"一人一工作区"冲突。

➡️ 推荐 A。你的流程是 PM→研发→自测的链，不是圆桌；群的仲裁成本换不来对应的收益。
## 侦察补充

Halo 自己也不是圆桌：`structured` 模式默认**星型** lead→每个成员（`service.ts:568-576`），lead 的提示词写死"读板 → 拆任务 → 派活 → 验产物 → complete"（`lead.ts:37-90`）。

➡️ **修订**：这加强了 A（链式）。群只在 ds-bot 里成立，而它的群靠拦截 `llm/stream`、伪造 tool-call 驱动（`groups.js:736-767`）——DSH 侧不可移植。
## Decisions

- Q1 群：**不建**。收益（多方同时对齐）不抵代价（回合仲裁、[PASS] 判定、每人隐藏会话）。
- Q2 多方表达：**派单链即拓扑**。工作项的 `from` / `to` 连起来就是图，不再建实体描述它。
- Q3 Lead：**不显式化**。PM 是普通数字人，中心地位由账本算出，不由角色授予（避免引出权限矩阵）。
- Q4 一对多：`to` 接受数组，**展开成 N 条独立工作项**，保持「一条工作项一个承接方」。

## Answer

**形态 = 链式，不是群。**

- 一个数字人只和另一个数字人说话，多方关系由工作项图表达。
- 没有群实体、没有回合仲裁、没有成员名单。
- 一人对多人 = N 条工作项，各自独立状态、独立超时。

**Halo 佐证**：它的 `structured` 模式默认也是星型 lead→成员，不是圆桌。圆桌只有 ds-bot 做，且依赖拦截 `llm/stream` 伪造 tool-call，DSH 侧不可移植。

**后续**：群形态由用户另起一张图讨论，本单只负责「这一版不建」。材料已留在 01（ds-bot 群回合）与 02（Halo team/board），以及 DSH 的 `dsh-experimental-agent-team`（Lead + teammates + 共享任务板，要求共享工作区）。
