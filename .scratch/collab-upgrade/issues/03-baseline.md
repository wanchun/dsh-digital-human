# 03 · 现状基线

Type: research
Status: resolved

## Question

数字人插件现在真实具备什么、缺什么？缺口按「是否卡住协作」排序。

## 线索

`src/index.ts`（宿主行）、`src/lib/{chat,tools,memory,im,presets,store}.ts`、README 的「已知限制」7 条。

答案见 `~/tmp/research/digital-human-baseline.md`。
## Answer

完整报告：`~/tmp/research/digital-human-baseline.md`（254 行）。

**结论**：插件在"寻址与会话复用"上已经比 ds-bot 严谨（显式地址、拒绝静默 main 桶、edges 四级回执），缺的不是消息能力，是**任务状态**与**结果可见性**。

**最卡协作的六条（带证据）**
1. 状态只读会话列表首页 → 协作方被误判 idle（`src/lib/chat.ts:411-419`）。
2. 无完成回执、不消费 `turn/end`（`src/index.ts:833-850` 已有订阅点，没用上）。
3. 地址索引无唯一性：两个线程名可指向同一 Session，现场已出现（`pm-assistant/sessions.json:2-3`）。
4. 归档会话可被收养，投递才被拦——失败发生在"看起来成功之后"。
5. 投递不幂等：每次 `randomUUID`（`src/lib/chat.ts:666`），无法去重。
6. 记录改 preset/工作区 → 会话只能重开，历史丢失。

**另外发现的两处不一致（顺手记下，先不修）**
- 记忆归档写 `memory/`，状态读 `memory/run/`（`memory.ts:44,121-129` vs `175-188`）。
- `HumanSubscription` 类型没有 `conversationId`，store 却接受并落盘。

**缺口对照表共 15 条**，其中 1/2/3/9/14/15 与"多数字人协作"直接相关；报告里每条都标了"补它要动哪里"。
