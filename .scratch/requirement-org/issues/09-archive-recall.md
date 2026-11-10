# 09 · 归档与召回

Type: grilling
Status: resolved

## Question

需求上线后会话会越来越多。要定：

1. **归档时机与触发**：上线检测 OK 后由谁触发（PM 判定 / 负责人收尾 / 定时扫描）。
2. **归档动作**：会话标记归档（DSH 层面）+ 需求目录移到 `_archive/<需求>/` + 删代码 worktree，过程文档与证据保留。
3. **归档后不可能再派单**：DSH 对归档会话收消息会 `blocked`（已知限制）。所以"恢复"只能是**新建会话指向归档目录**，不是唤醒旧会话。
4. **PM 的召回**：PM 记一份归档索引（需求、线程名、归档时间、目录、一句话结论）；问到归档需求时先查索引与文档，需要开发细节才让负责人开新会话。
5. 索引放哪：`workspace/_archive/index.md`（人可读、PM 可 grep）。

➡️ 推荐：PM 判定上线后归档；索引一张 markdown 表；恢复 = 新会话。
## Answer

**恢复 = 还原原来的会话，不是新建。** DSH 支持（`workspaceController`）：

```
archiveSession({ sessionId, stopActivity? })   // 有在跑的回合要先 stop
unarchiveSession({ sessionId })                // 幂等，未归档不报错
```

### 归档（PM 在上线检测 OK 后触发）

1. 记下该需求的 **4 个执行会话** id（负责人 / 开发 / 自测 / 部署，各 1）；**PM 的聊天会话不在其中**——它按聊天复用，跨需求存在
2. 逐个 `archiveSession`
3. 目录 `workspace/reqs/<线程名>/` → `workspace/_archive/<线程名>/`
4. 删 worktree（`git worktree remove`）
5. `_archive/index.md` 追加一行

### 索引（PM 维护，恢复的唯一凭据）

| 需求 | 线程名 | 执行会话 id（4 个） | 归档时间 | 结论 |
|---|---|---|---|---|
| tumss 三方会话 1.38.0 | tumss-threeway-audit-v1380-20261021 | session-a…, session-b…, … | 2026-11-12 | 已上线，w1~w5 全过 |

### 恢复

1. 查 index.md 拿线程名 + 会话 id
2. 目录移回 `reqs/<线程名>/`
3. 逐个 `unarchiveSession`
4. 会话原样恢复，上下文完整

**注意**：归档会话收消息会被 `blocked`，所以必须先 unarchive 再派单。