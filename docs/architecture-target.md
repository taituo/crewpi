# Target architecture: Organization OS & Digital Twin

Status: **proposal** (Prompt 00 audit). Nothing in this document is implemented unless marked *Todettu nykytila / Current*.
Source of the plan: `goal` (implementation plan v1.2, prompts 00-15). Audited commit: `873a01a` (`main`).

Legend used throughout all Prompt 00 documents:

- **[Current]** verified by reading the code at the audited commit.
- **[Assumption]** not verified; must be checked before the dependent prompt starts.
- **[Proposal]** new design, not built.

---

## 1. Current state (audited)

### 1.1 What exists [Current]

| Concern | Where | Behaviour |
|---|---|---|
| HTTP/API/SSE | `src/server.ts` | `node:http`, no framework. REST under `/api/*`, SSE at `/api/events`. CSRF header `X-Requested-With: crew` on non-GET. |
| Auth | `src/auth.ts` | OIDC code+PKCE against Keycloak, `jose` JWT verification. Session = HMAC-signed cookie (8 h) carrying `{sub,name,email,roles}`. Roles come from `realm_access.roles`. `permsOf()` maps `admin ⊃ approver ⊃ operator ⊃ viewer`. Dev mode has three hard-coded users. |
| Channels | `src/channels.ts` | `standing` / `issue` / `dm`. One flat set per deployment; **no tenant or organization column**. Agent membership is a JSON array on the channel row. Visibility rule `canSeeChannel`: DMs owner-only, everything else visible to every signed-in user. |
| Messages | `src/db.ts` | `messages(channel_id, author_kind, author_id, author_name, text, meta JSON)`. `author_kind ∈ human|agent|system`. Identity beyond that is free text inside `meta`. |
| Agent runtime | `src/runtime.ts` | One Pi Durable conversation per `(channel, agent)`. `Mirror` converts the Pi event stream into one message row per agent turn. Inference providers: openai, openrouter, local (OpenAI-compatible), demo (scripted). |
| Tools | `src/tools.ts`, `tools-insight.ts`, `tools-sandbox.ts` | Grouped as Pi Durable extensions; each agent gets a fixed extension list from `src/agents.ts`. |
| Approval gate | `src/tools.ts::gate`, `src/db.ts` | Approval row keyed by `task_id UNIQUE`; waits on DB state + in-process `EventEmitter`. First decision wins. No expiry, no requester/approver separation. |
| Delegation | `src/tools.ts::ask_agent`, `runtime.ts::submitToAgent` | Fire-and-forget: the call returns "Asked @x" immediately. Depth/rate/duplicate limits kept in **process memory**. The target agent's answer appears only as a normal channel message. |
| Workflow | `src/workflows/incident.js`, `src/activities.ts` | One Temporal workflow. Activities call `askAgentAndWait` in the **same process** as the HTTP server. `requestId = wf:<workflowId>:<key>` makes retries reuse the Pi submission. |
| Memory | `src/memory.ts`, `src/optchat.ts` | Notes (agent/channel scope) + per-conversation binary summary tree. The tree is keyed by Pi `conversation id`, **not** by organization. Builder queue is in memory. |
| Projections to UI | `src/hub.ts`, `public/app.js` | SSE fan-out filtered per user via `canSeeChannel`. SSE events carry **no id**; there is no `Last-Event-ID` resume. |
| Integrations | `src/fakes.ts`, `src/integrations.ts`, `src/tools-insight.ts` | Jira/GitHub/GitLab/Gerrit/CI/Grafana/Temporal data is **scripted fixture data** that interacts with the real cluster only through `markCheckoutFixed()`. |
| Storage | `workspace.sqlite` (app) + `pi.sqlite` (Pi Durable) + Temporal dev server (SQLite) + Keycloak H2 | Single writer process. |

### 1.2 Test baseline [Current]

Run on this machine, 2026-10-08:

- System Node is **v18.19.1**; the repo requires `>=22.19`. `npm test` under Node 18 fails 9/9 files with `ERR_UNKNOWN_FILE_EXTENSION ".ts"` (not a code defect; wrong runtime).
- With Node **v22.23.3** (installed only in a scratch directory via the `node@22` npm package) and the `temporal` CLI present: **35 tests, 35 pass, 0 fail, 0 skipped**, including both Temporal workflow tests (`incident workflow...`, `durable: the worker dies...`).
- What is *not* covered by any test: OIDC login (no Keycloak in tests), real Kubernetes calls, real OpenAI/OpenRouter calls, SSE reconnect behaviour, multi-process access to the SQLite files, the browser UI.

### 1.3 Findings (gaps relevant to the plan)

Numbered `F-n`; referenced by the risk register and ADRs.

| ID | Finding | Evidence |
|---|---|---|
| F-1 | **No tenant/organization dimension anywhere.** Channels, messages, approvals, memories, audit are global. Every ACL is "signed in" or "DM owner". | `channels.ts::canSeeChannel`, `db.ts` schema |
| F-2 | **Agent identity is a static code constant.** `AGENTS` is a module-level array; roles, tools and models are not data. | `agents.ts` |
| F-3 | **Delegation has no completion semantics.** `ask_agent` returns before the target starts. Nothing records "accepted", "done", "failed", "overdue". Only workflows wait (`askAgentAndWait`), and only for their own submissions. | `tools.ts` L82-121, `runtime.ts::askAgentAndWait` |
| F-4 | **Per-agent Pi histories are the only shared "truth"** of what happened. A second agent in the channel does not see the first agent's tool results. | `ask_agent` description; `runtime.ts` |
| F-5 | **Approval separation of duties is absent.** The requester (any human whose message triggered the chain) can approve. No `requested_by`, no expiry, no reminder. | `server.ts` decide route; `db.ts::approvals` |
| F-6 | **Approval attribution is lossy.** `decided_by` stores the display *name*, not the `sub`. Audit `actor` is `user:<name>`. Names are not unique or stable. | `server.ts` L220, L228 |
| F-7 | **Message provenance is free text.** `authorKind` has only three values; an agent acting for a human is indistinguishable from the agent acting alone; there is no `assistedBy`/`delegationId`. | `db.ts::Message` |
| F-8 | **In-memory control state:** delegation rate/dup/depth (`recentAsks`, `recentDelegations`, `depthByConv`), channel-open rate, TreeBuilder queue. Lost on restart; wrong if >1 process. `depthByConv` is keyed by `(channel,agent)`, not by causal chain, so concurrent chains overwrite each other. | `tools.ts`, `runtime.ts` |
| F-9 | **Single-writer lock-in.** Pi Durable allows one process per storage; Temporal worker runs inside the HTTP process; `workspace.sqlite` has no cross-process coordination. | README "Security model", `server.ts` startup |
| F-10 | **Fixture data and real data share paths.** `closeCase` mutates the fake Jira issue; `markCheckoutFixed` is called from the real apply tool; the watcher opens fake tickets. No `source: demo|live` marker on tickets/events. | `activities.ts`, `tools.ts` L424, `watch.ts` |
| F-11 | **No outbox/inbox.** Side effects (post message → publish SSE → submit to agent) happen in-line; a crash between steps can drop an agent dispatch for a human message (message stored, `submitToAgent` never called). | `server.ts` POST messages |
| F-12 | **Idempotency key lookup is a table scan.** `hasMessageForRequest` does `meta LIKE '%"requestId":"…"%'` on every delegation. | `db.ts` |
| F-13 | **SSE had no resume** (corrected severity: the browser already reloads the open channel on every reconnect via `hello` and polls it every 2.5 s, so the practical impact was small; other clients such as Teams/MCP would have had none). *Addressed on branch `feat/bets-first-bite`: change feed + `Last-Event-ID`.* | `hub.ts`, `app.js` L359+ |
| F-14 | **Audit is mutable and partially lossy.** Plain SQLite table, no hash chain; can contain private-chat approval titles (SECURITY.md notes this); actor is a name. | `db.ts::audit` |
| F-15 | **Session roles are frozen for 8 h** and no server-side revocation list. | `auth.ts` |
| F-16 | **Default secret.** `sessionSecret` falls back to `"dev-only-secret-change-me"` with no startup refusal in `oidc` mode. | `config.ts` |
| F-17 | **Memory tree is keyed by Pi conversation id**, so it cannot be scoped to an organization/branch without a mapping layer; a forked world would share nothing and copy nothing. | `optchat.ts` |
| F-18 | **Sandbox runner is plain HTTP inside the cluster;** protection = bearer token + NetworkPolicy. Acceptable for the demo; relevant if sandboxes ever host per-tenant work. | `sandbox.ts::runner` |
| F-19 | **Workflow task queue is a single constant** (`crew-agents`); there is no routing by risk/agent pool. | `config.ts::temporal` |
| F-20 | **Mixed responsibility in `tools.ts`** (511 lines: gate, collab, memory, k8s, repo). New application services must not be added there. | `tools.ts` |

---

## 2. Target architecture [Proposal]

### 2.1 Layers and single owners of truth

Mirrors plan section B2. Each layer has one owner of one kind of state; others hold *projections*.

```
 Browser (Preact)     Teams adapter      MCP adapter       Temporal activities
        │                    │                │                    │
        └──────── all call the same ──────────┴────────────────────┘
                     Application Services  (TypeScript, in-process first)
   ┌──────────────┬────────────────┬──────────────┬───────────────┬──────────────┐
   │ Org Registry │ Conversation   │ Case &       │ Work/Handoff  │ Tool Gateway │
   │              │ Service        │ Knowledge    │ Service       │ (policy,     │
   │              │                │              │               │  approvals)  │
   └──────┬───────┴───────┬────────┴──────┬───────┴───────┬───────┴──────┬───────┘
          │               │               │               │              │
      SQLite → Postgres (domain DB: registry, conversation, case, outbox/inbox, audit)
                          │
        Temporal (process state)        Pi Durable (one agent run)       World Engine (synthetic only)
```

| Layer | Owns | Does **not** own |
|---|---|---|
| Organization Registry | Tenants, realms, entities, orgs, versions, graph, participants, capabilities, delegations (authority source) | Message content, work progress |
| Conversation Service | Conversations, threads, messages, provenance, receipts | Agent prompt memory, task state |
| Case & Knowledge | Case, `CaseContext` facts with source/freshness/uncertainty, decisions (projection of events) | Raw transcripts |
| Work/Handoff Service | `WorkItem`, `Task`, `Handoff` state machines (rows) | The *progress of the process* (Temporal) |
| Temporal | Long-running process position, timers, escalation, retries | Business data truth |
| Pi Durable | Single agent run: LLM transcript, tool-call state | Organization truth, handoff status |
| Tool Gateway | Authorization decision per tool call, risk class, approvals, idempotency keys, audit | Business state |
| World Engine | Synthetic domain state, branches, virtual clock | Anything in `live` scope |
| MCP / Teams adapters | Protocol translation only | Rules, own tables (beyond transport state) |
| UI | Nothing | Everything is a projection |

### 2.2 Rule of one command path

Every write goes `adapter → CommandEnvelope → application service → (transaction: state change + outbox event)`.

- Browser routes, MCP tools, Teams handlers, agent tools and Temporal activities construct a `CommandEnvelope` (plan section C) and call the same service function. No second implementation of "post a message", "create a task" or "decide an approval".
- Authorization happens in the service using the **server-side resolved** `ActorRef` and `WorldScope`, never from client-supplied scope.
- Agent tools become thin wrappers (current `tools.ts` functions are the first candidates to be refactored behind services, one at a time, not in Prompt 00).

### 2.3 Scope: live vs synthetic

`WorldScope = {mode:"live"} | {mode:"synthetic", worldId, branchId}`.

- Resolved on the server from the authenticated principal and the run context (e.g. a Temporal workflow started for branch B carries `branchId` in a server-signed run context). Clients can *ask* to operate in a world; the server decides whether that principal may.
- Tool Gateway has two adapter sets: `live` and `synthetic`. In synthetic scope any live write adapter is not registered (deny-by-absence), and a test asserts this (acceptance criterion for Prompt 06).

### 2.4 Process topology

| Stage | Topology | Rationale |
|---|---|---|
| MVP (prompts 04-05, 01) | **Unchanged**: one process (HTTP + Pi Durable + Temporal worker). New code is *modules with service interfaces*, not new deployables. | Pi Durable allows one writer per storage (F-9). |
| Next (prompt 11) | Split deployables: `api` (HTTP/SSE/MCP), `agent-runtime` (Pi Durable owner), `worker-*` (Temporal workers by task queue). `agent-runtime` exposes `submit(requestId)`, `status`, `cancel` over an internal API. | Lets workers scale without sharing the Pi SQLite file. |
| Later | Sharded agent runtime or replaced runtime (ADR-0002). | Only if throughput demands. |

Multi-replica claims are forbidden in docs until Pi ownership is solved (release gate in plan section E).

### 2.5 Eventing

- **Domain events** (`EventEnvelope`, plan section C) are the integration contract. Written in the *same transaction* as the state change (transactional outbox). A relay publishes to: SSE projections, Temporal signals, and (later) the World Engine.
- **Inbox**: consumers record `(consumer, eventId)` before processing → idempotent handling.
- Delivery is **at-least-once with idempotent consumers**. The documentation will not promise exactly-once to any external system.
- SSE gets monotonically increasing ids (`events.sequence`) and `Last-Event-ID` resume (fixes F-13).

### 2.6 Identity and authority

- `ActorRef = {tenantId, organizationId, participantId}`. A `Participant` has a `kind`: `human | assistant_agent | internal_agent | external_agent | service`.
- Authority comes only from **effective grants** in the registry: `can_approve`, `can_delegate`, `has_access_to` edges are *authoritative*; descriptive edges (`collaborates_with`, `reports_to` …) are informational and never authorize (plan prompt 04 #3).
- Approvals gain `requested_by_participant` and a policy `separation_of_duties` (requester ≠ approver by default; configurable per policy). Fixes F-5/F-6.
- Delegation of a human's authority to an agent is an explicit, expiring, scoped `Delegation` record (prompt 02).

### 2.7 Tenant isolation

- Every table in the new domain DB carries `tenant_id` (and `organization_id` where applicable). All repository functions take `ActorRef` and add the predicate; there is **no** repository function that reads without one.
- With SQLite: enforced in code + tests. With Postgres: additionally Row-Level Security keyed on a session variable (ADR-0001).
- `BusinessRealm` ≠ Keycloak realm. Sharing across entities needs `FederationAgreement` + `ShareGrant` rows; absence means no access.

### 2.8 Where today's code maps

| Today | Becomes |
|---|---|
| `SEED_CHANNELS`, `AGENTS` constants | Seed data of the **default/demo organization** (prompt 04 migration); constants remain as the seed source. |
| `channels.agents` JSON | `Membership` rows. |
| `store.addMessage` | Conversation Service `postMessage` (keeps the table; adds provenance columns). |
| `ask_agent` | `Work/Handoff.request` + dispatch via outbox; keeps the same tool name and prompt text. |
| `gate()` | Tool Gateway approval (`requestApproval` with requester, expiry, policy id). |
| In-memory limits | Tables with TTL (`rate_counters`) or Temporal-side limits. |
| `incidentWorkflow` | One of several workflow types on role-specific task queues. |
| `fakes.ts` | `demo` adapter set, clearly tagged `source: "demo"` on every record (fixes F-10). |

---

## 3. Compatibility commitments (apply to every prompt)

1. Existing channels, DMs, `@mention`, approvals, memory, SSE and OIDC keep working; new behaviour is behind feature flags (`FEATURE_ORG_MODEL`, `FEATURE_WORKITEMS`, …) defaulting off until its acceptance tests pass.
2. Schema changes are forward-only migrations with a version table (the current code uses ad-hoc `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... try/catch`; prompt 04 introduces the migration runner first).
3. The `npm test` suite stays green on every commit; new suites are added, not substituted.
4. No new external side effects without an explicit scope boundary.

## 4. Non-goals of Prompt 00

No production code changed. No library API was exercised beyond reading the installed packages' use in `src/`; **[Assumption]** items about Pi Durable (multi-process behaviour, `status`/`cancel` exposure), Temporal task-queue routing and MCP SDK versions must be verified at the start of prompts 11 and 03 respectively.
