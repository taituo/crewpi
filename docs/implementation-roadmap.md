# Implementation roadmap

Status: **proposal** (Prompt 00). One prompt per change set. Order follows `goal` section A, adjusted where the audit found a hard dependency.

## 1. Dependency graph

```
00 audit/ADR
 └─► P0a  migration runner + tenant/org columns (new; prerequisite for 04, see §3)
      └─► 04 Organization Registry
           ├─► 13 Business Realm / federation
           └─► 05 Events, outbox, handoffs, CaseContext
                ├─► 11 Delegation at scale (needs Temporal queues, agent-runtime API)
                │    └─► 14 Oversight & exception centre
                ├─► 01 Natural chat ──► 02 Provenance / external agents ──► 03 MCP
                │                                                     └─► 12 Teams adapter
                ├─► 09 Rhythm / re-entry ──► 10 Meetings / delegated authority
                └─► 06 Synthetic world ──► 07 Snapshots/forks ──► 08 Stress ──► 15 Noise
```

Hard edges: 05 before 01/11/09/10; 04 before everything; 02 before 03 (`conversation.post` needs provenance); 06 before 07 before 08 before 15; 03's `simulation_*` tools only after 06-07.

## 2. Stages

| Stage | Prompts | Outcome | Gate to leave the stage |
|---|---|---|---|
| S0 | 00 | Docs + ADRs reviewed | ADR-0001 to ADR-0007 accepted or amended |
| S1 Foundations | P0a, 04, 05 | Tenant-scoped data, org graph, durable handoffs | Isolation tests; crash/duplicate tests green; demo unchanged |
| S2 Operational MVP | 11, 14, 01 | Work items delegated by policy, exceptions surfaced, chat without `@` | Vertical slice (§4) works end to end |
| S3 Surfaces | 02, 03, 12 | Provenance, MCP, Teams mock | Negative ACL tests; no approval bypass |
| S4 Rhythm | 09, 10, 13 | Re-entry, async meetings, realms | Realm leakage tests |
| S5 Twin (separate track) | 06, 07, 08, 15 | World engine, forks, stress, noise | Deterministic replay hash; no live side effects test |

S5 can run on its own branch/service once the shared contracts (`EventEnvelope`, `WorldScope`, ids) are frozen at the end of S1. It must not delay S2.

## 3. Deviations from the plan's order (with reason)

1. **New P0a "foundations" step before Prompt 04.** The audit found no migration runner (`CREATE TABLE IF NOT EXISTS` + `ALTER … try/catch`), no `tenant_id` anywhere (F-1), and approvals keyed by display name (F-6). Prompt 04 says "all structures tenant-scoped", which is impossible without the runner and the default-tenant backfill. P0a is small (runner, baseline migration, default tenant/org, `decided_by_sub`) and ships behind no flag because it is additive.
2. **Provenance columns (part of 02) are added in P0a as nullable columns**, populated by the existing code paths as `human`/`internal_agent`/`system`. Prompt 02 then adds drafts/delegations/external agents on top. This avoids a second migration of the hottest table.
3. **Prompt 09/10 MVP may precede 06** as the plan allows; recommended because they deliver value on the live organization.

## 4. First vertical slice (plan section F)

One `Entity` (the demo org) + one mock Teams representative + **200 synthetic ordinary WorkItems** + 2 exceptions + one natural conversation producing a summary. Slice needs: P0a, 04 (minimal), 05, 11, 14 (minimal), 01 (minimal), 12 (mock only). Everything else deferred.

## 5. Per-prompt change sheet

For each: files that will change, risks (IDs from `risk-register.md`), migrations, acceptance, tests. "New" = new file/module.

### P0a Foundations - DONE on branch `feat/p0a-foundations`
**Result:** `src/migrate.ts` (runner), `src/migrations.ts` (1 baseline, 2 tenant/org/provenance), approvals store `decided_by_sub`, messages get `actor_id/actor_type/source`, audit gets `actor_id`, server refuses the default `SESSION_SECRET` in OIDC mode, `npm test` preflights Node >= 22.19. 42/42 tests pass (35 existing + 7 new in `test/migrate.test.ts`); verified against a database written by the audited commit `873a01a`.
**Also added in P0a:** default business realm and entity (migration 3), and a lease lock for the Pi storage (`src/lock.ts`; 4 tests).
**Not done / deferred:** `requested_by_sub` is stored but not yet filled (the requesting human is not tracked until Prompt 05); separation of duties is therefore not enforced yet; no hash-chained audit; other modules (`channels`, `memory`, `optchat`, `sandbox`, `settings`) still create their own tables with `IF NOT EXISTS` and move into migrations as each is touched.
- **Files:** new `src/migrate.ts`, `migrations/0001_baseline.sql`, `0002_tenant_org.sql`; edit `src/db.ts` (use runner), `src/server.ts` (decide route stores `sub`), `src/auth.ts` (refuse default `SESSION_SECRET` when `AUTH_MODE=oidc`).
- **Migrations:** baseline; default tenant/org; `approvals.requested_by_sub`, `decided_by_sub`; `messages` provenance columns (nullable); `audit.actor_id`.
- **Risks:** R-02, R-06, R-12, R-13.
- **Acceptance:** fresh DB and existing demo DB both reach the same schema version; existing 35 tests still pass; approval stores `sub`; startup fails fast on default secret in OIDC mode.
- **Tests:** migration up from a DB created by the audited commit (fixture copy); idempotent re-run.

### 04 Organization Registry & Builder - core DONE on branch `feat/p04-org-registry`
**Result:** see `docs/org-registry.md`. 57/57 tests; routes verified against a running dev server. **Open:** runtime does not consume the registry yet; no graph UI; rule-based planner only.
- **Files:** new `src/org/*` (registry service, graph validation, authority resolver), `src/agents.ts` (seed source only), `src/channels.ts` (membership via registry), `public/` minimal builder view later.
- **Migrations:** organizations, versions, nodes, edges, participants, memberships, policies.
- **Risks:** R-01, R-07, R-14.
- **Acceptance:** three test orgs (hierarchy, network, agents-only) validated by one code path; foreign-org read/write rejected; descriptive edge cannot grant write.
- **Tests:** unit (graph validators), ACL (cross-org), migration.

### 05 Events, outbox, handoffs, CaseContext
- **Files:** new `src/events/*` (log, outbox relay, inbox), `src/work/handoff.ts`, `src/case/context.ts`; edit `tools.ts::ask_agent` (delegates to handoff service, same tool contract), `activities.ts`, `server.ts` (message POST uses outbox: fixes F-11), `hub.ts` (event ids, resume: F-13), Temporal workflow `handoff.js`.
- **Risks:** R-03, R-04, R-08, R-09.
- **Acceptance:** recipient not answering → escalation at `dueAt`; duplicate event → one execution; crash between message insert and dispatch → dispatch still happens.
- **Tests:** kill-worker (extend `workflow.test.ts` pattern), duplicate delivery, stale-fact detection, DM exclusion from projections.

### 11 Large-scale delegation
- **Files:** new `src/policy/*` (classifier, router, budgets), `src/agent-runtime/` API (`submit/status/cancel`), worker entrypoints per task queue; `config.ts` (queues).
- **Prereq:** verify Pi Durable ownership constraints (R-05); ADR-0002.
- **Acceptance:** 10 000 synthetic items at configurable concurrency; queue length, throughput and human-minutes reported; no item processed twice (dedupeKey).
- **Tests:** load test (documented as synthetic); backpressure; policy-version recorded.

### 14 Oversight & exception centre
- **Files:** new `src/oversight/*`; UI panel.
- **Acceptance:** exceptions deduplicated and ranked; each shows why it was raised; metrics (throughput, human attention cost, error rate).
- **Tests:** exception grouping; no leak across orgs.

### 01 Natural chat
- **Files:** `src/controller/*` (routing proposal), `public/app.js` (thread view, task status), `server.ts` (threads).
- **Acceptance:** "Selvittäkää miksi toimitukset viivästyvät" without `@` yields a proposed/created case, a named owner, open tasks, sources; routing validated against registry capabilities, not a model-invented name.
- **Tests:** API, ACL, SSE reconnect with resume, reload.

### 02 Provenance / assisted drafts / external agents
- **Files:** `src/identity/*`, `server.ts`, schema for drafts, delegations.
- **Risks:** R-10.
- **Tests:** impersonation, expired delegation, duplicate publish, DM leak.

### 03 MCP
- **Prereq:** read the current MCP spec and TS SDK before coding (assumption list in the prompt).
- **Files:** new `src/mcp/*` (adapter over services), docs for client config.
- **Tests:** cross-org read denied, write without grant denied, approval bypass impossible, wrong-person identity.

### 12 Teams/channel representative
- **Files:** `src/adapters/teams/*` (mock first), representative binding.
- **Acceptance:** mock represents one entity; reports only share-granted results; shows agent vs human identity.

### 09 / 10 Rhythm, re-entry, meetings
- Async text meetings first (plan F.4). Decisions are `Decision` events with explicit authority refs.

### 13 Business Realm
- **Tests:** leakage across entities for data, memory, messages, reports.

### 06 / 07 / 08 / 15 Synthetic track
- Separate module/service. Contracts frozen from S1. Determinism, fork isolation and no-live-write tests are the release gate. Noise is only written into `BeliefState`/observations (plan B6).

## 6. Cross-cutting definition of done (every prompt)

1. `npm test` green on Node ≥ 22.19 (state Node version used).
2. New migration has an upgrade test from the previous schema.
3. Docs updated (this folder + README status).
4. Feature flag documented; default off until acceptance passes.
5. Report lists what was run and what was *not* run.

## 7. Environment note

The development machine has Node 18. Tests need Node ≥ 22.19 (native TypeScript execution, `node:sqlite`). Add an `.nvmrc`/`engines` check or a preflight in `npm test` in P0a so the failure is explicit instead of `ERR_UNKNOWN_FILE_EXTENSION`.

## 8. Acceptance sketches for the later prompts (so nothing stays implicit)

| Prompt | Acceptance in one paragraph | Must-have negative tests |
|---|---|---|
| 09 Rhythm / re-entry | Simulate a CEO away for a week (virtual clock): agents act within granted authority, hit two strategic uncertainties; on return the CEO gets a sourced briefing and two questions; answers are stored as guidance/proposals, never approvals; quiet hours and DM limits hold. | timezone/quiet-hour edge, ACL on briefing sources, restart mid-interview |
| 10 Meetings | CEO and CTO human, other executives agents; agents prepare; CEO comments as advisor (no decision change); CEO later makes a separately authorized override on one project, scoped and audited; same meeting runs in a forked synthetic world with a different decision. | agent impersonation, external MCP agent without material access, "presence is not approval" |
| 12 Teams representative | One entity's representative answers a status query and posts a proactive exception digest only when installation and authorization allow; another entity cannot read it; same correlationId visible in internal chat. Mock adapter unless live test tenant exists (say so). | cross-entity read, unauthorized proactive message, card action without policy check |
| 13 Realm / federation | Sister entities A and B with different customer data: A may request one permitted service from B, cannot read B's secrets; revoking the grant mid-work blocks later reads and publications; search, memory summaries, reports, MCP calls, audit and branches all respect it. Single-org install migrates into default tenant/realm/entity without breaking DM privacy. | revoke mid-work, small-group aggregate leak, memory summary leak |
| 06 World | order -> sale -> manufacturing/delivery -> finance changes stock, cash, obligations, tasks; same start + seed + recorded responses + events give an identical state hash; no live write API callable during simulation. | live-adapter tripwire |
| 07 Time travel | 20 events, snapshot at 10, continue to 20, fork at 10, change decision, continue; both histories intact and different; recorded replay of the original gives the same hash; no side effects either branch. | reducer-version mismatch refused, branch isolation property tests |
| 08 Simulation | Sales changes a delivery date, production is not told; simulator finds the missing must_inform/handoff route and shows the causal chain; fixing the rule makes the same deterministic test pass. | duplicate, late, missing approval, wrong org, branch isolation |
| 15 Noise | false stock 120 vs truth 12 seen only by chosen agents while WorldState keeps 12; spread traceable; noise=0 equals control; 50-seed deterministic test; A/B (single-source vs two-source verification) comparison; sweep 0/1/5/10/20 % labelled experimental. | forged identity and prompt-injection fixture cannot bypass approval or tool policy |
