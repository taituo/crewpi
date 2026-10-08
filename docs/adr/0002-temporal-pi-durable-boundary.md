# ADR-0002: Temporal vs Pi Durable responsibility

Status: Proposed (stack constraints below are given by the project owner and are not open for debate)

## Context
[Current] Temporal runs `incidentWorkflow`; activities call `askAgentAndWait` which submits to Pi Durable with a stable `requestId` and waits. Pi Durable owns the LLM transcript, tool-call durability and compaction. Both run inside the HTTP process. Pi Durable is experimental upstream and pinned at 1.0.4.

## Fixed constraints (owner decision, 2026-10-08)
1. **Both stay.** Temporal and Pi Durable are both used; neither replaces the other. No Temporal->DBOS switch and no Temporal version change as part of this plan.
2. **Opinionated "with batteries" stack:** Kubernetes (k3s) + Keycloak + Temporal + Pi Durable + SQLite/Postgres per ADR-0001. New work may assume these exist; it does not add pluggability for alternatives unless a prompt asks.
3. **Temporal is used narrowly.** Only for: waiting on humans, timers/escalation, multi-step processes that must survive restarts, retries of activities. It is not used for single LLM calls, chat delivery, or as a message bus.
4. **Pi Durable is used narrowly.** Only for one agent's run and its transcript/tools. It never tracks business status of work, handoffs or approvals.
5. **The line, in one sentence:** *if it has a due date, a human, or more than one agent, it is a Temporal workflow; if it is one agent thinking and calling tools, it is a Pi run; business status lives in domain rows that both update.*

## Rules that make the line enforceable
- A workflow starts a Pi run only through the agent-run API (`submit` with a stable `requestId`); it never reaches into Pi storage.
- A Pi tool never starts or signals a workflow directly; it writes a domain command, and the Work Service starts/signals (so there is one path, and it is audited).
- Approvals: the tool blocks only in Pi (current `gate`), while workflows wait for a *workflow-level* decision signal. A workflow activity that triggers an approval-gated tool must heartbeat (as `askAgent` does today).
- No state is duplicated: workflow variables hold ids and small summaries; the full text stays in rows.

## Lessons from Entropi (reference, not a dependency)
Entropi (sibling project, no Temporal) keeps the core as actor-checked operations over an append-only event log with separation of duties on decisions. Crew adopts those *domain* ideas (ADR-0005, P0a) but keeps Temporal for process orchestration. Known Entropi issues (e.g. missing memo-note tooling) are a reminder that Crew's `memo_note`/`memo_recall`/`memory_zoom` tools and tests in `test/memory.test.ts` must be preserved by any refactor.

## Decision (recommended)
| Concern | Owner |
|---|---|
| Business process position, timers, retries, escalation, human wait | Temporal workflow |
| One agent run (LLM calls, tool calls, replay of tool tasks) | Pi Durable |
| Business status of Task/Handoff/WorkItem | Domain rows (Work Service), updated by activities/signals |
| Approvals | Tool Gateway rows; Temporal only waits via signal/poll |

Contract between them (the **agent-run API**, Prompt 11):
`submit({requestId, agentParticipantId, input, scope}) -> {runId}` idempotent on `requestId`;
`status(runId)`; `cancel(runId)`; result is read as the run's final assistant message ref.
Activities never read Pi internals directly (today they use `leafRawByEntry`; that becomes an implementation detail of the API).

## Alternatives
- Replace Pi with Temporal-native agent loops (activities per LLM call): full control and horizontal scale, but rewrites durability/compaction/tool replay already working.
- Keep both, merge state (rejected): creates two owners of progress.

## Consequences
Clear single owner per state kind (plan C.6). Scaling workers does not scale Pi (see ADR-0006).

## Verify
Whether Pi Durable exposes cancel/status for a submission in 1.0.4 [Assumption]; Temporal task-queue routing and versioning for workflows with long timers; that `requestId` dedupe in Pi survives process restart (tested for workflows in `test/workflow.test.ts`).
