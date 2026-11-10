# 03 · 记忆按会话隔离（插件）

Type: grilling
Status: resolved

## Question

现在记忆是 `humans/<id>/memory.md` 一份，所有需求共享。要改成按会话隔离，形状待定：

- **文件布局**：`memory/<线程名>.md` + `memory/_shared.md`？
- **注入**：每步注入"当前会话那份 + shared 的常青部分"，预算怎么分（各 16KB 还是总量 16KB）？
- **压缩与归档**：各自独立压缩、各自归档到 `memory/<线程名>/<时间>.md`？
- **迁移**：现有 `memory.md` 里混着的三个需求怎么拆（人工拆一次，还是整份降级为 shared）？
- **没绑定会话的场景**：命令行/无会话时读哪份？
- **兼容**：老记录没有 `memory/` 目录时行为不变？

➡️ 倾向：会话一份 + shared 一份；注入 = 会话那份优先，shared 只放 Patterns/Errors 这类常青；压缩归档都按文件独立；迁移就整份降级为 shared，新需求从空开始。
## Answer

**全员按会话分片**（自测/部署也改成一需求一会话），所以不存在"某些角色单会话"的特例：

```
humans/<id>/
  memory/
    _shared.md                     # 跨需求：Patterns / Errors / 团队规矩
    <线程名>.md                     # 该需求的工作记忆
    <线程名>/<时间>.md               # 该需求的历史归档
```

- 注入：当前会话那份 + `_shared.md` 的常青段；预算各自 16KB 上限，_shared 另给 4KB。
- 压缩：按文件独立；归档按线程名分目录。
- 迁移：现有 `memory.md` 整份降级为 `_shared.md`，新需求从空开始（不强行拆分旧内容）。
- 兼容：没有 `memory/` 目录时读 `memory.md`，老记录行为不变。
