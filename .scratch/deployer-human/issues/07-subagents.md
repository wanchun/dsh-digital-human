# 07 · 用子 agent 提并发

Type: grilling
Status: resolved
Blocked by: 04

## Question

用户要求：自测助手与部署助手都用子 agent 做事，提高并发。要写成可执行规则，得定边界：

1. **哪些动作可以并行**：只读（查流水 / 查包 / 查占用 / 查日志 / 查库 / 跑只读 SQL）可以；写（触发部署、发布、改流水分支）必须主会话串行，否则绕过预约表。
2. **子 agent 能不能派活**：不能调 `digital_human_send` / `notify_bot`——一旦允许，就出现第二个调度点。
3. **并发上限**：一次派单最多起几个（token 成本 vs 墙钟时间）。
4. **结果形态**：子 agent 只回结论 + 证据指针（路径/命令/session id），不回全文。

➡️ 推荐：
- 读并行、写串行；
- 子 agent 禁用协作类工具；
- 单次 ≤4 个子 agent；
- 结果只回结论与指针。

依据：子 agent 是独立上下文，看不到主会话的预约表；让它们写等于把锁交给看不见的人。
## Answer

**全部交给子 agent**（用户口径：不要拆"写归主会话、读归子 agent"，太复杂）。

主会话只做两件事：**拆单**（按 (子系统, 环境) 拆）、**汇总**（把子 agent 的结论回给 PM）。

每个子 agent 自己走完一条发布：

```
mkdir occupations/<子系统>@<环境>     # 原子拿锁，失败即"已被占用"
→ 查流水 / 校验构建分支（不一致先 update-pipeline）
→ 记 triggerId 基线 → 触发 → 轮询到 SUCCESS / FAIL（比对 triggerId）
→ 写终态 → rmdir 释放 → 回报结论
```

规则：
- **锁是目录，不是内存**：`mkdir` 原子，跨进程跨上下文都成立；崩溃时锁会残留，靠"启动时按 triggerId 复查"回收。
- **子 agent 禁用协作工具**（`digital_human_send` / `notify_bot`），它只对主会话说话。
- **单次 ≤4 个**子 agent。
- **只回结论 + 指针**（triggerId、包名、环境、证据路径），不回全文。
