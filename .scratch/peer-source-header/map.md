# Map: 数字人的来源头不该出现在正文里

## Destination

数字人之间互发的消息，**来源信息不再作为可见正文渲染**，同时模型仍然拿得到发件人、会话与回执地址。终点是一份定下来的表示方案 + 落点，不是实现。

## Notes

- 事实基线（已查）：dsh-im 把 `<dsh_im_source>` 写成**独立的 text part**，再在 `agent/pre-step` 里拆成一条 `source.kind='plugin:dsh-im'` 的消息；我们写在同一 part 里且从不拆，所以整块按原文渲染。
- 接缝是公开的：`ctx.on('agent/pre-step', async ({agent}, next) => …)`，返回 `{...decision, messages}` 即可替换本轮消息。
- 约束：保持零运行时依赖；不改 dsh-im；信箱（`conversations/*.jsonl`）是给人看的记录，读取工具 `digital_human_messages` 的呈现要一并考虑。

## Decisions so far

<!-- 关闭的工单，一行一条 -->

- [01 · 拆分接缝与渲染契约](issues/01-render-contract.md): 可行。`plugin:<id>` 免注册、非 user 来源自动折叠成上下文行；我们只能走 pre-step 拆分（prompt RPC 带不了 source）。
- [02 · 用哪种表示](issues/02-representation.md): 拆成独立 `plugin:digital-human` 通知消息；折叠行给人看，展开仍是原 XML，模型侧零改动。
- [03 · 历史与信箱怎么办](issues/03-history-and-mailbox.md): 只对新消息生效，不回填；钩子只认自己的标签；队列里的旧格式消息不需要迁移。
## Not yet specified

<!-- 空：所有决策已落地 -->

## Out of scope

- 改 dsh-im 的 source 格式或渲染。
- 让 DSH 客户端支持自定义 source 的样式。