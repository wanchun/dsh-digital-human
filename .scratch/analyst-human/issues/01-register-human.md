# 01 — analysis-assistant 建档（config + persona）

Status: resolved

## Task

在生产注册表（先沙箱）新增 `analysis-assistant`：

- config：skills `[grilling, to-questionnaire, to-spec, to-tickets, triage, dpms-cli, apidesign-query]`；peers `[lead-assistant, pm-assistant]`；im 留空（不注册 notify_bot）；sessionMode thread；sessionKey requirement；memory true。
- persona（≤600 字正文，按 docs/agents/writing.md）：状态机五态、唤醒先读 questionnaire 状态、Q 未清只补问、Q 清零一气呵成到回执 lead、24h 经 PM 提醒一次、产出只写 `analysis/` 四件。
- 中文人设名「需求分析」。

## Acceptance

- 沙箱注册表出现该 human，preset `dh-analysis-assistant` 可被 lead/pm resolve。
- persona 行数与字数合规；无 IM 工具注册（工具面检查）。

## Blocked by

(none)
