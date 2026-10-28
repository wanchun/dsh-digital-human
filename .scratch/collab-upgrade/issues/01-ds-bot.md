# 01 · ds-bot 借什么

Type: research
Status: resolved

## Question

DS Bot 插件（v0.1.6）里哪些机制值得搬进数字人插件？重点是上下文管理、群聊回合制、记忆、权限矩阵、投递状态机。

## 线索

- 上下文：`src/host/steward.js`（check line 0.8、switch/compact 判据）、`parts.js`、`chat-index.js`（FTS5）
- 群聊：`groups.js`（一人一轮、@Name 传回合、[PASS]）
- 记忆：`memory.js`（per-bot + team shared）
- 权限：`permissions.js`、`roster.js`（Main Bot / group admin / member）
- 投递：`turns.js`、`delivery.js`、`channel.js`

答案见 `~/tmp/research/ds-bot-mechanisms.md`。
## Answer

完整报告：`~/tmp/research/ds-bot-mechanisms.md`（282 行，结论均带 file:line）。

**可搬且便宜的三件**
1. **secrets 卡片 + 三层脱敏**（`secrets.js:441-525`）：值只进 `secrets.json` 与 shellEnv，模型只拿卡片。出口、入口、shell 三处替换，短值 <8 字符只替换独立出现。
2. **记忆的"回合后 review"**（`memory.js:1339-1366`）：Session 变 idle 后，用**该数字人自己的模型**读增量消息，输出 add/edit/remove。纯文件 + `systemPrompt.section` 冻结，无私有 API。
3. **防空转四道闸**（`constants.js:23-29`）：hop≤6、未读≤10、无人值守≤40、群轮次≤3。纯常量 + 计数。

**价值最高但最贵的一件**
- **steward 判据 + 交接条结构**（`steward.js:29-41,110-130`）：switch/compact 二选一，交接条 8 个固定标题。
- 但 ds-bot 的实现是 **monkey-patch DSH compaction 引擎**（`parts.js:197-240`，用 `Symbol.for` 存原方法），升级即碎。
- 结论：**只借 prompt 与判据，不借补丁**。到线就换 Session + 固定模板交接，200 行版本够用。

**明确不借**：FTS5 索引（追平/封印/重建一整套）、555 行 `turns.js` 全量折叠、`llm/stream` 伪造 tool-call 做群 relay、`inflight.json` 补发式恢复。

**对 05（群）的输入**：`mentions.js`（65 行）可原样搬；串行 slot 循环约 150 行。可行性比预想高，但代价是"等一个人说完才能轮到下一个"，延迟线性叠加。
