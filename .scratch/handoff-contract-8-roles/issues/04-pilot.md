# 04 · 沙箱试点与测量记录

Type: task
Status: resolved
Blocked by: 01, 02, 03

## What to build

在隔离沙箱跑交接，观察适用角色，记录测量数据。不碰 3080 与生产会话。

记录到 `.scratch/handoff-contract-8-roles/pilot.md`。

## Acceptance

- 交接只带事实与指针，没有整段报告或日志。
- 回执都是结论、证据路径、下一步三项。
- `pilot.md` 有数据，结论只写测量支持的。

## Answer

用现有 `~/.dsh-sandbox` 与 3099，不用页面：URL token 换 cookie，再 POST `/api/digital-human` 调 `chat.send`。

两个合成角色跑通完整交接：派单 → 读摘要 → 写报告 → 标 done 带证据 → 回执。
`state.json` 同时满足新加的完成判据。

三个发现，细节见 `../pilot.md`：

1. 沙箱跑 `build/host`；改源码后必须 `pnpm run build:host`。
2. 极简角色仍挂 39 个工具，来自 `BASELINE_ROWS`；profile 禁用 `tool-web` 无效。
3. 一轮简单交接 8 次调用、94,886 total token。

**未做**：完整八角色链路、基线对比、多轮样本。因此不声称省 token。
