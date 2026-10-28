# 07 · 记忆：单文件够不够

Type: grilling
Status: resolved

## Question

`memory.md`（`# now` + `# History`，100KB 归档重建）要不要分层？

## 现状

- 每轮注入整份 `memory.md`（`memory.ts:300` renderMemoryContext）。
- 实测（2026-10-28）：`pm-assistant` persona 39,950 B + memory 71,282 B ≈ 111 KB/轮；`dev-assistant` 20,318 + 42,836 ≈ 63 KB/轮。中文按 1.5 B/字估，约 4–7 万 token 的固定前缀。
- Halo：分层 + consolidation（合并重复、按 topic）+ snapshot。
- ds-bot：每个 Bot 一份 + 团队共享一份。

## 可选

- **A 只改注入**：每轮只注入 `# now` + 最近 N 条 History，全量留给工具查。
- **B 加 `topics/`**：`now` / `topics/<主题>.md` / `history`，按需读。
- **C 加 consolidation**：定期用小模型合并（要额外模型调用）。

➡️ 推荐 A 先做（成本最低、立刻省 token），B 视使用情况再上，C 最后。
## 侦察补充：Halo 给了可直接抄的数

- 注入预算：数字人 `# now` ≤ **16KB** + 最近 **8** 条 History（`section.ts:44-52`）；超预算按 `##` 边界切，并自动闭合未闭合的代码围栏（`:118-150`）。
- ≤30 行整篇注入，否则只注入 `# now` + 最近 History 标题（`snapshot.ts:54-56,100-104`）。
- topics 索引每次由 frontmatter 现算，**不落盘**（`topics.ts:1-12`）。
- consolidation 三档；balanced = 200KB / now 16KB / 60 条 / 4h，失败冷却按 `1+0.2×2^(n-1)` 退避（`consolidation.ts:146-156,212-240`）。
- 安全阀：先复制到 `.consolidation/` → 校验无内容丢失 → 基线比对后提交 → 旧版进 `.snapshots/`（`consolidation.ts:430,552,643`）。

➡️ **修订**：A 直接照 Halo 的数（16KB + 8 条），半天量级；C 的判据与安全阀可搬，但先只做"超限裁 History"。
## Decisions

- Q1 预算：`# now` ≤ **16KB**。
- Q2 截断：按 `##` 边界保留前若干节，尾部一行说明省略量；单节超预算则按行截，同样说明。
- Q3 触发：`# now` > 16KB **或** 整份 > 100KB，取先到。
- Q4 History：注入最近 **8 条标题**（一行一条，不带正文）。
- Q5 `# now` 超预算：**只截断 + 报 status，不自动搬**——丢工作记忆必须是模型的决定。
- Q6 History 超预算：**自动**归档最旧部分到 `memory/<时间戳>.md`，保留最近 N 条（机械、无损、可回查）。
- Q7 `memory_compact` 语义：保留整份归档（回滚用），新增「只归档 History、保留 `# now`」的日常路径。
- Q8 topics 分层：不做，先看预算能否让模型自己拆节。

## Answer

**注入（每次组装，纯读）**

1. 文件 ≤30 行：整篇注入（现状）。
2. 大文件：`# now` 按预算截断注入，另加最近 8 条 History 标题。
3. 截断处必须写明省略了多少——不能让模型以为自己看全了。

**信号**

- `needsCompaction` 改看 `# now` 与总量，取先到。
- `memory_status` 增报每节字节数，把超预算的节标出来，附一句「建议拆成 N 节」。

**动作边界（关键区别）**

| 对象 | 超预算时 | 为什么 |
|---|---|---|
| `# History` | 宿主自动归档最旧部分 | 机械、无损、可回查 |
| `# now` | 只截断 + 报告 | 自动搬等于静默丢工作记忆 |

**触发时机**：History 归档挂在回合结束事件上（与 04 的 `turn/end` 消费共用同一处订阅）。

**不做**：topics 三层、consolidation agent、自动重写 `# now`。
## 后续修订（来自 06）

06 把「压缩后的当前任务」锚在 # now 上。因此 # now 按行截断时**保留尾部（最新）+ 头部 State**，中间省略，而不是只留开头。

原 Q2 写的「保留前若干节」对多节文件成立；对单节超长文件（pm 那种）改成「头 + 尾，中间省略」。
