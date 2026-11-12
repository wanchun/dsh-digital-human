# 03 · 角色级交接例外（三处，仅三处）

Type: task
Status: resolved

## What to build

只改三个具体不一致。不重写八份人设，不做四段式清理（那是后续写作规范工作）。

1. **PM → 负责人派单没有显式要求回执。** PM 把已确认事实派给负责人时，补 `expect_receipt: true`。
2. **负责人派端到端的条件偏宽。** 改成只在确需浏览器验证或跨系统链路时派；纯后端走自测。
3. **上线准备派单缺证据入口。** 负责人派上线准备时带请求事项与证据路径；上线准备收到时缺证据就回要。

## Files

- `~/.dsh/digital-human/humans/pm-assistant/persona.md`
- `~/.dsh/digital-human/humans/lead-assistant/persona.md`
- `~/.dsh/digital-human/humans/release-assistant/persona.md`

改完同步快照到 `~/.dsh/digital-human/personas/` 并提交（提交信息末尾 `#AI commit#`）。

## Acceptance

- 三份人设各只改上述一处，没有顺带改别的段落。
- 快照仓库工作区干净，一次提交包含三份改动。

## Answer

三处各改一行，无顺带改动。

- `humans/pm-assistant/persona.md`：第 6 条派单补 `expect_receipt: true`。
- `humans/lead-assistant/persona.md`：派节点映射里端到端改为「确需浏览器验证或跨系统链路才加派，纯后端不派」；补「上线准备 → release-assistant，人明确发起时才派，带请求事项与已完成的自测、部署证据路径」。
- `humans/release-assistant/persona.md`：「什么时候开始」补一行——派单要带请求事项与已完成的自测、部署证据路径，缺证据回发起人要。

快照仓库 `~/.dsh/digital-human/personas` 提交 `f2c7092`（3 files changed, 3 insertions, 2 deletions）。

这些文件不在插件仓库，本仓库 diff 无法核验；核验方式是 `grep` 三份人设的对应行，见上。
