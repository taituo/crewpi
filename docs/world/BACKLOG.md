# Crew World: backlog

**Done outside the milestones:** time-skipping tests of the live handoff watchdog (`test/handoff-timers.test.ts`, 5 tests; 2026-10-08).

Each milestone: **goal**, **acceptance** (a command that must pass; numbers are targets until measured), **depends on**. Tick only with evidence in `PROGRESS.md`.

- [x] **M0 Skeleton and contracts.** *(done 2026-10-08, branch `feat/world-m0`; evidence in PROGRESS.md)* `src/world/`: `VirtualClock`, `SeededRng` (state serializable), persistent `Scheduler` (priority queue), `Reducer` interface, `WorldPort`, per-world SQLite file with `world_events`, `snapshots`, `rollups`; `crew world new|run|status`; `npm run world:check`.
  *Acceptance:* (a) same seed -> identical state hash after 30 virtual days, twice; (b) snapshot at day 10, resume to day 30 == uninterrupted run; (c) 365 virtual days of a trivial Tier-0 world in < 60 s wall; (d) events carry virtual time and a per-branch sequence; (e) summary events reach the main `events` log with `scope=synthetic`; (f) time semantics as in D2b: a timer set for +5 min fires at exactly +5 min of virtual time, and a run with nothing runnable advances without sleeping (property test).
- [x] **M1 IT-ops domain and problem catalog.** *(done 2026-10-08, branch `feat/world-m1`; evidence in PROGRESS.md)* Services, dependencies, load curve; 7 problem types with causes, symptoms, right and wrong fixes; seeded arrival process.
  *Acceptance:* a Tier-0 "oracle" fixer resolves every problem type; a "naive" fixer makes at least 2 types worse (proves wrong fixes have consequences); same seed -> same incident list; 90 days produce a plausible, non-degenerate mix (property test on the distribution).
- [ ] **M2 Synthetic tools and fault injection.** Adapters with the real tools' names/shapes answering from world state; injected faults (stale, wrong, slow, missing, prompt-injection fixture).
  *Acceptance:* tool outputs equal a golden file for a fixed world; **tripwire**: in synthetic scope every live tool (k8s, repo, sandbox, MCP) is absent or throws, tested by calling each; injected fault is visible in the tool answer and logged privately, never to the agent.
- [ ] **M3 Agents in the world.** Tier 1 policies and Tier 2 agents (the existing Pi runtime, synthetic scope, own conversations per branch); handoffs, CaseContext, approvals as world events; budgets; recorded mode.
  *Acceptance:* 30-day run with 3 ops + 2 dev + 1 reviewer instances: every incident ends resolved, escalated or open with an owner; budget exhaustion degrades to Tier 1 and is counted; **recorded replay** of the same run makes 0 model calls and reproduces the state hash.
- [ ] **M4 Statistics, rollups and the World view.** Metrics file (D6), rollups, `/api/worlds/:id/stats`, view with charts and the game-like map.
  *Acceptance:* each metric has a test against a hand-computed tiny world; a 365-day graph request reads < 1000 rows and returns in < 200 ms; the view renders from events only (delete the view state, nothing is lost).
- [ ] **M5 Godmode and forks.** Pause/step/speed, inject, kill/spawn, policy and budget changes, fork at snapshot, compare.
  *Acceptance:* fork at day 10, change one decision, run both to day 30: histories share days 0-10 byte for byte, differ afterwards, original unchanged; godmode acts appear as `actor: operator` events.
- [ ] **M6 Long run and soak.** 365 virtual days, 10 agent instances, budgets, slices with checkpoints, cost report.
  *Acceptance:* completes in slices with a kill -9 in between and still equals the uninterrupted hash; spend within budget; report lists degraded days; memory trees of agents stay within their byte budget.
- [ ] **M7 Chaos and the org dry-run.** Noise profiles (plan Prompt 15), A/B scorecards; propose an org change, replay the last N days through it, show the diff.
  *Acceptance:* noise = 0 equals the control hash; a deliberately broken `must_inform` route is found and the fix removes the finding in the same deterministic test.
- [ ] **M8 Engine experiments (optional).** Temporal's time-skipping environment (cheapest to try: already pinned, baseline measured, see README), and/or Restate and/or DBOS behind `WorldPort`; compare determinism, throughput, operability. **First verify their current APIs.**
  *Acceptance:* the M0 acceptance suite passes on the alternative adapter, or the report says exactly why not.
