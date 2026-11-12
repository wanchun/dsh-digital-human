# 04 · 沙箱试点与测量记录

Type: task
Status: ready-for-agent
Blocked by: 01, 02, 03

## What to build

在隔离沙箱跑一条真实需求，观察八角色里**适用的**交接，记录测量数据。不碰 3080 与生产会话。

记录到 `.scratch/handoff-contract-8-roles/pilot.md`：

- 每个角色的单次请求输入 token（`inputTokens + cacheReadTokens`）。
- 每次交接消息的字节数。
- 补问次数、重复派单次数、状态轮询次数、返工次数。
- 缺失证据的次数。

## Acceptance

- 试点走完 PM → 负责人 → 开发 → 部署 → 自测（有页面或跨系统验证需求才加端到端）。
- 每次交接只带事实与指针，没有整段报告或日志。
- 回执都是结论、证据路径、下一步三项。
- `pilot.md` 有数据，结论只写测量支持的。没有数据支持的不要写成收益。

## 边界

如果沙箱起不来或没有可用需求，把阻塞原因与已试路径写进 `pilot.md`，标 `Status: blocked`，不要伪造数据。
