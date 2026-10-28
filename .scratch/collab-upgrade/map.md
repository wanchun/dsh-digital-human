# Map: 从 ds-bot 与 Halo 借什么

## Destination

把 ds-bot 与 Halo 里**已经被验证过的协作机制**，收敛成一份决策级改进清单：
每条写清「哪个机制 / 解决哪个真实卡点 / 落在插件的哪个文件 / 成本与风险」。
排序口径：多数字人协作 > 上下文与记忆 > IM > 可观测 > 权限。

终点是**清单定稿**，不是代码。动手是下一张地图的事。

**状态：已到达。12 张工单全部关闭。**

## Notes

- 只改插件 + 人设/技能/流程。需要 DSH 平台新增接口的，在条目里单列「依赖平台」，不混进成本估算。
- 姿势：**协议照搬，运行时重建**。消息信封、回执格式、任务状态机可以照抄；会话、回合、存储跟着 DSH 走。
- 约束：保持零运行时依赖（node 内置 + DSH 服务）。
- 素材与重跑方式：
  - ds-bot 源码：`~/.dsh/profiles/web/node_modules/.pnpm/ds-bot@0.1.6*/node_modules/ds-bot`（src/host 约 1 万行）
  - Halo 源码：`~/tmp/halo-src/src`，从 `/Applications/Halo-WeBank.app/.../app.asar` 的 sourcemap 还原（脚本 `/tmp/ex3.mjs`）
  - 侦察报告：`~/tmp/research/{ds-bot-mechanisms,halo-mechanisms,digital-human-baseline}.md`
- 落地顺序见 10，四批。

## Decisions so far

<!-- 关闭的工单，一行一条：标题 + 一句话结论 -->

- [01 · ds-bot 借什么](issues/01-ds-bot.md): 借 secrets 卡片、记忆回合后 review、防空转四道闸、steward 判据与交接条结构；不借 compaction 补丁、FTS5、`turns.js` 全量折叠。
- [02 · Halo 借什么](issues/02-halo.md): 搬信封/五态任务/三态回执/turn-gate/记忆预算与 consolidation 安全阀；不搬 IM provider、federation、live-turn 注入。
- [03 · 现状基线](issues/03-baseline.md): 寻址已够严谨，真正缺的是任务状态与结果可见性；最卡协作的六条已带证据列出。
- [04 · 派活要不要变成工作项](issues/04-work-item.md): 要。一次 assign 一条台账；意图三层（机械兜底 + 模型覆盖 + 回声）；四态；`turn/end` 只关这一轮的所有者；同会话一条 in_progress + 队列。
- [05 · 多方形态：链式还是群](issues/05-topology.md): 链式。不建群、不设 Lead 角色；多方由工作项的 from→to 图表达；一对多展开成 N 条工作项。
- [06 · 上下文：要不要接管 compaction](issues/06-context.md): 不接管。DSH 压缩不动最近历史，锚押在 `# now`；阈值与 per-model 配置都不动。
- [07 · 记忆：单文件够不够](issues/07-memory.md): 够。给 `# now` 装 16KB 上限并在注入侧截断（头+尾）；History 超限由宿主自动归档；`# now` 超限只报不搬；不做 topics 分层。
- [08 · IM：入站与升级到人](issues/08-im.md): 只在工作项 failed/blocked/超时时私聊 owner；done 不推；入站维持现状。
- [09 · 治理：失败可见、用量、密钥](issues/09-governance.md): status 改读账本；用量按需用 tokenMeter 聚合；不做密钥卡片、不做面板。
- [10 · 排序与首批](issues/10-sequencing.md): 四批。1 账本+状态机 → 2 记忆预算与一对多 → 3 升级到人 → 4 用量工具；每批一个可跑场景。
- [11 · 先修两处数据不一致](issues/11-data-integrity.md): 代码加「一 Session 一名」的写时守卫与载入告警；两处数据修掉，索引复查无重复。（**已实施**）
- [12 · 回合独占与邮箱](issues/12-turn-gate.md): 不搬 turn-gate，并入 04；`park` 与折叠不做。

## Not yet specified

<!-- 空：通往目的地的决策已全部落地。 -->

## Out of scope

- 重写 DSH 的 compaction / session API。
- 把 Halo 的 Electron runtime 或 UI 搬进来。
- 群聊 UI 的完整实现。
- **群/圆桌形态**：本版不做，另起一张图。素材在 01（ds-bot 群回合）、02（Halo team/board）、DSH `dsh-experimental-agent-team`（要求共享工作区，与本插件的「一人一工作区」冲突，需先解这个冲突）。
- **向 DSH 提新接口**（附件投递、旧会话登记工作区、归档会话唤醒）：本清单不依赖它们，另议。
