# Spec · 测试环境部署数字人

## 1. 问题

`qs-end-to-end-fast` 的 D 部署节点写着"由研发助手触发"，但两处现实与之不符：

- 部署实际由**触发人手工**在 pace+ 页面点（`nodes/w2-01-pace-cli-release-playbook.md` 明写"本次不执行任何构建/发布"）
- 自测派单实际由 **PM** 做（会话日志：PM → QA 12 次，研发助手 → QA 0 次）

同时 PM 与研发助手各自维护状态，出现"你的认知落后一步"这类对账（PM → 研发的存量消息可证）。

## 2. 目标

1. 新增一个**测试环境部署数字人**，接手 D 节点的执行。
2. 明确 **PM 是唯一调度者**：它决定下一步派给谁；其余助手只执行。
3. 把"等"从人的身上挪走：部署从"人守页面"变成"派单 → 回执"。
4. 同步三处人设与两处技能文档，消除漂移。

## 3. 非目标

- 生产部署、生产包同步、运维交付（规则外）。
- 上线检测的判定（第一批不做）。
- 改 pace 平台、改 qs 引擎、改数字人插件代码。

## 4. 角色与链路

```
研发助手  A 开发 → B 合并 → C 验证 →（可部署）→ F 冒烟 / 修复环
    ↑ 派活 / 回执                          ↓ 可部署
PM  派部署 → 收部署回执 → 派自测 → 收自测结论 → 通知研发冒烟或修复 → 汇总对外
    ↓ 派单                    ↑ 回执
部署人  拆单 → 子 agent 执行 D → 汇总 → 回执给 PM
    ↓ 派单（由 PM）
自测助手 执行 E → 回执给 PM
```

| 角色 | 做 | 不做 |
|---|---|---|
| PM | 调度 D/E/F、收所有回执、对外 | 不执行任何节点 |
| 研发助手 | A/B/C/F + 修复环 | 不派 D、不派 E、不碰 pace |
| 部署人 | D：查占用→校验分支→触发→轮询→回执 | 不写代码、不派自测、不碰生产 |
| 自测助手 | E | 不派活 |

## 5. 契约

### 5.1 派单（PM → 部署人）

| 字段 | 必填 | 说明 |
|---|---|---|
| `subsystem` | 是 | 子系统名（如 `RCS-CSA`） |
| `idc` | 是 | 目标环境（M1/F1/G1/K…） |
| `version` | 是 | 版本号 |
| `branch` | 是 | 部署分支 |
| `process_dir` | 否 | 版本过程目录路径，用于落证据 |
| `confirmed` | 否 | 首轮确认后由 PM 置 true |

消息正文只给指针（版本目录、子系统、环境、分支），不贴日志。

### 5.2 回执（部署人 → PM）

| 结论 | 附带 |
|---|---|
| `success` | triggerId、包名、环境、耗时 |
| `failed` | triggerId、归因（分支不一致 / 构建失败 / 环境被占 / 凭据）、证据路径 |
| `queued` | 当前占用者与预计释放方式 |
| `needs-confirm` | 子系统+环境+版本，等 PM 代问触发人 |

### 5.3 首轮确认

- 键 = **子系统 + 环境 + 版本**。
- 部署人首见该键 → 回 `needs-confirm`；PM 用现有 bot 问触发人；确认后 PM 重派并带 `confirmed: true`。
- 同键后续（含修复环重发）不再问。换环境或换版本重新问。

### 5.4 占用与锁

- 锁是**目录**：`occupations/<子系统>@<环境>`，用 `mkdir` 原子创建；失败即"已被占用"。
- 触发前必须拿锁；终态后释放。
- 崩溃残留：启动或下一次派单时，按 triggerId 复查该流水是否仍在运行，已终态则回收。
- key 粒度 = `(子系统, 环境)`；机器明细写在锁目录内的 `owner.json`，仅供回执与排查。

### 5.5 子 agent 使用

- **全部执行交给子 agent**：主会话只拆单与汇总。
- 每个 `(子系统, 环境)` 一个子 agent，单次 ≤4。
- 子 agent 禁用协作工具（`digital_human_send` / `notify_bot`），只对主会话说话。
- 子 agent 只回结论 + 指针（triggerId、包名、环境、证据路径）。
- 触发/轮询必须比对 `triggerId`，避免把上一次的 SUCCESS 当本次。

## 6. 改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `~/.dsh/digital-human/humans/deploy-assistant/config.json` | 新建：enabled、workspace 同其余、skills `pace-cli-helper/qs-assistant/digital-human-comms`、peers `[pm-assistant]`、`permissionPreset: danger-full-access`、`sessionMode: single`、`memory: true`；不绑 bot |
| 2 | `.../deploy-assistant/persona.md` | 新建：职责边界、锁、子 agent 纪律、回执格式 |
| 3 | `.../deploy-assistant/memory.md` | 新建：只写机制（环境清单来源、锁路径、命令指向技能） |
| 4 | `.../dev-assistant/persona.md` | D/E 两段从"自己执行"改为"报可部署 / 不派自测"；保留 F 与修复环 |
| 5 | `.../dev-assistant/memory.md` | 修正"触发人发布、我只排障""我派自测"等旧口径 |
| 6 | `.../pm-assistant/persona.md` | 职责边界补：调度 D/E/F、收部署回执再决定下一步 |
| 7 | `~/.dsh/digital-human/skills/qs-end-to-end-fast/references/node-deploy.md` | 改为"按派单执行 + 回执给 PM" |
| 8 | `.../references/node-self-test.md` | 派单方改为 PM |
| 9 | `.../SKILL.md` 节点表 D/E 行 | 责任人改为"PM 派、部署人/自测助手执行" |
| 10 | `README.md` | 角色表补部署人；已知限制补"一个 bot 只服务一条记录" |
| 11 | `src/lib/presets.ts` + 单测 | 把 peer 清单一行的 **id 列表**改成**带描述的清单**（读注册表 `description`，缺失回退 id）——否则 PM 只知道 id，不知道谁能干什么 |
| 12 | 四条记录的 `config.json` | 补 `description`：PM=接入与调度 / 研发=开发合并验证冒烟与修复 / 自测=按派单验证 / 部署=发测试环境并回执 |

## 6.1 四条记录的 description

| 记录 | description |
|---|---|
| pm-assistant | 需求接入与调度：把关需求、决定下一步派给谁、对外汇报 |
| dev-assistant | 研发执行：开发、合并、验证、冒烟与修复环 |
| qa-assistant | 测试执行：按派单在测试环境验证 |
| deploy-assistant | 部署执行：发测试环境，查占用→校验分支→触发→轮询→回执 |

注入到每个数字人提示词里的形状：

```
- Your peers are:
  - `dev-assistant`（研发执行：开发、合并、验证、冒烟与修复环）
  - `qa-assistant`（测试执行：按派单在测试环境验证）
  - `deploy-assistant`（部署执行：发测试环境，查占用→校验分支→触发→轮询→回执）
```

## 7. 验收

- `registry.list` 出现 `deploy-assistant`；`dh-deploy-assistant` 预设注册成功。
- 四条记录都有非空 `description`，且 PM 的提示词里能看到同伴职责（不是只有 id）。
- 部署人 persona 中不出现"生产"作为职责；不出现"派自测"。
- 研发助手 persona 中 D/E 不再是"你自己做"。
- `node-deploy.md` / `node-self-test.md` / SKILL.md 三处口径一致。
- 沙箱：注掉真实命令（干跑模式），PM 派一条 → 部署人回 `needs-confirm` → PM 确认重派 → 部署人回 `success`（用桩数据）。
- 备份可回滚：`~/.dsh/backups/humans-and-skills-20261029-175122.tgz`。

## 8. 风险与回滚

| 风险 | 处置 |
|---|---|
| 改人设导致行为漂移 | 改前整目录打包；改后逐文件 diff 复核 |
| 部署人误发生产 | persona 明禁；派单缺 `idc` 直接拒绝 |
| 锁残留 | 按 triggerId 复查回收 |
| 一个 bot 只能服务一条记录 | 部署人不绑 bot，确认由 PM 代问 |

回滚：`tar xzf ~/.dsh/backups/humans-and-skills-20261029-175122.tgz -C ~/.dsh`，并删除 `humans/deploy-assistant`。