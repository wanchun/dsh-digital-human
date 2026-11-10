# 第一性原理 · 人设与技能重构

## 一、五条公理

1. **单一权责**：一个动作只有一个角色负责；同一件事不得两个人都会做。
2. **人设管身份，技能管做法**：人设写"我是谁、我不做什么、我收什么交什么"；怎么做一律进技能。
3. **技能按动作域切分**：能力型技能（平台原语：qs/pace/release/weconf/日志/DB）照旧复用，**不重复造**；编排型技能只写顺序、判据、回执。
4. **只挂用得上的**：一个角色挂它真的会调用的技能，不做"以防万一"。
5. **状态三分**：进度 → `docs/`；状态 → 账本；记忆 → 只放指针（线程名、当前节点、关键决策）。

## 二、每个角色只需回答三个问题

| 问题 | 落到哪 |
|---|---|
| 我收到什么（输入契约） | 人设 |
| 我做什么（动作域） | 人设一句话 + 技能里的步骤 |
| 我交出什么（输出契约） | 人设（回执格式） |

## 三、技能分三层

| 层 | 是什么 | 例子 |
|---|---|---|
| L1 能力 | 平台原语，谁需要就挂 | `qs-assistant`、`pace-cli-helper`、`release`、`req-release`、`weconf`、`db-release`、`remote-debug`、`ease-mysql-query`、`dpms-cli-helper`、`git` |
| L2 角色 playbook | 该角色的顺序、判据、回执 | `pm-intake`、`lead-orchestration`、`dev-qiantou`、`qa-verification`、`deploy-release` |
| L3 通用 | 跨角色协作 | `digital-human-comms` |

**L2 不写命令**，只写"第几步做什么、凭什么判断、交什么"。命令指向 L1。

## 四、动作域（互不重叠）

| 角色 | 动作域 | 明确不碰 |
|---|---|---|
| PM | 接洽、判身份、澄清需求、建档、派单、转达、归档/召回 | 代码、流水线、执行调度 |
| 负责人 | 拆解、调度、修复环、进度维护、汇报 | 写代码、触发部署、自测执行 |
| 开发 | 千手 A/B/C/F、定位与修复、提交 | 派单、部署、自测 |
| 自测 | 环境探测、用例设计与执行、报告 | 派单、改代码、判上线 |
| 部署 | 锁、校验、触发、轮询、回执 | 写代码、派单、碰生产 |

## 五、挂载矩阵

| 角色 | L2 playbook | L1 能力 | L3 |
|---|---|---|---|
| PM | `pm-intake` | `dpms-cli-helper` | `digital-human-comms` |
| 负责人 | `lead-orchestration` | `qs-assistant`、`dpms-cli-helper`、`pace-cli-helper` | `digital-human-comms` |
| 开发 | `dev-qiantou` | `qs-assistant`、`git` | `digital-human-comms` |
| 自测 | `qa-verification` | `remote-debug`、`ease-mysql-query` | `digital-human-comms` |
| 部署 | `deploy-release` | `release`、`req-release`、`pace-cli-helper`、`weconf`、`db-release` | `digital-human-comms` |

## 六、人设的骨架（≤800 字）

```
# <角色>
## 我是谁（一句）
## 我收到什么 / 我交出什么
## 我不做什么（三条以内）
## 红线（两三条）
```

步骤、判据、命令一律不写进人设。

## 七、旧资产的处置

| 资产 | 处置 |
|---|---|
| `qs-end-to-end-fast`（很大） | 拆：节点顺序进 `lead-orchestration`，节点命令进 `dev-qiantou`，接入部分进 `pm-intake` |
| 旧 PM/开发/自测人设（40KB/20KB/3KB） | 废弃，按骨架重写 |
| 全局技能（76 个） | 不动；只把该角色需要的拷进插件技能空间并挂载 |
