# ADR-0005: Message and event delivery

Status: Proposed

## Context
[Current] `POST /api/channels/:id/messages` inserts the row, publishes SSE, then calls `submitToAgent` fire-and-forget (F-11). Delegation idempotency is a `LIKE` scan on message meta (F-12). SSE has no ids (F-13). External systems will be added (Teams, MCP, e-mail), where exactly-once is not available.

## Decision (recommended)
1. **Transactional outbox**: the state change and its `EventEnvelope` are written in one DB transaction; a relay delivers to SSE hub, Temporal (signal/start), agent-run API and adapters.
2. **At-least-once + idempotent consumers**: each consumer writes `(consumer, eventId)` in an inbox table before acting. Documentation never promises exactly-once to external systems.
3. **Stable ids**: `requestId = <purpose>:<causal id>` for agent submissions, `workflowId` derived from `workItemId`, `dedupeKey` unique index on WorkItem.
4. **SSE resume**: event `sequence` is the SSE `id`; server honours `Last-Event-ID` from a bounded retained window, else tells the client to reload.
5. **Outbound external actions** go through Tool Gateway with an idempotency key stored before the call; unknown outcome after a crash is reconciled by lookup when the target supports it, otherwise surfaced as an exception (never silently retried for non-idempotent targets).
6. Replace `hasMessageForRequest` LIKE scan with an indexed `request_id` column.

## Alternatives
Kafka/NATS (extra infrastructure, not needed at this scale); in-process EventEmitter only (current; loses events on crash).

## Consequences
One extra table pair and relay loop; all existing in-line side effects migrate gradually behind the outbox, one route at a time.

## Verify
Postgres/SQLite behaviour for `SKIP LOCKED`-style claiming in the relay (SQLite needs a single relay); transaction semantics of `node:sqlite` `DatabaseSync`.
