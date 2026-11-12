# 03 · 角色级交接例外（三处，仅三处）

Type: task
Status: resolved

## What to build

只改三处不一致。
不重写八份人设，也不清理四段式结构。
四段式清理留给后续写作规范工作。

1. **PM 派单缺回执要求。** 派已确认事实时，补 `expect_receipt: true`。
2. **端到端派单条件偏宽。** 仅在需要浏览器或跨系统验证时派。纯后端走自测。
3. **上线准备缺证据入口。** 派单带请求事项和证据路径。缺证据时回发起人索取。

## Files

- `~/.dsh/digital-human/humans/pm-assistant/persona.md`
- `~/.dsh/digital-human/humans/lead-assistant/persona.md`
- `~/.dsh/digital-human/humans/release-assistant/persona.md`

修改人设后同步快照并提交。提交信息须以 `#AI commit#` 结尾。

## Acceptance

- 三份人设各只改上述一处，没有顺带改别的段落。
- 快照仓库工作区干净，一次提交包含三份改动。

## Answer

三处各改一行，无顺带改动。

- `humans/pm-assistant/persona.md`：第 6 条派单补 `expect_receipt: true`。
- `lead-assistant/persona.md`：端到端仅用于必要验证。
  上线准备须由人明确发起，并带请求和自测、部署证据路径。
- `release-assistant/persona.md`：派单须带请求和自测、部署证据路径。
  缺证据时回发起人索取。

快照仓库提交为 `f2c7092`。
该提交改了三个人设文件。

这些文件不在插件仓库。
本仓库 diff 无法核验。
核验见上文三份人设的对应行。
