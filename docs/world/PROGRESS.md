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
