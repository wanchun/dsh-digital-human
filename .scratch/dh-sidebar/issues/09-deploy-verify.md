# 09 · 部署链路真机验证

Type: task
Status: open

## Question

部署链路（锁 → 分支校验 → triggerId 基线 → 轮询 → 首轮确认）只写在 playbook 里，从未真机跑过。
用 code-agent 的测试环境跑一次真实部署：

- 子系统 WRDT-FELC，版本 WRDT-FELC_0.1.0，分支 master，环境 H（H51 172.21.83.2）
- 流水线 1039300005286600

验四件事：
1. `mkdir .locks/<子系统>@<环境>` 抢锁成功/被占时的回执
2. 构建分支与部署分支不一致时是否先更新并重查
3. 触发前是否记 `lastestTrigger.id`，轮询是否按 triggerId 判定终态
4. 首次组合是否回 `needs-confirm`，确认后才执行

把每一步的命令与输出留证到需求目录的 nodes/。
