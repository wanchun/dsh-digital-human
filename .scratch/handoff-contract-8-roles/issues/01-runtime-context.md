# 01 · 运行时协作规则补齐共同交接语义

Type: task
Status: ready-for-agent

## What to build

共享运行时协作规则（`renderOperatingContext` 的「与同伴协作的规则」段）只写了寻址、回执三项和收件箱用法。它缺两类共同规则：

**派单字段语义**

- `facts`：已确认的事实与相关文件的绝对路径。
- `context`：一句话进度，加上一步结论的路径，不贴全文。
- 正文：要什么结果、验收判据、要什么证据。
- `expect_receipt`：派活才带；提问、答复、回执、取消不带。

**上下文读取与写入分工**

- 每轮先读需求摘要（`digital_human_requirement_read`），不重读历史会话。
- 只读当次任务需要的文件；路径从摘要或派单的 `facts` 取。
- 需求状态与证据属于需求记录；记忆只放跨需求可复用结论与未闭环口径。

不要写工具已经拒绝的字段清单（步骤、命令、注意事项）。机制已保证的事不重复写。不要复制写作规范整段。

## Acceptance

- 协作规则段包含上述语义，每条只出现一次。
- 新增单测（`test/unit/presets.test.ts` 既有写法）：断言上述语义存在，且禁止字段清单没有被重复陈述。
- 不锁死整段提示词原文，只断言必需语义。
- `presets.test.ts`、`tools.test.ts` 全过。

## Seam

`src/lib/presets.ts` 的 `renderOperatingContext`；测试走 `test/unit/presets.test.ts`。
