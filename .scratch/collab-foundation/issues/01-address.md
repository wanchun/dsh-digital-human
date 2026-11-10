---
title: 01 地址只来自事实
labels: [ready-for-agent]
---

## Question

按 spec 的「地址解析」实现：

1. digital_human_send 删除 session_id 参数与描述（含测试）。
2. 聊天键记录的投递：读需求的 meta.json 里的 trigger.chatId，投进与之匹配的会话；
   找不到就报错（说明缺触发人），**不得**再取「索引里最新会话」。
3. 需求键记录维持 requirement 线程名寻址；带 requirement 时忽略任何地址记忆。
4. edges 只记录，不参与寻址（检查 threadTarget 是否仅用于回执寻址，若是则保留其回执用途）。

不做：索引重建逻辑（索引已定位为缓存，缺失时按现有代码路径处理即可）。