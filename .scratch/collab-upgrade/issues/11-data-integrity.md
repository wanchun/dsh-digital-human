# 11 · 先修两处数据不一致

Type: task
Status: resolved

## Question

在讨论"工作项按 (数字人, 会话) 记账"之前，先把两处会让记账失真的缺陷修掉——它们不是新功能，是现状在撒谎。

## 一、地址索引无唯一性（实测已发生）

`~/.dsh/digital-human/humans/pm-assistant/sessions.json`：

```json
{
  "rtcpc-querystatus-fix-v1103-20261013": "session-49ec01ab-725f-4ee9-8de1-9302377a9734",
  "tumss-threeway-audit-v1380-20261021": "session-49ec01ab-725f-4ee9-8de1-9302377a9734"
}
```

两个线程名指向同一条会话。派单与回执因此可能落进同一条历史，而插件不做校验（`src/lib/chat.ts:207-219` 只覆盖写）。

## 二、记忆归档读错目录

- 写入：`compactMemory` 归档到 `memory/`（`memory.ts:177-185`）。
- 读取：`buildSnapshot` 列的是 `memory/run/`（`memory.ts:146`，来自 `memory.ts:44`）。

结果：压缩之后 `memory_status` 报"没有归档"。

## 验收

- 同一 Session 不允许被两个 conversation 名共用；发现即报错或改名，不静默覆盖。
- 压缩后 `memory_status` 能列出刚归档的文件。
- 各加一条单测（现有 609 项单测的入口在 `test/`）。
## Answer

## 进度（2026-10-28）

代码侧已改：

- `src/lib/chat.ts`：`#remember` 拒绝把第二个会话名写到同一条 Session 上，抛错并写日志；`#index` 载入时把重复映射**喊出来**，但不改文件（哪个名字该拥有它，是运维的判断）。
- `src/lib/memory.ts`：`buildSnapshot` 改为列 `archiveDir`——`runDir` 从来没被写过。
- 测试：chat 加 2 条、memory 改 2 条加 1 条；全量 625 项通过，`tsc --noEmit` 通过，`build:host` 通过。

数据侧已修（2026-10-28 11:32）：

- 备份：`sessions.json.bak-20261028-113210`。
- `tumss-threeway-audit-v1380-20261021` 保留 → `session-49ec01ab`（该信箱里有 27 处"三方会话/threeway"，0 处"查询状态"）。
- `rtcpc-querystatus-fix-v1103-20261013` 移除（无任何会话对得上；下次派单自动开新的）。
- 三个数字人的索引复查：无重复。

**先前有一条建议被证据推翻**：原打算把 tumss 指向 `29ac66fd`。查 preset 发现它是 `dh-dev-assistant` 的会话，指过去等于让 PM 接开发助手的历史。已改。