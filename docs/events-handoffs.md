# Prompt 05: events, outbox/inbox, handoffs, CaseContext

Branch `feat/p05-events-handoffs` (on top of Prompt 04 and the CLI). Status is kept at the end of this file.

## No overlap: what exists, and what this changes
| Existing piece | Decision |
|---|---|
| `messages` + SSE `hub` | Stay the chat projection. A handoff appears as the existing delegation message; no second message pipeline. |
| `audit` table | Stays for **privileged actions** (who changed what). `events` is **what happened to the work**. Not merged; event types for approvals/decisions are emitted, audit rows are not duplicated into events. |
| `approvals` table and `gate()` | Stay the only approval state. A decision emits `decision.made`; `requested_by_sub` is now filled and separation of duties is enforced. No second approval table. |
| `ask_agent` tool | **Same tool name, text and arguments.** The implementation moves to the handoff service; the in-memory limits (`recentAsks`, `recentDelegations`, `depthByConv`) are replaced by rows (finding F-8). |
| Incident workflow + `askAgentAndWait` | Untouched. Its agent asks are workflow-owned activities, not handoffs. Both go through the same `submitToAgent` (AgentRun) door. |
| Pi Durable run | Still owns one agent run. Handoff status is derived from run lifecycle signals (durable submit = accepted, run start = in progress, run end = completed); no handoff state lives in Pi. |
| Temporal | One new workflow type, `handoffWorkflow`, one per handoff (`handoff:<id>`): only the acknowledgement/due timers and escalation. Business status stays in the `handoffs` row. Without Temporal there are **no timeouts** (reported, not faked with a second timer). |
| `memo_note` / OptChat memory | Per-agent private memory. CaseContext is the **shared, sourced** picture of a case; DM content never feeds it. |
| `change_feed` (parked branch `feat/bets-first-bite`) | Not used here. When that branch is adopted, `events.sequence` is the SSE spine and `change_feed` goes away. |
| Org registry (Prompt 04) | Used for routing: backup = `substitutes_for`, who to inform = `must_inform`. Optional (needs the registry seeded); falls back to the channel. |

## Vocabulary (never mixed)
*sent* (event stored) -> *delivered* (outbox consumer handed it over) -> *acknowledged* (recipient accepted: Pi durably holds the submission) -> *in progress* (the run started) -> *completed* (the run ended with an answer). An acknowledgement never proves that the recipient understood anything.

## Event envelope
`eventId, sequence, tenantId, organizationId, scope(live|synthetic)+worldId+branchId, type, schemaVersion, actorId, actorType, correlationId, causationId, sourceRefs[], visibility (org | channel:<id> | owner:<sub>), channelId, occurredAt, payload`.
Delivery is at-least-once to each destination; consumers are idempotent through the inbox `(consumer, eventId)`.

## What was built (branch `feat/p05-events-handoffs`)
| Piece | Where | Notes |
|---|---|---|
| Event log, outbox, inbox, relay | `src/work/events.ts`, migration 5 | `emit()` inside the caller's transaction; one relay per process; at-least-once, idempotent by inbox; back-off, `failed` after 8 tries |
| Task + Handoff state machine | `src/work/handoffs.ts` | `requested -> accepted/rejected -> in_progress -> completed/failed/escalated`, `cancelled` by a person; repeated signals are no-ops; limits (depth, repeats, rate) are rows |
| Run lifecycle -> handoff status | `src/work/lifecycle.ts`, Mirror hooks in `runtime.ts` | durable submit = accepted, run start = in progress, run end = completed, task failure = failed |
| Dispatch / watchdog / notify | `src/work/consumers.ts` | dispatch submits to the recipient (stable `requestId`); watchdog starts/signals Temporal; notify tells the channel and the rooms the org says must be informed |
| Watchdog workflow | `src/workflows/handoff.js` | one per handoff (`handoff:<id>`): ack deadline, due deadline, escalation. Holds only ids |
| Escalation | `src/work/escalation.ts` | the single decision point (called by the workflow's activity): re-ask the backup (from `substitutes_for`) once, else only `escalated` + a notice |
| Routing | `src/org/routing.ts` | backups and who-to-inform from the adopted org graph; empty when none is seeded |
| CaseContext | `src/work/case.ts` | facts with sources and confidence, supersede, stale (TTL), unverified, conflicts, decisions with authority, awaiting, orphan tasks; private chats refused |
| Who started the chain | `conv_origin` table, `setOrigin/getOrigin` | replaces the in-memory depth map; approvals get `requested_by_sub` |
| Separation of duties | `server.ts` decide route, `SEPARATION_OF_DUTIES` (default on) | the starter of a chain cannot approve what it asks for |
| Agent tools | `case_add_fact`, `case_context`; `ask_agent` unchanged for the model | |
| API | `GET /api/channels/:id/case`, `GET /api/handoffs`, `POST /api/handoffs/:id/cancel`, `GET /api/domain-events` | all filtered by channel visibility |
| CLI | `crew handoffs`, `crew case <channel>`, `crew events` | E1 |
| UI | "Work" panel in the right column | who waits for whom, acknowledged or not, conflicts, orphans, facts, decisions |

## Tests (91 in the whole suite)
`events` (6), `handoffs` (7), `work-consumers` (5), `case-context` (6), `handoff-workflow` (real Temporal, incl. worker crash), `p05-e2e` (real server: chain, events, SoD), `p05-watchdog-e2e` (real server + real Temporal + escalation), CLI (1 new).

## Honest limits
- **Without Temporal there are no timeouts** (the API reports `watchdog: off`, the panel says so). That is deliberate: no second timer.
- **Acknowledged = Pi holds the submission durably; completed = the run ended.** Neither says the answer is right or was understood.
- **Workflow-initiated asks** (the incident workflow) are not handoffs and carry no `requested_by_sub`; separation of duties does not apply to approvals they trigger.
- **The scripted demo cannot reach a real approval** without a Kubernetes cluster; SoD is tested through the HTTP decide route with an approval row written the way `gate()` writes it, and the origin it relies on is asserted from a real run.
- Facts are written by agents through a tool: nothing checks that a cited source exists. `confidence` is the writer's claim.
- No tenant filter in the new queries yet beyond the `tenant_id` columns (single tenant today); the registry routing is read-only and only knows the default organization.
- `events` is not yet the SSE spine; the browser still polls messages. `change_feed` (parked branch) would be replaced by `events.sequence`.
- Handoffs are agent-to-agent; person-to-person handoffs and a UI action to reject/decline as an agent are not built (the service supports `reject`).
- **Only agent-to-agent handoffs use the outbox.** A person's message to an agent still goes `POST /messages -> submitToAgent` in-line, so finding F-11 (a crash between storing the message and dispatching it) is **not yet fixed for that path**. Moving it behind the same outbox (a `message.posted` event with a dispatch consumer) is the next small step.
