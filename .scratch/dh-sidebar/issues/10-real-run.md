# 10 · 真实需求端到端

Type: task
Status: open

## Question

跑一条真实需求（不是验证系统自身的需求，避免自证），记录基线：

需求：code-agent-scheduler 更新 README 与 CLAUDE.md，部署到 H。

要记录的四个指标：

1. **需求目录**：中文名、meta.json 在目录根
2. **树**：需求菜单显示中文名；开发/部署会话挂在需求下
3. **产物归属**：所有文件都在需求目录（nodes/、self-test/、files/）
4. **成本**：各角色 token 用量、会话重建次数；与上一轮 9.3M 对比

验收：上述四项全部符合，且 token 用量明显低于 9.3M（目标 ≤3M）。
