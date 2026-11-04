# 角色技能工作集

> 2026-11-03 定。记录 PM 的决策；代码未改。

## 已定

| 角色 | 记录 id | 技能 |
|---|---|---|
| 自测执行 | `qa-assistant` | `remote-debug`、`ease-mysql-query`、`jvm-buddy`、`weapm` |
| 部署执行 | `deploy-assistant` | `release`、`req-release`、`pace-cli-helper` |

- 自测不绑 `db-read`：太个性化。
- 部署不绑 `db-release`、`weconf`：那是上线准备与配置变更，另开节点。
- `deploy-release`、`qa-verification` 两个 playbook 已并入人设并删除。
  全局库 `~/.agents/skills/` 已无这两个目录（83 个技能）。

## 待办（等名单）

把「新建记录默认全勾 83 个」改成「默认勾工作集」。

两处接缝：

1. 宿主：`src/index.ts` 的 `service.upsert` —— 新记录且未给 `skills` 时，用 `readSkillCatalog(skillsRoot)` 的全部技能填充。
2. 客户端：`src/client.tsx` 的「新建」按钮 —— 草稿预勾 `skills.map(entry => entry.name)`。

两处都要改成同一份工作集；只改一处会立刻不一致（页面预勾一套，宿主补另一套）。

## 现状核对

- 五条记录的 `config.skills` 已按上表设置（dev / lead / pm 各自的工作集也已设）。
- 人设里没有已删除技能的引用；`依赖技能` 行已跟着改。
- `qa-assistant` 的 `依赖技能` 行只点名了 3 个（缺 `weapm`），与 `config.skills` 的 4 个不一致。
- 运行中的会话可能仍挂着删除前的技能目录快照：技能目录在会话启动时读取。
