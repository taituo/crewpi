# Crew World: progress log (append only, newest last)

## 2026-10-08 design written
- Context: endgame idea E3 from the owner ("a game-like world to follow the platform; synthetic problems and tools; stateful synthetic surroundings on Restate or DBOS; hard-coded statistics and real graphs; godmode").
- Decisions D1-D7 in `README.md`. Main deviations from the idea as first stated: own engine first, Restate/DBOS as a later experiment (M8) because their journals are not domain time travel and their APIs are unchecked here; world data in a separate SQLite file per world, not in the live `events` table.
- Reusable today: org registry (04), events/handoffs/CaseContext (05), `fakes.ts` fixtures, `render_ui` chart catalog, OptChat memory, CLI, `events.scope/world_id/branch_id` columns. Missing: virtual time on events, snapshots, scheduler, budgets, recorded responses.
- Next: M0. Nothing built yet.

## 2026-10-08 time skipping measured (owner: "timeskipping like Temporal!")
- Experiment in a scratch copy, then as a real test on branch `feat/timeskip-tests`: `@temporalio/testing` 1.24.0 `createTimeSkipping()`. Results: server up in 0.2-0.7 s; 1 actor x 365 daily timers = 365 wake-ups in 1.56 s wall; handoff watchdog (unchanged production workflow) escalated at virtual +5.0 min in 106 ms and at +60.0 min in 45 ms; a healthy handoff never escalated while a virtual month passed.
- Decision D2b added (time semantics). Temporal time skipping added as the first candidate of M8. Own engine stays first (fork/snapshot/hash need state we own).
- Side finding while adding the tests: the recurring CLI test failure (about 1 full-suite run in 3) was a real bug, nondeterministic order of rows written in the same millisecond. Fixed with rowid tie-breakers; 4 consecutive full runs green (103 tests).
- Unverified, listed in README: history size limits, no fork/snapshot, activities holding the clock, scale.
- Next: M0 (still nothing built).

## 2026-10-08 M0 done (branch `feat/world-m0`)
Built test first. `npm run world:check` = 23 tests, all green; whole suite 126/126; `tsc` 0 errors.

| M0 acceptance | Result |
|---|---|
| (a) same seed -> same hash after 30 virtual days, twice; other seed differs | pass |
| (b) snapshot/resume from the file at day 10 == uninterrupted run to day 30 | pass (hash and state equal) |
| (b2) crash in the middle of an open batch, reopen, continue | pass: arrives at exactly the uninterrupted hash |
| (c) 365 virtual days of the ticker world | **~0.9 s wall, 58 849 steps / events** (target was < 60 s) |
| (d) events have virtual time and a gap-free per-branch sequence; a snapshot per virtual day | pass |
| (e) one summary per slice reaches the main `events` log as `scope=synthetic`; thousands of raw events do not | pass (also from the CLI) |
| (f) time semantics (D2b): a +5 min timer fires at exactly +5 min; a quiet year costs no real time; a day-400 timer does not fire in a 365-day run and fires at day 400 on continuing | pass |
| CLI `crew world new/run/status/list`, slices, resume in a new process, same history however sliced | pass (`test/world-cli.test.ts`) |

Design as built: one SQLite file per world (`DATA_DIR/worlds/<name>.sqlite`); state is the fold of events over the latest daily snapshot; steps are committed in batches of 500 (events, schedule, per-actor random state, rolling hash together), a failed batch rolls back and memory is rebuilt from the file; per-actor random streams via `rng.fork(actorId)`; the history hash chains sha256 over every event. Honest limits: one branch (`main`) only; no budgets/Tier 1-2 actors yet (M3); the ticker world is deliberately trivial; `run({days})` counts from the clock, which sits mid-day after a crash, so resuming code should use `untilDay`.

### Delegation experiment: opencode (Muse Spark 1.3, free tier) as a worker
Two briefs (`.TASK.md` in separate git worktrees, fresh opencode sessions in herdr panes, Node 22 on PATH), run in parallel while I built M0.
- **world-rng**: `SeededRng` (sfc32 + cyrb hash), 10 tests, golden values, 1M draws in ~13-18 ms. Took 2 min 30 s. Reviewed line by line: correct and well commented. **Review found two things the brief did not cover:** `fork()` nested the parent seed into the child's, doubling the escaping per level, so a fork of a fork ... overflowed a JS string at about depth 25 (fixed: fixed-size 128-bit token; 2 tests added). `poisson()` above mean 30 uses a rounded normal approximation: fine for Tier 0, noted as a known limit.
- **qa-dm-privacy**: `test/dm-privacy.test.ts`, 9 checks with positive controls, live SSE streams for four users, memory, approvals, audit. Took 3 min 28 s. It **found a real leak** (the audit trail showed titles of private-chat approvals to approvers who cannot see the chat), kept the assertion as a `todo`, did not touch product code and said so. Fixed here on `fix/audit-private-titles` (entries about channels the reader cannot see are redacted); the test is now a plain passing test; SECURITY.md updated.
- Process notes: both agents asked for a directory permission once (I answered by reading what it asked for first), neither touched files outside its brief, both committed on their own branch. Briefs that say exactly which files may change, and that product leaks are findings not fixes, worked. What the worker could not do: judge its own result (it said PASS where the evidence was thin in the earlier QA run); every result still needed a reviewer.
- Next: M1 (IT-ops domain and problem catalog).

## 2026-10-08 M1 done (branch `feat/world-m1`, on top of M0)
Test first (8 domain tests + 1 CLI test). Whole suite 135/135, `tsc` 0 errors, `npm run world:check` 32/32.

Design: `src/world/itops/` = `catalog.ts` (services and dependencies, 7 problem kinds, `rightFix` and `judge`: the physics of fixing), `state.ts` (**the open incidents are the single source of truth; a service's condition is derived by `effective()`**, so the world cannot lie and overlapping faults never undo each other), `symptoms.ts` (what a responder sees: metrics and log lines, never the cause), `spec.ts` (three Tier-0 policies: `itops:oracle`, `itops:naive`, `itops:none`; actors chaos, escalator, responder). Specs are selectable from the CLI: `crew world new ops --spec itops:oracle`.

| M1 acceptance | Result |
|---|---|
| a Tier-0 oracle resolves every problem type | 273 of 273 incidents in a year, all 7 kinds, MTTR 31 min, 0 harmful fixes |
| a naive fixer makes >= 2 types worse | 283 harmful fixes in a year; bad restarts hit capacity, false alarms, dependency outages |
| same seed -> same incident list | yes, and **the same list for every responder policy** (the responder cannot change the weather; asserted) |
| 90 days give a plausible, non-degenerate mix | property test over 10 seeds: 35-100 incidents, >= 5 kinds, none above 40%, clustered in business hours |
| nobody responds | problems escalate to the top severity by themselves |

Numbers (seed `ops-1`): oracle 365 d: 273 incidents (noisy_alert 69, bad_config 49, capacity 49, bad_deploy 35, memory_leak 27, dependency_down 27, expired_cert 17), 526 ms wall. Naive 365 d: same 273 incidents, 111 resolved, 162 open, impact about 9000x the oracle's because unresolved problems keep costing for the whole year (severity-weighted minutes, so this number is a stress indicator, not a forecast). No responder, 90 d: 59 incidents, all open.

**Mutation check of the tests** (break the code on purpose; the tests must notice): 6 of 6 mutations are caught (a harmless restart on a saturated service; arrivals depending on the policy; a fault missing from the effective state; false alarms that are harmless to act on; no escalation; flat arrival rate). The first version of the "arrivals depend on state" mutation was too weak (the oracle resolves faults so fast that nothing was ever open at the next arrival) and was replaced by one that makes the random stream depend on the policy.

Honest limits: causes are simple (one fault per incident, no cascading second incident from a wrong fix, only a severity bump); services have no load model beyond the cause; the fixer is a rule, not an agent (that is M3); time of day matters only for arrivals; nothing renders yet (M4). Customer impact counts severity at the end of an incident.

Next: M2 (synthetic tools with the real tools' names and shapes, fault injection, the no-live-write tripwire).

## 2026-10-08 M2 done (branch `feat/world-m2`, on top of M1)
Test first (10 tests + 11 property tests from a worker). Whole suite 156/156, `tsc` 0 errors.

- **Tools** (`src/world/itops/tools.ts`): `k8s_pods`, `k8s_events`, `k8s_logs`, `k8s_configmap`, `k8s_deployments`, `jira_search`, `jira_get`, `grafana_query` carry the real tools' names, parameter names (asserted against `ALL_EXTENSIONS`) and output formats, and answer from the world's state. Acts that exist only here: `k8s_restart`, `k8s_scale`, `k8s_rollback`, `k8s_set_config`, `cert_rotate`, `db_failover`, `alert_dismiss`. An act is an event of the actor `hands`, attributed to `tool:<agent>`, with the consequences `judge()` gives; the tool's reply never says whether it helped (the agent has to look).
- **Engine additions**: `now()`, `run({untilMs})`, `execute()` (a command at the current virtual moment, returns its events), `fault_log` (private; not in the history hash), a persisted tool-call counter. **Godmode seed**: the operator can `inject` an incident of a chosen kind on a chosen service.
- **Fault injection**: stale (the world as of N hours ago), wrong (calm and misleading), missing (503), slow (a virtual delay), and a prompt-injection fixture appended to the text. Probabilities are drawn from a stream derived from (seed, call number), so the same world and the same call sequence give the same faults. The agent is never told; the private log is.
- **Tripwire / deny by absence**: a test lists the synthetic names and asserts that no live write tool exists in them (`k8s_apply_from_repo`, `repo_write`, `sbx_*`, `request_approval`, `open_channel`, `ask_agent`, `jira_comment`), that calling one is an error, and walks the import graph of everything under `src/world/` to prove it cannot import `kube`, `repo`, `sandbox`, `tools`, `server`, `runtime`, `temporal*`, `fakes`, `hub`, `channels`, `auth`... (mutation: adding a live tool or such an import is caught).
- **Golden file** `test/golden/itops-tools.txt`: the exact text of every read tool for three fixed worlds. Reviewed by hand: a responder can find the cause from the symptoms (db pods not ready, logs point to `db:5432`), a false alarm looks healthy, and the hidden cause never appears. It caught one of my own mistakes (age shown as `72h` instead of `3d`; the real tool switches to days after 48 h).
- **Mutation check of the tests**: 9 of 9 caught (a live tool added, a forbidden import, a read that writes history, a fault missing from the private log, a fault leaking into the answer, staleness ignored, non-reproducible fault draws, namespace not checked, an extra parameter).
- **A worker's tests, reviewed by mutation**: `test/world-itops-props.test.ts` (opencode, 11 invariants over 12 seeds x 3 policies, found nothing). 7 of 8 mutations of M1 code were caught by it; the 8th (a responder acting after the incident was resolved) is only reachable when a tool resolves an incident before the automatic responder, so I added that race as a test in `world-tools.test.ts`.
- Honest limits: faults apply to read tools only; "slow" is reported as `delayMs` and does not yet advance the world's clock (that is M3, where agents have time); acts are not gated by simulated approvals yet (M3); the synthetic Jira/Grafana are small (no comments, one metric family per service).
- Next: M3 (agents in the world: Tier 1 policies and Tier 2 agents on the real Pi runtime in synthetic scope, handoffs and CaseContext as world events, budgets, recorded mode).

### Worker result: engine mutation testing (opencode, 6 min 43 s) - merged after verification
Brief: apply 16 given mutations plus its own to `engine.ts`/`rng.ts`, report survivors, write tests that kill them. Result: 19 mutations, 15 killed by the existing tests, 2 performance-only (batch size, a no-op ordering), **4 real survivors** that the existing M0 tests did not catch: a wake-up due exactly at the end of a slice being skipped, a failed batch not reloading memory (the object kept lying until reopened), virtual time missing from the history hash, scheduling in the past allowed; plus `chance(0)` and `pick` edge cases in the RNG. It wrote 7 tests (`test/world-engine-extra.test.ts`); I re-applied 5 of the mutations myself and every one is now killed. One mutation (ordering by `due` only) it proved unkillable from outside because the SQLite index already yields `(due, id)` order, and kept the FIFO contract as a regression pin: good judgement.
Process note: the worker tried to write helper scripts under `/tmp` (outside its worktree) and asked for permission; I refused and told it to use `./.scratch/`, which it did. It also set repo-local `user.name`/`user.email` in the shared git config to commit; I removed them again (commits are made with one-shot `-c` flags).
