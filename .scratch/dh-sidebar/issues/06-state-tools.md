# 06 · 三个需求状态工具

Type: task
Status: resolved

## Question

库函数已在 src/lib/requirements.ts：readState / writeState / renderDigest / attachFile。
把三个工具接到 tools.ts，并给 create 补 render（现在 gaps.test 因此红）。

- digital_human_requirement_read({ requirement }) → renderDigest
- digital_human_requirement_update({ requirement, node, status, note?, evidence? }) → 写入 state.json 后返回摘要
- digital_human_requirement_attach({ requirement, name, content, kind? }) → 返回绝对路径

requirement 参数可以是线程名或目录名，用 findRequirementDir 解析；解析不到就报错，不猜。
不许硬编码任何需求名或路径。三个工具都要 output.render（返回 detail 或 JSON），否则 gaps.test 遍历时崩。

## Resolution

已实现并验证：commit b779739，797 用例全绿
