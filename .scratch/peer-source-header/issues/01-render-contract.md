# 01 · 拆分接缝与渲染契约

Type: research
Status: resolved

## Question

照 dsh-im 的做法拆来源块，在我们这个插件里可行吗？需要哪些确切事实：

1. `agent/pre-step` 的 decision 形状：`messages` 里一条消息的 `content` 允许哪些 part；替换后框架会不会重新校验。
2. `source` 字段允许哪些值：`kind:'plugin:<id>'` 是否任意插件可用，还是要先注册；`form:'notice'|'context'|…` 的取值表。
3. 客户端对 `plugin:<未知id>` 的 source 怎么渲染：一行"来源"、折叠块、还是当普通用户消息。
4. dsh-im 的 `contextMessage()` 里 `id` 由谁生成（`newId`），替换消息时 id 冲突的风险。
5. 拆分失败时的回退：dsh-im 是"块留在原文"，我们照抄会不会把正文弄脏或丢消息。

答案写进本文件。
## Answer

**可行。** 完整报告：`~/tmp/research/peer-source-split.md`

1. `agent/pre-step` 的 `enter` 分支可以整批替换 `messages`；返回 `{...decision, messages}` 是第一方写法（`dsh-agent/lib/types/runtime-types.d.ts:91-99`、`dsh-agent-loop/lib/index.js:1066-1073`）。
2. `source.kind='plugin:<id>'` **无需注册**，是框架给未知 producer 的保留命名空间；运行时只要求非空字符串，只有裸 `plugin` 被拒（`dsh-session-format-v3-to-v4/lib/index.js:86-93`、`dsh-session/lib/index.js:1204-1206`）。
3. 客户端只看 `source.kind`：不等于 `'user'` 就折叠成「上下文注入」行，不进用户气泡，label 原样显示 `plugin:id`（`dsh-client-ui-chat/lib/client.js:9857,7746-7771`）。
4. `form:'notice'` 必须带 `summary`（≤120 字符）；`text` part 足够。
5. 拆分失败要回退成"块留在原文"，dsh-im 就是这么兜的。

**对我们的约束**：我们的投递走 `sessionController.prompt`，而 prompt RPC 不能携带 message source——所以"直接发两条消息"这条近路对我们不成立，只能走 pre-step 拆分。
