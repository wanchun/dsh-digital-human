# 02 — 上下游 peers 与 lead 节点映射

Status: resolved

## Task

- lead-assistant：peers += `analysis-assistant`；persona 节点映射加「分析 → analysis-assistant」（facts 带需求目录、六项、验收口径）；跳过判据写入（纯漏洞修复/单点小改/已有明确规格 → 直接派 dev 并在 progress.md 记一句理由）。
- pm-assistant：peers += `analysis-assistant`；persona 增「待答疑问转发」规则——收到带 peer_source 且标【待答疑问】的消息：notify_bot 私发触发人（问题带 Q 编号）；memory 记挂起表一行（需求名 → 未答 Q + 来源会话）；触发人回复到达后按挂起表对号，digital_human_send(to=analysis, requirement=需求名, facts=自包含答案)；答复未闭合不转发。

## Acceptance

- 三方 peers 白名单闭环：analysis↔lead、analysis↔pm 双向可发（非 peer 发送报错文案正确）。
- pm persona 新规则与既有 B 阻塞流程不冲突（转达职责单一写者）。

## Blocked by

01-register-human
