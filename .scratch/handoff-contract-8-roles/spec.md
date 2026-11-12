---
title: 八角色研发交接约定
labels: [ready-for-agent]
---

## Problem Statement

八个数字人共同完成一项需求。每个角色有自己的职责和会话。
它们用短消息交接，并在需求文件中保存事实与证据。

插件已有需求寻址、结构化派单、工作项和回执。
规则分散在工具说明、运行时提示、写作规范和角色 playbook。
旧组织规范仍以五个角色为前提。

因此，团队缺少八角色共用的交接约定。
交接可能重复事实，也可能传入过多做法指令。
收件人可能重读历史，或再次询问已有信息。
这会增加上下文和返工。

本规格只定义派单、回执和文件指针。
它不重设计需求账本或工作流状态机。

## Solution

建立简短、统一的交接契约。工具定义字段和传递行为。
运行时提示说明共用规则。角色 playbook 保留本角色的判断和验收要求。

每次交接只传当前工作需要的事实、验收要求和文件指针。
收件人先读需求摘要，再读本次需要的文件。
完成后写入证据，并回结论、证据路径和下一步。

阶段状态和证据索引写入现有需求文件。
消息不复述完整需求、历史、报告或日志。
只安排适用的分析、验证、端到端和上线准备角色。

## User Stories

1. As a PM, I want to send confirmed requirement facts and acceptance criteria to the lead, so that the lead can start without asking for facts already recorded.
2. As a PM, I want to answer only unresolved business questions, so that I do not resend the full requirement history.
3. As an analyst, I want each open question to point to the requirement and its evidence, so that I can continue the correct analysis after a reply.
4. As an analyst, I want to return the specification, ticket references, and release decision, so that the lead can route ready work without copying the specification into chat.
5. As a lead, I want to read the requirement digest and relevant evidence pointers, so that I can select the next role without replaying the conversation.
6. As a lead, I want to assign facts and acceptance criteria but not implementation steps, so that each executor follows its own playbook.
7. As a lead, I want to assign only applicable roles, so that document-only or backend-only work does not receive unnecessary handoffs.
8. As a developer, I want a ticket reference, repository facts, and acceptance criteria, so that I can execute the task without unrelated requirement history.
9. As a developer, I want to return the outcome and evidence path, so that the lead can update requirement state without rereading my process log.
10. As a QA engineer, I want the tested environment, deployed version, acceptance criteria, and report destination, so that I can verify the intended build.
11. As an E2E engineer, I want only the page or cross-system scope that needs browser verification, so that I do not duplicate unrelated QA checks.
12. As a deployer, I want confirmed subsystem, version, branch, and target environment facts, so that I can verify the intended deployment.
13. As a deployer, I want to return the deployment result and evidence pointer, so that QA can start from the verified deployment rather than a chat summary.
14. As a release-preparation role, I want an explicit request and links to completed test and deployment evidence, so that I do not start release work prematurely.
15. As any executor, I want to return my result to the sender on the same requirement thread, so that the reply reaches the correct work owner.
16. As a sender, I want to request a receipt only for assigned work, so that questions, answers, and cancellations do not create receipt loops.
17. As a recipient, I want one sentence of current context and a pointer to the previous conclusion, so that I can continue without receiving the previous conclusion in full.
18. As a requirement owner, I want status and evidence pointers stored in the requirement record, so that role conversations do not become the project database.
19. As a maintainer, I want each common handoff rule defined once, so that the tool description, runtime prompt, and eight playbooks do not drift.
20. As a maintainer, I want to measure handoff size, clarification, retries, and rework in a pilot, so that token targets come from evidence rather than guesses.

## Implementation Decisions

### Shared dispatch contract

Keep the existing public `digital_human_send` schema and work-item model. Do not add ticket, dependency, decision, or project-database fields.

- `requirement` identifies the requirement thread and its directory.
- `mode` retains the existing new, amend, and cancel behavior.
- `task_id` identifies an existing item when more than one open item could match, and is used for an explicit amendment or cancellation.
- `node` remains optional. The recipient may decide whether the node applies.
- `facts` contains verified facts and relevant absolute file paths.
- `context` contains one sentence about current progress and a pointer to the previous conclusion.
- `message` contains the requested outcome, acceptance criteria, and evidence expected. It does not contain procedure, command lists, or cautions.
- `expect_receipt` is explicit. The sender enables it for assigned work that needs a result. It is omitted for a question, answer, acknowledgement, or cancellation.

The mechanism continues to reject the existing forbidden procedure fields. Do not add keyword matching over natural-language message bodies. Such matching cannot reliably distinguish instructions from valid acceptance criteria.

### Receipt contract

The common receipt contains three items:

1. Conclusion.
2. Evidence path.
3. Next step or `none`.

A role may include its own acceptance checklist when its playbook requires one. The common contract does not duplicate that checklist across roles. The executor replies to the sender on the same requirement thread.

### Eight-role responsibilities

| Role | Handoff responsibility | Durable result |
|---|---|---|
| PM | Confirm intake facts and acceptance criteria; send the requirement to the lead; route unresolved business questions to the decision-maker. | Requirement metadata and parameter record. |
| Analysis | Clarify only unresolved scope; return the specification, tickets, and release decision to the lead. | Analysis artifacts and question status. |
| Lead | Read the requirement digest; select applicable roles; dispatch facts and acceptance criteria; record node status and evidence pointers. | Requirement status, concise progress, and role receipts. |
| Developer | Work from assigned ticket references; return code/task outcome and evidence. | Code-review, merge, or verification evidence. |
| QA | Verify deployed behavior against acceptance criteria; return a report pointer. | Self-test cases and report. |
| E2E | Verify UI or cross-system behavior when the change requires it; avoid duplicating unrelated QA coverage. | E2E cases and report. |
| Deploy | Deploy the specified version to the specified test environment and return the terminal result. | Deployment evidence. |
| Release preparation | Start only after an explicit request and relevant verification evidence; return readiness or blocking facts. | Release-preparation evidence. |

The lead remains the normal coordinator. Analysis, QA, E2E, deployment, and release preparation do not dispatch unrelated work to each other. A question goes to the role that owns the missing decision. Business confirmation goes through PM.

### Files and context

- `state.json` remains the machine-readable node status and evidence index.
- Requirement artifacts remain the detailed source of truth. The sender gives paths instead of copying artifact bodies into a message.
- The recipient starts from the requirement digest, then reads only the files needed for the assigned work.
- Memory stores reusable cross-requirement knowledge and unresolved oral decisions. It does not duplicate requirement status, report contents, or evidence already stored in requirement files.
- A phase handoff is complete only after its result is written to the designated artifact and its status points to that artifact.

### Source of truth and change scope

The send tool owns fields, routing, work items, and receipt insertion.
The runtime context owns common model-facing rules.
Role playbooks own role-specific judgment and acceptance criteria.
The maintainer guide explains authoring. It does not define another protocol.

Update only surfaces with missing or inconsistent rules.
Keep changes small. Do not rewrite all eight playbooks for a shared gap.

Do not introduce a numeric message or token cap in this change. Measure a representative pilot first. Use existing compaction only after durable results are written, when a session needs continued work; do not require a new session for every ticket.

## Testing Decisions

- Test external behavior at the public `digital_human_send` tool seam. Do not test private helper implementation details.
- Verify that a dispatch renders requirement, task id, node, facts, context, and message in a stable order.
- Verify that explicit forbidden procedure fields are rejected and no delivery occurs.
- Verify that the receipt line appears only when explicitly requested and contains the resolved requirement and node.
- Verify that new, amend, and cancel behavior addresses the intended work item and does not duplicate or retire a different item.
- Verify that role context states the shared contract once and role playbooks retain only role-specific decision criteria.
- Use the existing tool-execution tests as prior art for field rendering, forbidden fields, receipt behavior, and delivery assertions.
- Run a sandbox pilot for applicable transitions only.
- Do not force all eight roles into every requirement.
- Record per-role input tokens and handoff size.
- Record clarifications, repeat sends, polls, rework, and missing evidence.
- Compare with a baseline. Claim no token reduction without evidence.
- Do not use production sessions or production deployment for the pilot.

A good test observes the message received, the work item changed, the correct reply returned, or the durable evidence recorded. It does not assert private helper calls or exact prompt prose beyond the required contract.

## Out of Scope

- A new work-item, ticket, dependency, decision, or project database schema.
- A new generic workflow engine or hardcoded role state machine in the plugin.
- Bash read interception or semantic keyword blocking of free-text messages.
- A fixed context-token ceiling, automatic session splitting, or a global DSH compaction-policy change.
- A new memory store or a rewrite of the existing memory architecture.
- Rewriting historical requirement specifications or migrating old work-item data.
- Production rollout or changing release, deployment, DPMS, PACE, or 千手 platform behavior.
- Forcing every role to run on every requirement.

## Further Notes

This is a follow-up to the existing fact-only dispatch contract. The current tool already has structured handoff fields, rejects explicit procedure fields, and has tests for rendered dispatches and receipts. This specification covers the eight-role organization and the low-context operating convention; it does not replace the broader historical organization specification.

The role roster for this specification is PM, analysis, lead, developer, QA, E2E, deploy, and release preparation. The eight roles can share a requirement thread while keeping separate role sessions. Requirement files, not full chat history, carry cross-role state.
