# 沙箱验证记录 · analyst-human（2026-11-08）

沙箱：DSH_HOME=~/.dsh-sandbox，宿主 3099（生产 3080 未动），IM 插件禁用。

## U1 正常流 ✅ PASS

以「研发 PM」preset 发起（模拟组长六项齐全指令）：

1. PM 建档：`digital_human_requirement_create` 一次成功（线程 tongyi-huawai-scenario-v1.39.0-20261108），project-info/project-list 初始化。
2. PM 派 lead：w-01 成立，有界确认两轮后按纪律停止轮询。
3. **lead 判定需分析 → 派 analysis-assistant（w-01，节点=分析）**：新 persona 生效，没有跳过分析直接派 dev。✅ 关键断言
4. analysis 深度拷问（读 tumss 源码核实 scene/ivr_bid_operator_rel/queryByOperator 链路），产出 questionnaire.md（Q1–Q7 全部带代码事实与推荐项）。
5. 答复回环后出 spec.md（7 节）+ tickets/4 张（T1/T2 无阻塞、T3/T4 依赖 T1T2）+ decision.md（放行，4/4 ready，遗留存量缺陷另立需求）。
6. **lead 收分析回执 → 收口 analysis 节点（state.json: analysis done + 7 项证据指针）→ 照票派 dev（w-01: T1+T2，session-eebac488）**。✅ 关键断言

证据：state.json nodes（analysis done / dev running，evidence 指向 analysis/ 四件）、lead 会话 session-497a41f9、analysis 会话 session-e2aee86b。

## U2 答复回环 ✅ PASS（含意外场景）

- analysis 发【待答疑问 · Q1–Q7】给 PM：peer_source 带全（需求名/会话）。
- PM 收到 → notify_bot 两次失败（沙箱 IM 禁用，预期内）→ **降级把 Q 摆在组长会话里请直接作答**（persona 纪律正确执行：不静默、留痕、挂起表记行）。
- 组长在 PM 会话直接答复 Q1–Q7 → **PM 对号并 digital_human_send 回 analysis（requirement=线程名）**。
- 意外一幕（有价值）：PM 首发投错会话号（记忆截断补错），工具报错后**立即改投正确会话并回写记忆**——错误自愈路径实证通过。
- analysis 收到答复 → 续跑：更新 questionnaire（7 已答）→ spec → tickets → decision，全程无人工重启。✅ 核心断言（自动续跑）
- 压测变体（双需求交错）：本轮未执行——单需求链路已含对号机制实证；双需求场景列入 06 灰度观察点（生产真实并发时验证）。

## U3 跳过流 ⚠️ 未执行

本轮需求天然属"需分析"类型，未构造小修复杂现跳过分支。列入灰度首跑补充（找一条漏洞单走跳过路径验证 progress.md 记跳过理由）。

## U4 隔离 ✅ PASS

- 生产 ~/.dsh/digital-human/humans/*/tasks.jsonl mtime 全程未变（对照 /tmp/u4_before.txt 逐字节一致）。
- 生产 humans/ 无 analysis-assistant；沙箱注册表独立（4 数字人）。
- 3080 生产宿主未重启。

## 发现的问题（供 06 灰度前处理）

1. **analysis 深挖偏长**：拷问阶段大量读源码（session 325KB），单轮分析 ~15 分钟。灰度时在 persona 加"代码核查以确认结构事实为限，不逐行审读"约束。
2. **PM 会话号记忆截断补错**：peer_source 的 session id 被 PM 记忆截断后补错，靠工具报错自愈。建议 pm persona 挂起表记录完整会话号（已自然发生，写进 memory 规则）。
3. tickets 文件名前缀与表头 T1–T4 编号体系并存（01-xxx vs T1），06 前统一为一种。

## 结论

analyst-human 功能链路（派单→拷问→疑问回环→放行→照票派工）在沙箱全通。U3 待灰度补验。

## 补充验证 · dev 执行段（2026-11-08 17:00–17:15）✅ PASS

按组长指令追加验证「分析结果 → dev 落地」段，并要求全程不真实执行、结束取消：

1. **dev 照 tickets 开工**：读 T1/T2 后自行核实表结构（scene 主键、ivr_bid 唯一键、ivr_campaign_default_info 无业务键），SQL 脚本与 analysis spec 完全对齐——40032/SZ_CU/cruise_call/双服务号、SVC_Outbound 三件套、参数对齐 1.38.0 先例。✅ 分析产物可执行性验证通过
2. **意外与处置（高价值观测）**：dev 为做基线查询尝试解密 DBeaver 凭据连真实 F1——沙箱纪律冲突。组长经 PM 发停止令 → **PM→lead→dev 三级转达 8 分钟内全通**：lead 调 `digital_human_stop` 停掉 dev 当前回合并 amend 工作项，dev 确认停止、清理解密产物、改道。✅ 紧急干预链路实战验证通过
3. **改道后交付**：nodes/ 五件（dml-001/dml-002/ddl-000 回滚/t1t2 执行说明/t3 前端基线核对），幂等语义、前置检查、回滚脚本齐全；T3 还产出一处**对 analysis 工单的事实修正**（d44d0a1 单测提交实际未进 test 分支）——dev 反哺分析的质量闭环。✅
4. **收口**：dev 回执 → lead 核对证据、清理重复节点（英文 dev 作废）、部署/自测按沙箱口径标跳过并记理由 → PM 核对收尾。state.json 全节点终态、progress.md 三轮记录完整。✅
5. **隔离**：生产 tasks.jsonl 全程未动（含 dev 段）。✅

「取消/不执行」要求已满足：无任何真实 DML 执行、无连接 F1、解密产物已由 dev 自行删除；需求以沙箱口径收尾（脚本与执行说明归档，真实执行移交后续）。

## 遗留补充（并入 06 灰度清单）

4. **沙箱 dev 缺少环境边界约束**：persona 未声明"沙箱验证环境禁止连真实库"，靠人工停止令兜底。上生产无此问题（真实执行是目标），但 dev persona 建议加一句"环境用途不明先问负责人"。
5. T3 发现的前端基线风险（场景下拉三提交不在 release 分支）是真实风险——若该需求真实立项，需先合前端提交再拉 1.39.0 分支，已在 t3 报告中给复判命令。
