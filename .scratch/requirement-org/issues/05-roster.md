# 05 · 记录描述进提示词

Type: task
Status: open

## Question

数字人的 `description` 字段存在，但没进提示词——模型只看到 `Your peers are: \`dev-assistant\`, \`qa-assistant\``。

要改成带描述的清单（数据读注册表，改记录即生效）。改动点：`src/lib/presets.ts` 的 peer 行 + 单测。
