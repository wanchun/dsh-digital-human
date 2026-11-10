# 10 · 需求目录与代码 worktree

Type: grilling
Status: open

## Question

每个需求一个目录，五个角色的会话都以它为 cwd：

```
workspace/reqs/<线程名>/
    docs/         # brief / progress / nodes / 证据
    code/<repo>/  # 代码 worktree（分析阶段用）
```

要定：

1. **谁创建目录**：PM 首次派单时建（推荐，一次成型），还是负责人建？
2. **worktree 谁建、何时建**：需求分析阶段需要代码 → 负责人在开工前为涉及仓库各建一个 worktree；`git worktree add` 与主仓共享对象，不占额外空间。
3. **worktree 与千手的冲突**：现在改代码走千手（远端任务），本地 worktree 只用于**分析/读代码**，不用于提交。这个边界要写进人设。
4. **归档时删 worktree**：`git worktree remove`，避免仓库列表被污染。
5. **多仓库需求**：`code/<repo1>/ code/<repo2>/`。

➡️ 推荐：PM 建档时建目录；负责人开工前建 worktree；只读用途；归档删除。