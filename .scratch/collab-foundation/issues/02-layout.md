---
title: 02 需求目录分层
labels: [ready-for-agent]
---

## Question

按 spec 的「需求目录布局」实现：

1. createRequirement 只建协议文件：meta.json、params.md（state/brief/progress 由各角色写）。
2. 建 files/ 与 nodes/ 两个子目录（空目录即可，让角色有明确的落点）。
3. 提供一个目录分层校验：给定需求目录，若根目录出现非协议文件（如 .md 资料、.png），
   返回违规清单；用于测试与人工体检，不在写入路径上阻塞。
4. analysis/ 与 design/ 的归属只在文档与 playbook 约定，不在代码里创建。