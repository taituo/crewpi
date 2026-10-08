# Risk register

Status: **proposal** (Prompt 00). Likelihood/impact: L/M/H. "Finding" refers to `architecture-target.md` §1.3.

| ID | Risk | Finding | L | I | Mitigation / owner prompt | Detection |
|---|---|---|---|---|---|---|
| R-01 | Cross-tenant or cross-org data leak because no tenant dimension exists today and new features add many read paths | F-1 | H | H | Tenant/org columns first (P0a); repositories require `ActorRef`; Postgres RLS if adopted (ADR-0001); leak tests per prompt | Negative ACL tests in CI |
| R-02 | Approver approves own request; or attribution by display name is ambiguous | F-5, F-6 | H | H | `requested_by_sub`, `decided_by_sub`, separation-of-duties policy (P0a/04) | Test: requester cannot approve under default policy |
| R-03 | Delegated work is "sent" but never done; nobody notices | F-3 | H | M | Handoff state machine + due date + escalation (05) | Overdue handoff metric/alert |
| R-04 | Crash between persisting a human message and dispatching it to an agent drops work | F-11 | M | M | Transactional outbox + relay (05) | Chaos test: kill after insert |
| R-05 | A second process opens the same Pi storage and corrupts it silently: the library has **no cross-process locking** (README, 1.0.4); today only `replicas: 1` + `Recreate` prevents it | F-9 | M | H | **Lease lock in `src/lock.ts` (P0a, done)**; single owner service for Pi; `submit/status/cancel` API; no multi-replica claims until ADR-0002 implemented | Startup lock check; docs gate |
| R-06 | Default session secret reaches a real deployment | F-16 | M | H | Refuse to start in OIDC mode with default secret (P0a) | Startup test |
| R-07 | Descriptive org edges accidentally treated as authority | - | M | H | Separate edge classes; Tool Gateway reads only authoritative grants (04) | Test: user-added edge never grants write |
| R-08 | At-least-once delivery produces duplicate external side effects | F-11 | M | H | Idempotency keys on every outbound action; inbox dedupe; no exactly-once promises | Duplicate-delivery tests |
| R-09 | Shared CaseContext leaks private (DM) content or presents stale/contradicted facts as current | F-4 | M | H | DM excluded from projections; per-fact TTL; contradiction status | Projection ACL tests |
| R-10 | Agent impersonates a human, or external agent claims a human's identity | F-7 | M | H | Server-resolved `ActorRef`; provenance columns; delegation tokens with expiry | Impersonation tests |
| R-11 | Prompt injection through tool output, MCP content, Teams messages | - | H | M | Deterministic policy layer decides authority; content treated as data; approvals; sandbox | Injection fixtures |
| R-12 | Ad-hoc schema changes break existing demo databases | F-20 (+ migration finding) | M | M | Migration runner + upgrade tests from audited-commit DB (P0a) | CI migration test |
| R-13 | Audit log tampering / loss of actor identity | F-14 | M | M | Append-only, hash-chained audit with `actor_id`; retention policy | Chain verification job |
| R-14 | Org-builder complexity: users model graphs that validate but behave unexpectedly | - | M | M | Deterministic validators with explanations; simulation (08) later; versioned orgs enable rollback | Validation report |
| R-15 | Demo/fixture data mixed with live data, leading to false conclusions or fake side effects | F-10 | H | M | `source` tag on all records; fixture adapters named `demo`; UI badge | Test: no `demo` record in `live` projections |
| R-16 | Synthetic world performs a live write | - | L | H | Deny-by-absence adapter registry; no secrets copied into branches; dedicated test | Live-write tripwire test |
| R-17 | Simulation replay diverges silently after reducer change | - | M | M | `reducerVersion` in snapshot; refuse or migrate (07) | Hash comparison test |
| R-18 | LLM nondeterminism makes experiments unreproducible | - | H | M | Recorded mode logs every LLM/tool response; seeds alone are not trusted | Replay hash test |
| R-19 | Cost run-away with large-scale delegation (many agents/items) | - | M | H | Per-pool and per-item budgets in policy; backpressure; existing OpenRouter soft cap is per key only | Budget metrics; kill switch |
| R-20 | Human alert fatigue: exception centre becomes the new inbox | - | M | M | Dedup, ranking, "why raised", measured human attention (14) | Exceptions/day per human metric |
| R-21 | Control state kept in process memory (rate limits, depth, tree queue) behaves wrongly after restart or with >1 process | F-8 | H | M | Persist counters; key depth by causal chain (`causationId`) | Restart test |
| R-22 | SSE clients miss events after reconnect → stale approval buttons, hidden exceptions | F-13 | H | M | Event sequence ids + `Last-Event-ID` resume (05/01) | Reconnect test |
| R-23 | Session role staleness: a revoked approver stays approver for ≤ 8 h | F-15 | M | M | Shorter TTL for privileged actions; server-side revocation list or re-check via token introspection for approvals | Revocation test |
| R-24 | Dev toolchain mismatch (Node 18 vs ≥ 22.19) yields misleading test failures | audit | H | L | Preflight check in `npm test`; `.nvmrc` | CI |
| R-25 | Over-claiming: documents or UI state that unbuilt features exist | plan C | M | M | `Truthful product state` rule; release gate checklist (plan E) | Review checklist |
| R-26 | Legal/organizational responsibility is assumed to move to the agent | plan C.12 | L | H | Documentation and UI wording; named human owner for each delegated policy | Policy review |
| R-27 | Synthetic results over-generalized to real organizations | plan B6 | M | M | Calibration and assumptions documented with every report | Report template field |

## Top five to address first

1. R-01 tenant dimension (blocks everything).
2. R-02 separation of duties and identity by `sub`.
3. R-05 explicit decision on Pi Durable ownership before any scaling promise.
4. R-03/R-04 handoff and outbox (core of "delegate and trust").
5. R-21/R-22 persisted control state and SSE resume (operational correctness).
