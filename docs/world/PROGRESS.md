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
