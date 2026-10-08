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
