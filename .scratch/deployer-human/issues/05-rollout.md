# 05 · 落地：记录、人设、记忆一起改

Type: task
Status: open
Blocked by: 02, 03, 04

## Question

按定下来的边界与契约，把东西写进去。清单：

**新记录**（id 待定，例如 `deploy-assistant`）
- `config.json`：single 模式（部署是长等待、串行更安全）；peers = dev-assistant（+ pm-assistant 视 04 的结论）；skills = pace-cli-helper、qs-assistant、digital-human-comms
- `persona.md`：只做测试环境部署；不写代码、不做方案；先查占用再触发；首轮确认；回执只给结论+执行 id+证据路径
- `memory.md`：初始只写机制（环境清单从哪读、占用怎么查），不写业务

**研发助手**
- persona：D 节点从"自己触发"改为"派给部署人、跟踪回执"；保留 D 的责任（它仍是流程主人）
- memory：把"触发人发布成功→不用我复查；我只做只读排障"这条口径改掉
- 技能：`qs-end-to-end-fast` 的 `references/node-deploy.md` 要改——现在通篇写"你自己触发"

**PM**
- persona 职责边界补一句：部署由部署人执行，PM 仍只到建档与通知

**文档**
- README「多人协作」一节补新角色；流程节点表责任人变更

## 注意

- 改 persona/技能属于**行为变更**，改完要拿一条真实需求走一遍 D 节点验证。
- 记忆改动要保留可回滚（改前备份）。
