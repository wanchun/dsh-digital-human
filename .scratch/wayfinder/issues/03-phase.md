---
title: phase 由谁推进、按什么规则
labels: [wayfinder:grilling]
status: resolved
---


## Question

state.json 的 phase 永远停在 planning。① 由负责人显式写；② 由节点状态推导。

## Resolution

**选 ②：由节点状态推导，不新增人工步骤。**
理由：显式写会多一个「谁写、什么时候写、忘了写怎么办」的问题——正是这次 phase 卡在 planning 的原因。

### 阶段集合

```
planning → developing → verifying → deploying → testing → done
```
外加 `archived`（归档态，独立于推导）。

### 节点名到阶段的映射

| 节点名（中文，允许包含修复） | 阶段 |
|---|---|
| 开发 / 修复 | developing |
| 合并 / 验证 | verifying |
| 部署 | deploying |
| 自测 / 冒烟 | testing |
| 线上 / 上线 | releasing（可选，暂并入 testing） |

### 推导规则

1. 若需求已归档 → `archived`，推导不覆盖。
2. 没有任何节点 → `planning`。
3. 存在状态不是 done 的节点 → 取**最早那个未完成节点**对应的阶段（按动作顺序，不按写入顺序）。
4. 全部节点 done → `done`。
5. 节点名不在映射表里 → 沿用上一个已知阶段；没有上一个就用 `planning`。不抛错。

### 落地位置

- 推导函数放在需求库里，纯函数：输入 state，输出 phase。
- `requirement_read` 与 `tree.read` 返回的 phase 一律用推导值。
- 写 state.json 时不再写 phase 字段。

### 遗留

这是决定，不是实现。实现另开工单（需要测试：空节点、部分完成、全部完成、archived、未知节点名）。
