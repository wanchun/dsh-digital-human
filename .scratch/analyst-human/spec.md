# Spec: 需求分析数字人（analysis-assistant）

Status: ready-for-agent

## Problem Statement

需求拿到手就进开发，分析靠 lead 的经验判断。需求模糊点、接口契约、数据模型缺
失时，问题到开发/测试阶段才暴露，返工频繁（见团队复盘：需求变更与契约不先行
是两大时间消耗源）。需要一个执行 matt 式需求分析的数字人节点，分析闭环后才
进入开发。

## Solution

新增 `analysis-assistant`，作为 lead 的「分析」节点执行者，按 matt 技能链自动
运行：grilling 自我拷问 → 疑问经 PM 转发触发人 → 答复回程自动续跑 →
to-spec 出规格 → to-tickets 拆工单 → 回执 lead 放行。

链路与职责：

```
PM(建档) → lead(接手,判断是否需要分析)
             ├─ 需要 → 派 analysis-assistant
             │          ├─ grilling 拷问
             │          ├─ 疑问 → digital_human_send 给 PM
             │          │        → PM notify_bot 发触发人企微
             │          │        → 触发人回复进 PM 会话
             │          │        → PM 对号后回传 analysis(同 conversation)
             │          │        → analysis 自动续跑
             │          ├─ 疑问清零 → to-spec → to-tickets
             │          └─ 回执 lead: spec+tickets+放行结论
             └─ 不需要(小修复/已有规格) → 直接派 dev,记跳过理由
```

角色约束：

- analysis 不绑 IM（config 的 `im` 留空）：无 notify_bot 工具，对外沟通必须经
  PM。peers 白名单 `[lead-assistant, pm-assistant]` 双保险。
- lead/qa/dev/deploy 不参与疑问环节。
- 疑问对号靠两样：PM 会话连续性 + PM memory 挂起表（需求名 → 未答 Q 清单 +
  来源会话）。

## 产物约定（需求目录 analysis/）

| 文件 | 内容 | 写者 |
|---|---|---|
| `analysis/questionnaire.md` | 疑问清单：每 Q 带 待答/已答 状态 | analysis |
| `analysis/spec.md` | 规格书（to-spec）：背景/边界/接口契约/数据模型/验收判据 | analysis |
| `analysis/tickets/NN-*.md` | 工单（to-tickets）：交付单元+验收判据+Blocked by | analysis |
| `analysis/decision.md` | 放行结论一句话 + 疑点闭合状态 | analysis |

state.json 增加节点「分析」；`progress.md` 由 lead 记节点摘要（单一写者不
变）。

## 状态机（analysis persona 核心）

```
拷问中 → 待答复(有Q未清) → 综合中 → 拆票中 → 已放行
```

- 每次唤醒（lead 派单或 PM 回传答案）先读 questionnaire.md 状态。
- Q 未清零：更新已答项，仍缺则补问（不重复问已答的），停在待答复。
- Q 清零：自动 to-spec → to-tickets → 回执 lead，一气呵成。
- 超 24h 未答复：经 PM 提醒触发人一次，不自动猜答案。

## User Stories

1. 作为 lead，我想把模糊需求派给分析节点，以便开发拿到的必然是有 spec 的工单。
2. 作为 analysis，我想用 grilling 自检需求完备性，以便把疑问在开工前暴露。
3. 作为 analysis，我想把疑问经 PM 转发触发人并在答复到达后续跑，以便无人值守
   完成分析闭环。
4. 作为 PM，我想按 peer_source 与 memory 挂起表对号转发答案，以便多需求并发
   不串线。
5. 作为 dev，我想拿到带验收判据与依赖边的工单集合，以便一次性开发完。
6. 作为 lead，我想对纯漏洞修复跳过分析直接派开发，以便小改动不被拖慢。

## 验收（沙箱）

沙箱宿主与生产隔离：`DSH_HOME=~/.dsh-sandbox`，web 端口 **3099**（生产 3080）。

- U1 正常流：lead 派分析 → analysis 出 spec+3 票全 ready → lead 照票派 dev。
- U2 答复回环：analysis 发问 → PM 转发企微 → 模拟触发人回复进 PM 会话 → PM
  回传 → analysis 续跑到 spec+tickets。含双需求交错回复压测（对号不串）。
- U3 跳过流：小修复需求 lead 直接派 dev，progress.md 记跳过理由。
- U4 隔离铁律：验证前后生产 `humans/*/tasks.jsonl` mtime 不变。

## Non-Goals

- 不改 PM 建档流程与 project-list 结构。
- 不给 analysis 绑 IM bot（等宿主支持多 preset 绑定再议）。
- 不做需求评审平台（千手 xqc）的对接，analysis 只产本地文档。
