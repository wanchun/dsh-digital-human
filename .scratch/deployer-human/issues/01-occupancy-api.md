# 01 · 占用与触发的真实接口

Type: research
Status: resolved

## Question

自动部署要判断两件事：**这个环境现在能不能发**、**这条流水能不能被触发**。需要确切事实：

1. `occupation-detail` 的完整返回结构：按 subsystem / idc 查询时，什么字段表示"有人正在发布"，什么字段表示"空闲"。
2. 占用的粒度：按子系统？按产品？按环境（idc）？多子系统同时在发同一环境时返回什么。
3. `pipeline-exec` 在测试环境触发的权限与审批要求：是否需要审批流、是否有并发限制、失败时的错误码。
4. 部署终态怎么判定：`pipeline-detail` 里哪个字段是终态、SUCCESS/FAILED 的取值。
5. pace skill 里是否已有封装脚本（search-pipelines / exec-pipeline），参数与返回。

## 线索

- `~/.agents/skills/pace/SKILL.md`（端点表：126-153 行附近）
- `~/.agents/skills/pace/scripts/exec-pipeline.mjs`
- `~/.dsh/digital-human/skills/qs-end-to-end-fast/references/node-deploy.md`

答案写进本文件。
## Answer

报告：`/Users/harrywan/tmp/research/deploy-occupancy.md`

- **占用只能答一半**：`occupation-detail` 能答"该子系统在该 IDC 有没有发布单占用"，答不了"谁在发"（返回里没有操作人 / triggerId）。粒度 = 子系统 × IDC（可下钻 DCN）× 发布单。
- **静默假阴性**：`productFormIds` 必须是真实发布单 id，传错时返回 `[]`，看起来像"环境空闲"。**不能只信这个接口做互斥判断。**
- **终态可靠**：`data.lastestTrigger.status`，取值 `SUCCESS` / `FAIL` / `RUNNING` / `''`（是 FAIL，不是 FAILED）。**必须比对 triggerId/triggerDate**，否则会把上一次的 SUCCESS 当本次成功。
- **无并发限制证据**：测试环境构建流水无审批，只按人员名单放行（106 = 需申请权限，3001/3002 = 鉴权失败）。
- **脚本**：`search-pipelines {subsystem,limit}`、`exec-pipeline {taskId,confirm:true}`；`update-pipeline` 只能 `qs pace` 透传。
- **缺口**：操作人维度、流水与环境的互斥信号、planId 获取链、机器级部署终态。

结论：**终态可以自己判，占用必须自己记。**
