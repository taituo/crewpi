# ADR-0002: Temporal vs Pi Durable responsibility

Status: Proposed

## Context
[Current] Temporal runs `incidentWorkflow`; activities call `askAgentAndWait` which submits to Pi Durable with a stable `requestId` and waits. Pi Durable owns the LLM transcript, tool-call durability and compaction. Both run inside the HTTP process. Pi Durable is experimental upstream and pinned at 1.0.4.

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
