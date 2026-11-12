# 八角色交接试点 · 测量记录

状态：**机制链路已验证；八角色 token 对比未做**。

## 怎么跑的

隔离宿主：现有 `~/.dsh-sandbox`，端口 3099，独立 `DSH_HOME`。
临时 overlay 关掉 IM 与 MCP，数字人注册表指向 `digital-human/handoff-verification`。
不碰 3080 与生产注册表。

驱动方式：不用页面。用 URL token 换 `dsh-auth` cookie，再 POST `/api/digital-human`，
调用管理通道的 `chat.send`。它和 `digital_human_send` 走同一条投递路径。

两个合成角色：`pm-pilot`（派单方）与 `lead-pilot`（承接方）。
都关掉记忆、不给技能、只声明一个 peer。

## 链路结果

一轮跑通，全部产物落在需求目录：

```
reqs/交接试点-20261112/
  meta.json
  params.md
  state.json          nodes.handoff-verification.status=done，evidence 指向报告
  nodes/all-handoff-pilot.md
```

五步都通：派单送达 → 读摘要 → 写报告 → 标 done 带证据指针 → 回执。
`state.json` 同时满足新加的完成判据：结果写进指定文件，状态指向该文件。

## 三个实测发现

### 1. 沙箱跑的是 `build/host`，不是 `src/`

第一次跑，新规则没进提示词。原因：profile 链到插件目录，入口是 `build/host/index.js`，
而我只改了 `src/lib/presets.ts`。

`pnpm run build:host` 之后重跑，提示词里出现：
`阶段交接完成需同时满足：结果写入指定文件，状态指向该文件。`

**结论：改源码后必须重建，沙箱才看得见。**单测跑 TS 源码，不会暴露这个差异。

### 2. 极简角色仍然挂 39 个工具

`pm-pilot` 关记忆、无技能、单 peer、人设不到 300 字。它实际可见的工具：

```
bash web_fetch subagent subagent_fork workflow todo_write update_goal create_goal
present read_image interrupt_agent list_agents send_message wait_agent skill
digital_human_* (11) fs/edit/glob/grep/read/write ask_user_question set_session_title job_*
```

这来自 `src/lib/presets.ts` 的 `BASELINE_ROWS`：每个数字人都复制一份标准工具集。

两个后果：

- 在 profile 里禁用 `tool-web` **不管用**，数字人 preset 自己又挂了一份，`web_fetch` 仍在。
- 每个角色都为全部工具定义付费。之前实测工具定义约 26.6K tokens，是每次请求的固定成本。

`pm-pilot` 还调了 14 次 `bash`，尽管人设没让它用。工具多，行为就散。

### 3. 一轮简单交接用了 8 次模型调用

| 指标 | 值 |
|---|---|
| 模型调用 | 8 |
| 未命中输入 token | 24,308 |
| 缓存读 token | 68,544 |
| 合计 | 94,886 |

这是「派单 + 读摘要 + 写报告 + 标 done + 回执」的代价，还没算真实业务工作。

## 没做的事

- 没有跑完整八角色链路（分析/开发/部署/自测/端到端/上线准备）。需要真实需求与真实平台。
- 没有基线对比，所以**不能声称省 token**。
- 样本只有 1 轮，不足以下结论。

## 下次怎么跑

1. 用真实需求，走 3080 的生产角色，而不是合成角色。
2. 记录每个角色的 `inputTokens + cacheReadTokens`、交接消息字节、补问、重复派单、轮询、返工、缺证据次数。
3. 先测「收窄工具面」前后同一任务的两组数据，再谈收益。
