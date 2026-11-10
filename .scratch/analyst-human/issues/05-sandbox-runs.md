# 05 — 沙箱用例 U1–U4 执行

Status: resolved

## Task

在 3099 沙箱跑四条用例，全程留证（会话 jsonl + 产物路径 + 判定记录）：

- **U1 正常流**：PM 建档（模拟触发人消息）→ lead 派「分析」→ analysis 产出 spec + ≥3 票全 ready → decision 放行 → lead 照票派 dev。断言：dev 收到的 facts 含 tickets 路径。
- **U2 答复回环（核心）**：需求 A 分析中产生 2 个 Q → analysis 发 PM → PM 私发（模拟企微文案生成即可）→ 向 PM 会话注入触发人回复「Q1:…」→ PM 对号回传 → analysis 续跑至清零。**加压**：需求 B 同时挂起，先回 B 的答案再回 A 的，断言不串线。
- **U3 跳过流**：小修复需求（漏洞单样例）→ lead 判断跳过分析直接派 dev → progress.md 含跳过理由一行。
- **U4 隔离**：全程结束后生产 tasks.jsonl mtime 与启动前一致；3099 会话数与沙箱注册表吻合。

失败处理：任何断言失败记入本文件 Comments，修复后重跑该条用例（不重跑全量）。

## Acceptance

- 四条全过，判定记录落 `.scratch/analyst-human/verification.md`。
- U2 的双需求交错场景明确标注通过/失败与证据指针。

## Blocked by

04-sandbox-env

## Comments

### 2026-11-08 16:20 环境与注册验证（U0 前置）
- 沙箱宿主 3099 运行中（pid 86245，DSH_HOME=~/.dsh-sandbox），3080 生产未动。
- 3099 数字人面板确认：数字人（4）含「需求分析 analysis-assistant」，preset dh-analysis-assistant，人设/七技能勾选/peers(pm+lead)/IM 不绑定/按线程会话/持久记忆 全部与 spec 一致。
- headless 通道已打通（zhipu glm-5.3-zp，需 ZHIPU_API_KEY 环境变量注入）。
- 生产隔离快照已存 /tmp/u4_before.txt（三份 tasks.jsonl mtime 停留在上午）。
- U1 测试需求目录已建：reqs/u1-demo-feature-20261108（params.md 六项 + meta.json + state.json）。
