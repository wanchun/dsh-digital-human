# 03 · 历史与信箱怎么办

Type: grilling
Status: resolved
Blocked by: 02

## Question

改成新表示之后，旧数据怎么处理？

1. 已存在会话里的历史消息带着旧内联头 —— 只让新消息生效，还是回填/清洗？
2. 信箱 `conversations/*.jsonl` 里的 `inbound` 记录带不带来源？`digital_human_messages` 读出来要不要展示发件人？
3. 已经发出去、还没被读的消息，按旧格式写入，新代码读到会不会出问题？
## Answer

- **Q1 历史消息：只管新消息（A）。** 会话是 append-only，改写历史既无公开 API，也会让记录与事实不符。旧会话里那几行保留。
- **Q2 只处理自己的标签（A）。** 钩子只认开头的 `<dsh_peer_source … />`，不碰 `<dsh_im_source>`——IM 有自己的 splitter，重叠会拆两次。
- **Q3 队列里的旧格式消息不需要迁移。** pre-step 每轮都先尝试拆，旧消息在第一个人读它时自然被处理。
- **旧消息与历史回放同一条路径。** 队列里的旧消息与历史回放走同一条解析路径，不需要迁移。

**补充事实**：信箱本来就不含头部——`inbound` 记录里 `text` 是正文，`from` / `session` / `conversation` 是独立字段（`src/lib/chat.ts:721-727`）。所以 `digital_human_messages` 不需要改。
