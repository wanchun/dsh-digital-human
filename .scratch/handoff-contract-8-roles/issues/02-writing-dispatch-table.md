# 02 · 写作规范的派单表补 message 与 expect_receipt

Type: task
Status: resolved

## What to build

`docs/agents/writing.md` 的「派单」表只有 requirement / task_id / node / facts / context 五行。规格另外定义了正文与回执开关的语义，表里没有，实现者读不到。

补两行：

- `message`：要什么结果、验收判据、要什么证据。
- `expect_receipt`：派活才带；提问、答复、回执、取消不带。

同一段已说明工具会拒绝步骤、命令、注意事项，不要重复第二遍。

## Acceptance

- 派单表含 `message` 与 `expect_receipt` 两行，措辞与规格一致。
- 派单段内「禁止字段」只陈述一次（沿用既有那一行）。
- 文档仍符合 ASD-STE100 的 80%。

## Answer

`docs/agents/writing.md` 派单表在 `context` 后补两行（现 73–74 行）：

- `message`：正文写要什么结果、验收判据、要什么证据。
- `expect_receipt`：派活才带。提问、答复、回执、取消不带。

`message` 行只写正向内容。派单段内的「禁止字段」仍只有第 76 行一处。

口径说明：`writing.md` 另有校对清单「派单没有步骤、命令、注意事项」与九条判据第 5 条「步骤、命令、注意事项不传」。这两处是既有内容，属不同小节、不同句式，不是本次新增的重复，本次未改。

提交 `926b126`（1 file changed, 2 insertions），已合入集成分支。
