# 04 — 沙箱环境搭建（3099 端口独立宿主）

Status: resolved

## Task

按 dsh-digital-human-debug 技能搭沙箱，特别注意与生产分离：

- `DSH_HOME=~/.dsh-sandbox`；数字人目录指向沙箱（插件 config home 覆盖）。
- **沙箱 web 宿主起 3099 端口**：`DSH_HOME=~/.dsh-sandbox dsh web --port 3099 --no-open`。生产 3080 不动。
- 关闭沙箱内 IM 插件（xmanrui-dsh-im disabled）——U2 的企微环节用「直接向 PM 会话注入 user/message」模拟触发人回复，不走真实企微。
- profile 复用生产 node_modules（软链）；credentials 拷贝；沙箱数字人注册表含 pm/lead/analysis/dev 四个即可（qa/deploy 不参与用例）。

## Acceptance

- 3099 可访问（curl 200），3080 生产不受影响。
- 沙箱内 humans 注册表与生产完全独立（生产 humans 目录无新文件）。
- 基线：验证前后生产 `~/.dsh/digital-human/humans/*/tasks.jsonl` mtime 不变。

## Blocked by

01-register-human, 02-peers-and-lead, 03-artifacts
