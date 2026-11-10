# 01: 技能 A–F 节点与角色路由

**What to build:** `qs-end-to-end-fast` 增加 E 自测、F 冒烟（原 E 冒烟后移），同步复杂度路由、修复循环、轮询与报告模板；顶部加角色路由，PM 与研发各读各的节。

**Blocked by:** None

**Status:** ready-for-agent

- [ ] 节点表为 A 开发 / B 合并 / C 验证 / D 部署 / E 自测 / F 冒烟
- [ ] 复杂度路由写清极速可跳过自测/冒烟（三处记录理由），标准/完整跑自测，纯前端跳过
- [ ] 修复循环纳入自测失败：同一 uuid，重部署后重跑，≤3 轮
- [ ] 新增 `references/node-self-test.md`：派单契约、范围推导、落盘路径、通过口径
- [ ] 报告模板加自测节点与 `self-test/` 证据路径
- [ ] 顶部角色路由：PM 读 §0–3 + preflight/project/report；研发读 §0、§2–10 + node-*/fix-loop/polling
