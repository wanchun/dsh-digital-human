---
title: 六数字人人设承接与设计一致性
labels: [wayfinder:map]
---


## Destination

六个数字人（PM / 负责人 / 开发 / 自测 / 部署 / 上线准备）的人设与技能设定，
完整承接原来三个数字人（PM / 开发 / 自测）的核心思路，并符合新设计：
动作驱动、工具强制、单一写者、派单只传事实。
产出：一份差距清单 + 每个差距的处置决定（补 / 不补 / 换形态）。

## Notes

- 领域词汇以仓库根 `GLOSSARY.md` 为准。
- 生产三个角色的原文件：`~/.dsh/digital-human/humans/{pm,dev,qa}-assistant/persona.md`。
- 新六角色：`~/.dsh-sandbox/digital-human/humans/*/persona.md`。
- 新设计的判据：动作必须编号且点工具名；格式细节只在一处；同一文件只有一个写者。

## Decisions so far

- 三个 playbook 并入人设后删除：deploy-release、qa-verification、lead-orchestration、pm-intake（连同先前删除的 digital-human-comms 内置进插件）。
- 技能按角色职责绑定，一套全给的做法废弃；78 个全局技能，六条记录各自工作集。
- 写入归属已落到六个角色：PM 写两张表，负责人写 brief/progress/state，执行者只写自己那份证据，归档索引归工具。
- PM 人设不拆（决定：保持单文件）。
- 开发执行是远程任务操作员，不做本地开发；因此不加 git / tdd / code-review / ai-commit。
- 「禁止事项」暂不做。

- [六个角色对生产三角色的差距清单](issues/01-gap-list.md)：生产 32 节逐条映射完成；PM 全承接、开发缺三节（配置读取/扫描流程/沟通风格）、缺负责人↔自测交接一条、PM 通知留痕一条。

- [其余五角色是否要最小治理层](issues/02-governance.md)：只加一条「失败、跳过、不确定都如实报」，其余不加（判断归负责人，写入归属已覆盖）。

- [phase 由谁推进、按什么规则](issues/03-phase.md)：由节点状态推导（planning/developing/verifying/deploying/testing/done，archived 优先），不新增人工步骤；实现另开工单。
- [上线准备与部署的边界、bug 修复环、召回复用](issues/04-boundaries.md)：部署只到测试环境；测试接手后 bug 走「负责人定时取 → 判断清晰性 → 不清则 PM 拉测试与负责人补信息 → 清晰则修复」；测试验证 OK 且临近上线才进上线准备，运维实施；召回复用旧会话。',

- [上线准备与部署的边界、bug 修复环、召回复用](issues/04-boundaries.md)：部署只到测试环境；bug 走「负责人定时取 → 判清晰性 → 不清则 PM 拉测试补信息 → 清晰则修复」；测试验证 OK 且临近上线才进上线准备，运维实施；召回复用旧会话。

- 超时上限：不做。派单即放手，执行者完成或阻塞都会回执；要查进度由人在问时用 `digital_human_status` 拉一次，不主动计时、不轮询。

- 投递模式不暴露：thread 记录默认 steer（插话到下一个 step 边界），shared 记录 queue；不新增 urgent/delivery 参数。看起来「在队列」是 steer 等当前 step 结束的正常表现。

## Not yet specified

- 其余五个角色要不要最小治理层（写入纪律之外的纪律：通知、风格、门禁）。
- 上线准备与部署两个角色的边界在真实需求里如何切。

## Out of scope

- PM 人设拆分（已决定不做）。
- 禁止事项清单（本轮不做）。
- 生产 3080 的迁移与重启（人负责）。
