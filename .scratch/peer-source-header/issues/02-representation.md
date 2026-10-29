# 02 · 用哪种表示

Type: grilling
Status: resolved
Blocked by: 01

## Question

来源信息在"人类看到的正文"里应该长什么样？

- **A 拆成来源消息**：照 dsh-im，正文只留用户的话，来源变成独立一条（需要 01 证明可行）
- **B 注入为上下文**：不走消息正文，改成每轮注入的 prompt context（正文干净，但回看历史时看不到"谁发的"）
- **C 人类可读前缀**：保留在正文里，但从 `<dsh_peer_source from="x" … />` 改成 `来自 pm-assistant · 会话 rtcpc…`（不改机制，只改观感）
- **D 只给模型、不给界面**：从正文剥离后仅作为模型侧上下文，界面完全不显示

判据：谁需要看到"这条是谁发的"——人看会话时要不要知道？模型要不要？信箱要不要？

➡️ 推荐 A。它和 IM 保持一致，正文对人类干净，来源仍可点开查看。
## Answer

**A + A：拆成独立来源消息；模型侧文本不变。**

- 投递仍写「头部 + 正文」，因为 prompt RPC 带不了 message source（与今天一致）。
- 新增一个 `agent/pre-step` 钩子：把开头的 `<dsh_peer_source … />` 从 content 里剥掉，作为一条独立消息插回本轮批次：

```
{ role: 'user',
  source: { kind: 'plugin:digital-human', form: 'notice', summary: '来自 <名字> · 会话 <conversation>' },
  content: [{ type: 'text', text: '<dsh_peer_source from="…" session="…" conversation="…" />' }] }
```

- 折叠行显示 summary（≤120 字）；展开是原 XML，**模型读到的东西一个字不变**，所以人设里关于 `session_id` 回执的说明不用改。
- 失败回退：拆不出来就把块留在原文（和 dsh-im 一样），绝不让用户丢消息。
- 已知代价：消息还在队列里时，queue dock 显示的是原始文本；这是 DSH 的显示细节，不影响落盘。

**不采用**：C（人类可读前缀，正文仍脏）、B（注入上下文，历史里看不到谁发的）。
