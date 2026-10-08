# Application service interfaces and sources of truth

Status: **proposal** (Prompt 00, item 6). Conceptual TypeScript; names are fixed when the owning prompt implements them.
All services take a server-resolved `ActorRef` and `WorldScope` as first argument (`architecture-target.md` §2.2) and are the only callers of their repositories. Adapters (HTTP, MCP, Teams, agent tools, Temporal activities) call these and nothing else.

```ts
type Ctx = { actor: ActorRef; scope: WorldScope; correlationId: string; causationId?: string };
```

| Service | Source of truth | Operations (sketch) | Built by |
|---|---|---|---|
| **OrgRegistry** | `organizations`, versions, nodes, edges, participants, memberships, policies | `createOrg`, `createVersion(from)`, `proposeChange(nl)`, `validate(version)` -> findings, `adopt(version)`, `effectiveGrants(participant, capability)`, `describe`, `graph` | 04 |
| **Federation** | realms, entities, agreements, share grants | `createAgreement`, `grant(resource, to, purpose, expires)`, `revoke`, `canRead(ctx, resource)`, `crossEntityTask` | 13 |
| **Conversation** | conversations, threads, messages, drafts, delegations, receipts | `post(msg)`, `createDraft/publishDraft`, `delegate(agent, scope, expires)`, `revokeDelegation`, `list(since)`, `markRead` | 01, 02 |
| **CaseKnowledge** | cases, facts, decisions (projection of events) | `openCase`, `addFact(sourceRefs)`, `supersedeFact`, `context(caseId, forParticipant)` (ACL-filtered), `staleFacts` | 05 |
| **Work** | work items, tasks, handoffs, policy decisions | `receive(workItem, dedupeKey)`, `classify`, `authorize` (policy), `assign`, `handoff.request/accept/reject/complete/fail`, `escalate`, `cancel`, `status` | 05, 11 |
| **ToolGateway** | tool invocations, approvals, idempotency keys, audit | `authorize(tool, args, ctx)` -> allow/deny/needs_approval, `requestApproval`, `decide(approvalId)` (separation-of-duties check), `invoke(idempotencyKey)`, `audit.query` | P0a -> 05 |
| **Oversight** | exception inbox, digests, quality samples (projections) | `exceptions(forParticipant)`, `digest(period)`, `pause(scope)`, `metrics(period)` | 14 |
| **Rhythm / Meetings** | presence, cadences, meetings, decisions | `setPresence`, `returnBriefing(since)`, `interview.next`, `meeting.prepare/run/close`, `override(policy, reason)` | 09, 10 |
| **AgentRun** (internal API in front of Pi Durable) | Pi storage (single owner) | `submit({requestId, agent, input, scope})` idempotent, `status(runId)`, `cancel(runId)` | 11 |
| **World Engine** | world events, snapshots, branches (synthetic only) | `command`, `step/runUntil`, `snapshot`, `reconstruct(seq)`, `fork`, `compare` | 06-08 |
| **Noise / Chaos** | noise profiles, schedules, private injection log, belief state | `inject(schedule)`, `runExperiment(control, perturbed, seeds)`, `scorecard` | 15 |
| **Adapters** (no truth of their own) | transport state only (e.g. Teams conversation refs, MCP sessions) | `ChannelAdapter {receiveMessage, sendMessage, sendDigest, postCard, resolveIdentity, acknowledge}` | 03, 12 |

## Ownership matrix (who may write what)

| State | Writer | Everyone else |
|---|---|---|
| Authority (who may approve/delegate/access) | OrgRegistry only | read via `effectiveGrants` |
| Message and its provenance | Conversation | read |
| Task/handoff business status | Work (called by activities, signals, tools) | read |
| Position inside a process, timers | Temporal | read via `status` query |
| One agent run's transcript | Pi Durable via AgentRun | read via AgentRun |
| Approval decision | ToolGateway `decide` | read |
| Synthetic world state | World Engine | read via scope-checked API |

## Library facts verified for this plan (installed versions)

| Library | Verified | Consequence |
|---|---|---|
| `@earendil-works/pi-durable` 1.0.4 | `requestId` on submissions, `submissionByRequest(conversationId, requestId)`, `abort` on tasks, `resume()`; storages: Memory, SQLite, JSONL (no Postgres); **"one process owns a storage at a time; there is no cross-process locking"**; README marks the API experimental | `AgentRun.submit` can be built on `requestId`; scaling the runtime means sharding by storage; P0a adds a lease lock (`src/lock.ts`) because the library does not |
| `@temporalio/*` 1.24.0 | Version pinned by owner; workflow + worker already running in tests, incl. worker-kill test | No upgrade or engine swap in this plan; task queues per role are configuration, to be verified in Prompt 11 |
| MCP SDK | **not installed, not verified** | Check spec + SDK before Prompt 03 (ADR-0003) |
| Teams SDK | **not installed, not verified** | Check official docs before Prompt 12; build against a mock |
