# 01 · 运行时协作规则补齐共同交接语义

Type: task
Status: resolved

## What to build

共享规则位于 `renderOperatingContext` 的「与同伴协作的规则」段。
它已有寻址、回执和收件箱用法，但缺交接判据。

## Acceptance

- 协作规则段补齐缺的语义，每条只出现一次。
- 新增单测（`test/unit/presets.test.ts` 既有写法）：断言语义存在。
- 不锁死整段提示词原文，只断言必需语义。
- `presets.test.ts`、`tools.test.ts` 全过。

## Seam

`src/lib/presets.ts` 的 `renderOperatingContext`；测试走 `test/unit/presets.test.ts`。

## Answer

**复审修复已收敛。**

第一版把字段规则重复写入运行时提示。
重复项是 `facts`、`context`、`message` 和 `expect_receipt`。
这违反写作规范第 2 条：同一规则只写一处。

复审只保留工具未声明的两条。
两条都在 `src/lib/presets.ts` 的协作段：

1. `需求状态、证据与报告内容属于需求记录。记忆只放跨需求可复用的结论和未闭环口径。`
2. `阶段交接需同时满足：结果写入指定文件，状态指向该文件。`

字段规则留在 `digital_human_send` schema。
运行时提示不再复制。

`test/unit/presets.test.ts` 覆盖三项：

- 需求记录与记忆的分工存在（含「报告内容」）。
- 阶段交接的完成判据存在。
- 字段级规则**不在**运行时段：`expect_receipt`、`facts`、`digital_human_requirement_read` 都不出现。
- 这项测试保证规则不重复。

测试断言语义，不锁整句原文。
切片函数找不到标题时会报错。
它不会用空串通过断言。

本次实测：单测 23 文件、867 项通过。
类型检查通过。集成 483 项通过。
