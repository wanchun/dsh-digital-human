# 02 · 写作规范的派单表补 message 与 expect_receipt

Type: task
Status: resolved

## What to build

`docs/agents/writing.md` 的派单表缺两行。
规格定义了 `message` 和回执开关，但表中没有。
实现者因此读不到这两项。

补两行：

- `message`：要什么结果、验收判据、要什么证据。
- `expect_receipt`：派活才带；提问、答复、回执、取消不带。

工具拒绝步骤、命令和注意事项。
同一段不重复说明。

## Acceptance

- 派单表含 `message` 与 `expect_receipt` 两行，措辞与规格一致。
- 派单段内「禁止字段」只陈述一次（沿用既有那一行）。
- 文档仍符合 ASD-STE100 的 80%。

## Answer

`docs/agents/writing.md` 派单表在 `context` 后补两行（现 73–74 行）：

- `message`：正文写要什么结果、验收判据、要什么证据。
- `expect_receipt`：派活才带。提问、答复、回执、取消不带。

`message` 行只写正向内容。
派单段内的禁止字段仍只写一处。

口径说明：校对清单与判据第 5 条也提到步骤、命令和注意事项。
它们属于既有内容，位于不同小节。
本次没有修改这两处。

提交 `926b126`（1 file changed, 2 insertions），已合入集成分支。
