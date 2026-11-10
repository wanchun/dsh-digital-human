# Map: 数字人自定义左侧栏

## Destination

一个属于数字人的左侧栏：按 **数字人 → 需求 → 会话** 展示，并且能和 DSH 原生侧栏来回切换。
终点是一份能直接实现的定稿（形态、数据、交互、降级），不是代码。

## Notes

- 数据接口已有：`tree.read` 返回 `humans[{humanId,name,description,requirements[{conversation,sessions[{sessionId}]}]}]`。
- 工作区已经固定为唯一一个「数字人」，不再是每个需求一个；需求层级只存在于这个侧栏里。
- 只动沙箱（`~/.dsh-sandbox`，插件 worktree），生产 3080 不碰。
- 客户端改动必须 `pnpm run build:client`（`client.js` 是构建产物，不进 git）。

## Decisions so far

<!-- 关闭的工单，一行一条 -->

## Not yet specified

- 树里会话的排序规则（最近活跃 / 建档顺序）。
- 需求归档后，树里是否还显示（_archive/ 目录）。
- 侧栏状态是否记忆（刷新后保持上次选择）。

## Out of scope

- 改动 DSH 原生侧栏组件本身。
- 生产环境上线。
