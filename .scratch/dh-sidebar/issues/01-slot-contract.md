# 01 · 侧栏替换的技术接缝

Type: research
Status: resolved

## Question

DSH 客户端里，替换"左侧会话列表"到底有哪几种可行接缝？

要回答：
1. `sidebar.chat` / `sidebar.chat.conversation` 这两个槽的契约：注册什么组件、拿到什么 props、能否整段替换列表。
2. ds-bot 是怎么做到的：它接管了哪些槽、还是自己渲染整个 layout。
3. 我们的插件现在注册了 `sidebar.panellist` + `main`，如果只想加"第二个侧栏面板"而不是替换，是否够用。
4. 会话行点击后如何切到该会话（导航 API 名称与参数）。
5. 同一时刻两个侧栏不能同时显示吗——有没有官方"视图切换"机制。

参考：`@deepseek-ai/dsh-client-ui-sidebar`、`ds-bot` 的 client.js、`dsh-client-ui-slots`。
结论写进本文件。

## Resolution

sidebar.workspaces 是 single/root 槽；ds-bot 用 shadow 抢占；结论见 ~/tmp/research/dh-sidebar-slots.md
