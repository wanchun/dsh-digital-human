# 07 · 需求文档组织重构

Type: grilling
Status: open
Blocked by: 02

## Question

现状问题（实测）：`三方会话…-1.38.0` 与 `TUMSS-1.38.0-w5场景可选` 是同一版本的两个顶层目录；project-list 成了备注墙；progress.md 与记忆职责重叠。

提议结构：

```
docs/qs-end-end/<项目>/<版本>/
    version.md  params.md  project-info.md
    <需求>/
        brief.md  progress.md  nodes/
```

`project-list.md` 只做索引（状态从账本派生）。

要定：迁移方案（现有 6 个目录）、project-list 谁维护、旧目录留不留跳转。
