# ADR-0001: Storage - SQLite for the demo, Postgres for new domain state

Status: Proposed

## Context
[Current] `workspace.sqlite` (node:sqlite, WAL) holds channels, messages, approvals, memory, audit; Pi Durable has its own `pi.sqlite`; both have exactly one writer (F-9). Schema evolves by `CREATE TABLE IF NOT EXISTS` and `ALTER ... try/catch` (no version table). No tenant dimension (F-1).
New needs: multi-tenant isolation, outbox/inbox, many concurrent workers writing work items, hash-chained audit, event sequence for SSE resume.

## Options
A. **Stay on SQLite for everything.** Simple; single writer; no RLS; workers cannot scale out.
B. **Postgres for everything now** (including moving existing tables). Cleanest end state; large risky migration; Pi Durable storage still SQLite ([Assumption]: Pi's Postgres support is unverified - check package before relying on it).
C. **Phased (recommended):** introduce a migration runner and repository interfaces over the existing SQLite (P0a). Put *new* domain state (registry, work items, events/outbox/inbox, audit) behind those interfaces with a SQLite implementation first and a Postgres implementation before the first multi-writer deployable (Prompt 11). Existing chat tables move last, if ever.

## Recommendation
Option C. Rules:
1. All new repository functions take `ActorRef` and add `tenant_id` predicates.
2. SQL kept to the common subset; ids are text ULIDs; JSON stored as text/`jsonb`-compatible.
3. Under Postgres, enable Row-Level Security keyed on `SET app.tenant_id` in addition to code checks.
4. Pi Durable storage is not shared with domain DB; it stays single-owner (ADR-0002/0006).

## Consequences
+ Demo keeps working; each prompt migrates only what it touches. + Postgres introduced exactly when needed.
- Two implementations of each repository for a period; need contract tests run against both.

## Verify before acting
Pi Durable storage backends available in the pinned version (1.0.4); `node:sqlite` stability on Node 22.x; chosen Postgres client library and its Node support.
