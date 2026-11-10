# 06 — 灰度上生产与首条真实需求

Status: ready-for-agent

## Task

- 沙箱全绿后：analysis-assistant config/persona 同步进生产 `~/.dsh/digital-human/humans/`；lead/pm persona 与 peers 同步（02 的改动）。
- 选一条小规模真实需求（建议：一个中等复杂度缺陷修复，有一点接口/数据疑问但不深）走全链：lead 派分析 → 疑问真实经 PM 企微问触发人 → 答复 → spec/tickets → dev 按票开发。
- 首跑观察点：疑问对号是否靠 memory 挂起表兜住（记录实际行为）；24h 提醒是否只发一次。
- 数字人插件仓库若有代码改动（本次预计无，纯配置+persona），按仓库规范提交带 `#AI commit#`。

## Acceptance

- 首条需求走完全链，analysis 四件产物齐、dev 按票交付。
- 观察结论回填本票 Comments（对号行为、提醒行为、耗时）。

## Blocked by

05-sandbox-runs
