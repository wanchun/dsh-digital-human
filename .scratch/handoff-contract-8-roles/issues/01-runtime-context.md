# 01 · 运行时协作规则补齐共同交接语义

Type: task
Status: resolved

## What to build

共享运行时协作规则（`renderOperatingContext` 的「与同伴协作的规则」段）只写了寻址、回执三项和收件箱用法。它缺共同交接规则。

## Acceptance

- 协作规则段补齐缺的语义，每条只出现一次。
- 新增单测（`test/unit/presets.test.ts` 既有写法）：断言语义存在。
- 不锁死整段提示词原文，只断言必需语义。
- `presets.test.ts`、`tools.test.ts` 全过。

## Seam

`src/lib/presets.ts` 的 `renderOperatingContext`；测试走 `test/unit/presets.test.ts`。

## Answer

**首次实现走偏，已按审查收敛。**

第一版把四条字段语义都写进运行时规则，重复了 `digital_human_send` 已逐字段声明的内容（`facts` / `context` / `message` / `expect_receipt` 的参数描述）。这违反 `docs/agents/writing.md` 九条判据第 2 条「同一条规则只写一处」。

收敛后只补**没有任何工具声明**的两条，都在 `src/lib/presets.ts` 的协作规则段：

1. `需求状态、证据与报告内容属于需求记录。记忆只放跨需求可复用的结论和未闭环口径。`
2. `阶段交接算完成，要结果已写入指定文件，且状态指向该文件。`

字段级规则留在 `digital_human_send` 的 schema 里，运行时不再复制。

`test/unit/presets.test.ts` 三个用例：

- 需求记录与记忆的分工存在（含「报告内容」）。
- 阶段交接的完成判据存在。
- 字段级规则**不在**运行时段：`expect_receipt`、`facts`、`digital_human_requirement_read` 都不出现。这条锁住「不重复」这个设计决定。

测试只断言语义，不断言整句原文。切片函数在找不到标题时抛错，不会拿空串蒙过断言。

验证：全量单测 869/869，typecheck 干净，集成 42/42。
