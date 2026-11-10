# 交接 · 需求级数字人组织

> 写于 2026-11-03。下个会话从这里开始，不要重新设计。

## 现在的状态

```
分支    wip/p0-switches
提交    ae3833e  feat: 需求建档工具 + 需求目录去掉 docs 层
门禁    tsc 干净；vitest 779/780（1 条失败待修，见下）
沙箱    3099，用 bash /tmp/restart-sandbox.sh 启动；数据是旧布局，需清场
生产    3080 未动，指向 ~/dsh-plugins/digital-human（master）
```

**禁区**：不要改 `~/dsh-plugins/digital-human`，那是 3080 的插件目录。

## 已经跑通的

- 五个角色记录：PM(order 0, sessionKey chat)、负责人(10)、开发(20)、自测(30)、部署(40)，全部 sessionKey=requirement 除 PM
- 工作区固定一个，记录的 `workspace` 被忽略，配置界面已移除
- 记忆按会话分片：`humans/<id>/memory/<线程名>.md` + `_shared.md`
- 会话标题：执行角色用角色名，PM 保留自己的命名
- 左侧栏：遮蔽 `sidebar.workspaces`（priority -20），启动时注册；切换在「更多」菜单（localStorage + reload）
- 树数据来自 `tree.read`：`{humanId,name,order,sessionKey,requirements[{conversation,sessions,dir,name}]}`
- 技能白名单：未勾选的技能在预设层用同名影子屏蔽（`invocation.modelInvocable=false`）
- `digital_human_requirement_create`：一次调用建目录 + `meta.json` + `params.md` 骨架
- 需求目录不再有 `docs/` 层；基座文档 `project-info.md` / `project-list.md` 都在 workspace 根

## 立刻要做的四件事

### 1. 给新工具补 render（一行）

`src/lib/tools.ts` 里 `digital_human_requirement_create` 的 `output` 对象内加：

```ts
render: (_args, value) => [{ type: 'text', text: value?.detail ?? JSON.stringify(value) }],
```

位置在 `properties: {...}` 之后、`output` 的闭合 `},` 之前。加完 `npx vitest run` 应 780/780。

### 2. playbook 同步（仓库外）

路径：`~/.dsh-sandbox/digital-human/skills/`

- `pm-intake`：建档改成"调 `digital_human_requirement_create`"，不再手写目录与 meta.json
- `lead-orchestration` / `deploy-release` / `qs-end-to-end-fast`：把路径里的 `docs/` 去掉（`reqs/<需求名>-<日期>/brief.md`）

### 3. 清场

```bash
V="$HOME/.dsh-sandbox"
rm -rf "$V/sessions"/* "$V/storages/session_projcache"/* "$V/storages/workspace.json"
for h in "$V"/digital-human/humans/*; do rm -f "$h/sessions.json" "$h/tasks.jsonl" "$h/edges.jsonl"; rm -rf "$h/conversations" "$h/memory"; done
rm -rf "$V/digital-human/workspace/reqs"/* "$V/digital-human/workspace/_archive"/*
bash /tmp/restart-sandbox.sh
```

### 4. 跑真实需求并验证四个点

需求（真实，不是验收脚本）：

```
code-agent-scheduler 文档更新
子系统 WRDT-FELC / 版本 WRDT-FELC_0.1.0 / 分支 master / 环境 H（H51 172.21.83.2）
仓库 /Users/harrywan/company/git/code-agent-scheduler
内容：更新 README.md 与 CLAUDE.md，与当前实现一致
验收：与代码一致、review 通过、合并 master
需要部署到测试环境 H（流水线 1039300005286600）
```

验证点：

1. 需求目录名是**中文**（`reqs/<需求名>-<日期>/`）
2. `meta.json` 在**目录根**，不在 docs 下
3. 树里需求菜单显示**中文名**
4. 开发/部署的会话**挂在需求下面**（靠 `sessions.json` 索引；已修"写回时按磁盘合并"）

## 踩过的坑（别再踩）

| 坑 | 说明 |
|---|---|
| `client.js` 是构建产物，不进 git | 改客户端必须 `pnpm run build:client`，否则客户端模块注册被 ENOENT 跳过，插件入口整个消失 |
| 单槽抢占有静默失败 | `sidebar.workspaces` 同优先级注册会抛错；抢输不报错。必须 priority -20 且捕获异常 |
| 原生列表只有 dispose 才回来 | WorkspaceBrowser 未导出，所以切换只能"启动时注册 + 刷新" |
| 3099 与 3080 曾共用 node_modules | 已拆开；沙箱 profile 的 `node_modules` 是独立副本，插件链接指向 worktree |
| 端口占用会让启动半死 | `EADDRINUSE` 时 web-runtime 一直等 webServer，表现为"插件入口看不到"。先 `lsof -iTCP:3099` 清端口 |
| 需求身份三处漂移 | 线程名/目录名/meta.json 曾各写各的；现在只由 `digital_human_requirement_create` 一次写全 |

## 已知未做

- 归档与召回（archiveSession / 索引 / 移目录）只有设计
- 部署链路（锁、分支校验、triggerId 基线、首轮确认）从未真机验证
- 子 agent 并发只写在人设里，未验证
- 覆盖率阈值已从 90 调到 87（baseline 本身不达标）

## 落盘归属（新发现，未根治）

**症状**：一次需求执行产生的文件散到了 workspace 根：

- workspace/deploy-assistant/poll-1039300005286600.sh
- workspace/reports/cas-doc-sync-w1-b-review.md

**根因**：会话的 cwd 就是工作区目录（DSH 不允许同时指定 workspaceId 和 cwd），
所以模型用相对路径写文件时落在根目录，而不是需求目录。

**已做**：五个 playbook 都加了「落盘规则」——所有产物用绝对路径写进
reqs/<需求名>-<日期>/ 下的 nodes/、self-test/、files/，派单时把需求目录绝对路径交给被派方。

**未做**：没有机制强制。可选的硬化手段：
1. 在 digital_human_send 的派单模板里固定带上需求目录字段，缺了拒绝派单
2. 回合结束后由宿主扫描 workspace 根的散落文件，提示或归位
3. 让 requirement 会话真的以需求目录为 cwd（会牺牲「工作区=数字人」的设定，需要重新决策）

## 第一性原理诊断（2026-11-03）

实测：一条"改两份文档"的需求烧了约 9.3M 未命中缓存的输入 token；产物全落在 workspace 根；
负责人会话被静默重建一次；需求目录是空的。

三个症状同一病根：**状态被放在对话上下文里，而不是放在一个带地址的持久记录里。**

### 三个转向

1. **会话即记忆 → 需求记录即记忆**
   现在每个角色靠"聊过什么"理解进度，所以反复重读证据。
   应该是：每个需求一份 state.json（线程名、需求名、子系统表、阶段、各节点状态 + 证据指针、下一步、已用预算）。
   角色每轮只读这份摘要，细节靠指针按需取。

2. **散文约定 → 工具强制**
   文件写到哪、派单带不带需求目录，现在都靠 playbook 里的一句话。
   应该是：路径由宿主解析，不靠人打字。写文件走 requirement_attach(需求, 文件)，派单强制带需求 id。

3. **各自理解 → 共享一份记录**
   五个角色对"当前到哪一步"各有各的说法（这次 PM 和负责人就互相纠正过状态）。
   应该是：状态只有一个写入口（节点推进的负责方），其他角色只读。

### 最小实现

- state.json：需求目录根下，固定 schema，体积上限 ~4KB
- 四个工具：create（已有）/ read（返回摘要）/ update（推进节点 + 证据指针）/ attach（把文件纳入需求并返回路径）
- 会话启动时注入 state.json 摘要（像记忆那样），不注入历史
- 会话重建时：新会话读摘要即可续跑，重建事件写进 state.json

预算效果：每轮上下文从 O(历史) 降到 O(摘要)，9.3M 这种量级应该回落到百万以内。
