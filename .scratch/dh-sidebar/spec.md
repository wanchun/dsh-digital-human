---
title: 需求级数字人组织（完整规范）
labels: [ready-for-agent]
---

## Problem Statement

一条"改两份文档"的需求烧掉约 9.3M 未命中缓存的输入 token；执行产物（轮询脚本、review 报告）落在工作区根而不是需求目录；负责人会话被静默重建并从头再来；PM 与负责人对"当前到哪一步"各有说法。根子是同一个：**状态被放在对话上下文里，而不是放在一个带地址的持久记录里。**

## Solution

每个需求一份 **state.json**（≤4KB）：线程名、需求名、子系统表、阶段、各节点状态与证据指针、下一步、重建事件。五个角色每轮只读这份摘要，细节按指针取。文件写入与派单都由工具解析路径，不靠人打字。状态只有一个写入口。

## User Stories

1. 作为组长，我要把需求交给 PM，只描述业务，不用管目录和线程名。
2. 作为组长，我要在左侧栏按需求看到所有角色会话，一眼知道进行到哪。
3. 作为组长，我要需求目录用中文名，因为我要能直接翻。
4. 作为 PM，我要一次调用就建好需求目录、meta.json 与 params 骨架，不再手写。
5. 作为 PM，我要 PM 会话平铺，不按个人/群聊分组。
6. 作为 PM，我要给需求起中文名，工具负责把它变成目录名。
7. 作为负责人，我要接手时读到一份摘要就知道进度，而不是重读历史。
8. 作为负责人，我要派单时必须带需求目录，否则被工具拒绝。
9. 作为负责人，我要把节点证据写进需求目录的 nodes/，不散落在工作区根。
10. 作为负责人，我要在会话被重建时看到"重建过"的标记，并读到摘要续跑。
11. 作为开发执行，我要只做被派的节点，不决定下一步。
12. 作为开发执行，我要产物路径由工具给出，不用猜。
13. 作为自测执行，我要报告落在需求目录的 self-test/。
14. 作为部署执行，我要锁、分支校验、基线都以工具给的路径与字段为准。
15. 作为维护者，我要角色顺序和会话键来自记录字段，不在代码里写死。
16. 作为维护者，我要未勾选的技能对该数字人不可见（同名影子屏蔽）。
17. 作为维护者，我要基座文档（project-info / project-list）固定在 workspace 根。
18. 作为维护者，我要需求目录不再有 docs/ 层。
19. 作为维护者，我要单轮上下文有预算，超了先摘要再继续。
20. 作为维护者，我要能从一个需求的 state.json 复原它的全部进度。

## Implementation Decisions

**记录与角色**：五个角色各一条记录；`order` 与 `sessionKey`（chat / requirement）是数据，代码不出现角色 id；工作区固定一个，记录的 workspace 被忽略。

**需求建档**：`digital_human_requirement_create({ thread, name, subsystems })` 一次写完目录（`reqs/<name>-<日期>/`）、`meta.json`（目录根）、`params.md` 骨架（含子系统表）。PM 只能通过它建档。

**需求状态**：`state.json` 在需求目录根，含 thread / name / phase / nodes{status,note,evidence} / next / events（保留最近 20 条） / updatedAt。

**三个读取与写入工具**：
- `digital_human_requirement_read({ requirement })` → 返回摘要（即 renderDigest 的输出）。
- `digital_human_requirement_update({ requirement, node, status, note, evidence })` → 推进节点并返回新摘要。
- `digital_human_requirement_attach({ requirement, name, content, kind })` → 写入 nodes/、self-test/、files/ 之一，返回绝对路径。

**派单契约**：`digital_human_send` 增加必填 `requirement`（线程名或目录名）；缺失即拒绝。被派方据此解析需求目录。

**产物归属**：所有产物用绝对路径写进需求目录；playbook 的落盘规则保留为纪律，工具为强制。

**会话重建**：重建事件写入 `state.json` 的 events，并在 progress 里留痕；新会话读摘要续跑，不重读历史。

**上下文预算**：摘要 ≤4KB；每轮只读摘要 + 当次任务所需文件；证据只在需要时按指针取。

**技能白名单**：`config.skills` 是白名单；未勾选技能由预设作用域 provider 以同名影子屏蔽（`modelInvocable=false`）。

**侧栏**：遮蔽 `sidebar.workspaces`（priority -20），启动时注册，切换写 localStorage 后刷新；树 = PM 平铺 + 每个需求一个折叠菜单，菜单内按 `order`；点行调用 `uiWorkspace.openSession`。

**文档布局**：基座 `project-info.md` / `project-list.md` 在 workspace 根；需求目录下直接是 `meta.json`、`params.md`、`state.json`、`brief.md`、`progress.md`、`nodes/`、`self-test/`、`files/`。

**写作规则**：给人看的文档遵循 ASD-STE100 的 80%。

## Testing Decisions

- 单测接缝只有一处：`requirements.ts` —— create / read / update / attach / renderDigest 的输入输出，含坏 meta、缺失 state、events 截断。
- 工具层测契约：`digital_human_send` 缺 `requirement` 必须拒绝；attach 返回的路径必须在需求目录内。
- 客户端不做组件测试；侧栏以沙箱实机验证（截图 + DOM 断言）。
- 端到端：一条真实需求（code-agent 文档更新），观察四个指标——需求目录名是否中文、meta 是否在目录根、树里是否显示中文名、开发/部署会话是否挂在需求下；并记录 token 用量与基线的对比。

## Out of Scope

归档与召回（archiveSession / 索引 / 移目录）、生产部署、侧栏视觉重做、子 agent 并发策略。

## Further Notes

已知坑：`client.js` 是构建产物必须构建；单槽同优先级注册会抛错且抢输静默；3099 与 3080 的依赖树已拆开；端口占用会让启动半死。
## 已核验（2026-11-03，代码 + 测试）

| 项 | 证据 |
|---|---|
| 五角色记录、`order`/`sessionKey`、工作区固定 | `store.ts` 解析与忽略 workspace |
| 记忆按会话分片 | `memory.ts` 的 memoryPaths（实测 req-alpha.md 等） |
| 技能白名单影子 | `src/tools.ts` provider，实测 79 → 21 条 |
| 侧栏需求树 + 「更多」切换 + PM 平铺 | `client.tsx`，截图与 DOM 验证 |
| 需求目录无 `docs/` 层 | `requirements.ts` 无 docs 拼接 |
| `state.json` 读写与摘要 | `readState/writeState/renderDigest/attachFile` 已在库内 |
| ASD-STE100 80% | GLOSSARY + AGENTS |

## 未实现（本规范的工单）

- 06：三个需求状态工具 + create 补 render
- 07：`digital_human_send` 必填 `requirement`

## 当前门禁

`tsc`（host/client）干净；`vitest` 779/780（唯一红：create 工具缺 render，由 06 修）。

## 追加决策（2026-11-03）

**派单只传事实，不传做法。**
派单字段固定为：requirement（线程名 + 需求目录绝对路径）/ task_id / node（可空）/ facts（子系统、版本、分支、环境、仓库、文档路径）/ context（一句话进度 + 上一步结论指针）。
禁止步骤列表、命令与注意事项。节点适用性由执行者按自己的 playbook 判断，跳过要在回执与 state.json 写理由；负责人只校验合理性。

**节点名用中文。**
开发 / 合并 / 验证 / 部署 / 自测 / 冒烟，不再用 A–F 字母；旧数据里的字母按映射一次性转换。

**节点序列不是固定流水线。**
交付物类型决定哪些节点有意义（纯文档没有可运行行为，自测与冒烟无对象），由执行者判断并在 state.json 留痕。

## 工单状态

已关：01 侧栏接缝 / 02 形态与切换 / 03 排序 / 04 写作（预算与搬迁并入 08）/ 05 白名单 / 06 状态三工具 / 07 派单带需求。
未关：08 人设与技能写作规范 / 09 部署链路真机验证 / 10 真实需求端到端 / 11 派单只传事实。
## 第二轮 grilling 结论（2026-11-03）

**Q1 会话粒度**：一个需求下四个角色**各一条会话**（负责人 / 开发 / 自测 / 部署），
线程名全部相同（= 需求线程名，不加角色后缀）；四条会话都必须归属该需求，在需求树里归到同一个节点。
派单给任一执行角色时 conversation_id 必须等于需求线程名。

**Q2 部署验证（09）**：只验链路——锁、分支校验、triggerId 基线、首轮确认，发到 H 即算通过。
服务可用性归自测，不归部署。

**Q3 路径归属**：路径只由工具决定（requirement_create / attach），playbook 不写具体路径，
只说"用 attach 落证据"。凡两处描述同一件事，必然漂移。

**Q4 token 预算（10）**：先测摘要机制的一轮基线，再定目标；不预设 3M。