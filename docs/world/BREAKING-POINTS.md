# Crew World: breaking points (measured 2026-10-08, branch `task/breaker`)

Measure, do not fix. Product code (`src/`) untouched. Scripts live in `./.scratch/` (git-ignored,
uncommitted): `exp1_agents.ts`, `exp2_days.ts`, `exp3_storm.ts`, `exp3b_stormscale.ts`, `exp4_tools.ts`,
`exp5_determinism.ts`, `exp6_faults.ts`, `exp7_crash.ts`, run with `node .scratch/<name>.ts`.

Setup for every experiment: `itopsSpec("none") + withAgents(spec, ids, 3600000) + runAgents(world, {agents, untilDay})`
with the `rulesOps` brain (pattern from `test/world-agents.test.ts`), seed `breaker-1` unless noted.
Machine: 8 CPUs, 15 GB RAM, Node v22.23.3. No experiment hit the 5-minute stop rule (slowest single run: 23 s).

## 1. Agents scale (30 virtual days, hourly shifts)

| agents | wallMs | shifts | tool calls | events | file | RSS after | total / resolved / open |
|---|---|---|---|---|---|---|---|
| 1 | 443 | 720 | 792 | 828 | 0.3 MB | 86 MB | 25 / 25 / 0 |
| 2 | 671 | 1439 | 1511 | 1547 | 0.4 MB | 87 MB | 25 / 25 / 0 |
| 4 | 1134 | 2877 | 2949 | 2985 | 0.5 MB | 90 MB | 25 / 25 / 0 |
| 8 | 2272 | 5753 | 5825 | 5861 | 0.8 MB | 91 MB | 25 / 25 / 0 |
| 16 | 4232 | 11505 | 11577 | 11613 | 1.4 MB | 101 MB | 25 / 25 / 0 |
| 32 | 8468 | 23009 | 23081 | 23117 | 2.5 MB | 113 MB | 25 / 25 / 0 |

Knee: none up to 32 agents. Wall time is linear in shifts (~0.37 ms/shift); file size is linear in events
(`agent.shift` events dominate: 23 of every 24 hourly events at 32 agents). RSS figures are cumulative in
one process (worlds run sequentially), so read them as "stays under ~115 MB", not per-row peaks.
**Outcome does not change with agent count**: 25/25/0 identical for 1..32 agents (extra agents re-read an
already-fixed world; the dedup path noted in PROGRESS M3b holds).

## 2. Days scale (1 agent, hourly shifts)

| days | wallMs | ms/day | shifts | calls | events | file | reopen | full scan | snapshots |
|---|---|---|---|---|---|---|---|---|---|
| 30 | 356 | 11.9 | 720 | 792 | 828 | 0.3 MB | 1 ms | 2 ms | 30 |
| 90 | 1097 | 12.2 | 2160 | 2365 | 2478 | 1.6 MB | 2 ms | 10 ms | 90 |
| 365 | 5742 | 15.7 | 8760 | 9493 | 9978 | 19 MB | 3 ms | 25 ms | 365 |
| 1000 | 23432 | 23.4 | 24000 | 25808 | 27054 | 129 MB | 5 ms | 79 ms | 1000 |

All incidents resolved in every run (25, 77, 302, 761). Knee: **wall time per virtual day doubles between
day 30 and day 1000** (11.9 -> 23.4 ms/day; marginal cost over days 365-1000 is 27.9 ms/day). Two compounding
causes, both measured: (a) **snapshots are quadratic**: each daily snapshot stores the full state including
every resolved incident ever (nothing is pruned). Snapshot payload totals 0.14 / 1.1 / 17 / 124 MB while raw
events total 0.05 / 0.14 / 0.56 / 1.5 MB; at 1000 days snapshots are 96% of the 129 MB file and the largest
single snapshot is 236 KB. (b) per-shift work scans total-incidents-ever: `jira_search` maps all incidents
including resolved ones, so each of the 24 000 shifts pays O(761). Reopen stays cheap (1-5 ms: reload replays
only events after the latest snapshot); a full `events()` scan is linear (79 ms for 27 k events).

## 3. Incident storm (200 injected at once, 1 agent, 5 days)

200 injected at t+10 min (+ 6 natural arrivals = 206 total): **all 206 resolved, 201 of them on day 0, in the
very first hourly shift** (81 ms wall, 239 tool calls). Per-shift wall over the 120 shifts: min 0, p50 0,
p90 1, p95 1, max 81, mean 1.1 ms. No explosion at 200, so the storm size was scaled (first-shift wall):

| storm | first-shift wall | tool calls in it | resolved after 2 shifts | ms per ticket |
|---|---|---|---|---|
| 200 | 80 ms | 239 | 200/201 | 0.40 |
| 1000 | 484 ms | 1153 | 1000/1001 | 0.48 |
| 2000 | 1468 ms | 2296 | 2000/2001 | 0.73 |
| 5000 | 9153 ms | 5725 | 5000/5001 | 1.83 |

Knee: **~2000-5000 simultaneously open tickets**, where per-ticket cost goes superlinear (0.40 -> 1.83 ms).
Mechanism: each ticket costs `k8s_logs`, which scans all open incidents (`openOn`), plus `jira_search` mapping
all incidents, plus one `world.execute` transaction per fix. Fine for the rules brain (9 s for 5000 tickets in
one shift); a Tier-2 model brain would hit turn/cost caps long before that — storms need batched triage, not
one-ticket-per-turn.

## 4. Tool call volume (10 000 read calls per tool; worlds with 4 / 52 / 501 open incidents)

Per-call microseconds:

| tool | 4 open | 52 open | 501 open | growth |
|---|---|---|---|---|
| `grafana_query` | 107 | 386 | 2933 | 27x, slowest |
| `k8s_deployments` | 148 | 318 | 1944 | 13x |
| `k8s_events` | 141 | 326 | 1828 | 13x |
| `k8s_pods` | 153 | 269 | 1429 | 9x |
| `jira_search` | 90 | 133 | 548 | 6x |
| `k8s_logs` (1 pod) | 108 | 133 | 403 | 4x |
| `k8s_configmap` | 78 | 87 | 167 | 2x |
| `jira_get` (one ticket) | 80 | 75 | 79 | flat, O(1) |

Knee: **`grafana_query` is the tool to watch**: it copies the full state (`view()`) per sampled time point
(~13 points per call), so it degrades superlinearly and at 2.9 ms/call would dominate a chatty agent's shift
budget at 500+ open incidents. `jira_get` is the only true O(1) tool. (Measurement note: ticket keys start at
`OPS-101` (`inc-1`); the first `jira_get` probe used nonexistent `OPS-100` and timed the error path, so it was
re-run on `OPS-101` — success path, flat ~80 us. Key numbering is consistent between `jira_search`/`jira_get`,
not a bug.)

## 5. Determinism under stress (4 agents x 60 days, seed `breaker-det`)

Two uninterrupted runs: identical hash `577c24d5…`, 5757 shifts, 5927 events. Then a third run split into 6
legs at 5 seeded-random cumulative shift counts (14, 623, 1572, 4074, 5507) with `close()`/reopen between legs:
final hash `577c24d5…`, 5927 events — **bit-identical to the uninterrupted run**. No finding: pause/resume and
same-seed determinism hold under multi-agent stress. (API note: `maxShifts` is per `runAgents` invocation, not
a global cap — the legs rely on that.)

## 6. Faults at scale (p=0.5 `missing` on all tools, 4 agents, 60 days)

Completes, no exception: 5757 shifts, 5956 calls, 0 shift errors, 2958 faults in the private log, wall 2.5 s.
**40/40 incidents resolved, 0 open** — the same 40 arrivals as the no-fault run (fault draws come from a
`faults:<callNo>` stream and do not perturb the weather). The hourly-retry structure masks the faults:
`jira_search` failing just idles that shift; `k8s_logs` failing skips one ticket until the next shift. Faults
degrade latency, not completeness, at this rate. Not measured: MTTR under faults, and higher `p`.

## 7. Crash tests (all survive; world file stays valid in every case)

| case | result |
|---|---|
| brain throws every shift (5 d) | 120/120 shifts recorded as errors in history (`agent.shift` with `error`), world reaches day 5, no throw escapes `runAgents` |
| brain hangs 2 s then returns (3 shifts) | wall 6007 ms; virtual clock advanced exactly the 3 scheduled hours — real-time hangs do not move virtual time |
| brain calls 5000 tools in one shift | 448 ms, 5000 calls, no cap hit — `runAgents` has no per-shift call budget (budgets are opt-in via `budgeted()`) |
| two agents with the same id | **silently accepted, no error** (F5) |
| agent id `"ops:1"` / `"ops 1"` | works; attribution `tool:ops:1` / `tool:ops 1`; 48 shifts, 6 tool events each |
| `untilDay` in the past | no-op, 0 shifts, clock untouched, no error |
| `untilDay` = 1e6 with `maxShifts` 100 | 100 shifts in 47 ms, stops at day 4, no hang |

## Findings

- **F1 (medium): snapshot storage is quadratic in run length; resolved incidents are never pruned.** Repro:
  run exp2 to 365 vs 1000 days and compare `SUM(LENGTH(state))` in `snapshots` (17 MB vs 124 MB) against
  `SUM(LENGTH(payload))` in `world_events` (0.56 MB vs 1.5 MB). A year at this arrival rate is ~19 MB (fine);
  multi-year or higher-arrival worlds grow as O(days^2) in both bytes and snapshot-write CPU (wall/day
  11.9 -> 23.4 ms). Fix direction (not applied): prune/compact resolved incidents from snapshot state, or
  snapshot diffs.
- **F2 (medium): per-shift agent work scales with total-incidents-ever, not open ones.** Repro: exp4
  `jira_search` row (90 -> 548 us); `rulesOps` lists all tickets every shift including long-resolved ones.
  Over a long run every hourly shift gets slower forever. For a Tier-2 brain this is context/time cost, not
  just CPU.
- **F3 (medium): storm shift cost is superlinear in open tickets; knee at ~2000-5000 open.** Repro:
  `.scratch/exp3b_stormscale.ts` (0.40 -> 1.83 ms/ticket). One hourly shift still clears 5000 tickets in
  ~9 s for rules; a model brain needs batched triage before that scale.
- **F4 (low): `grafana_query` degrades fastest (27x from 4 to 501 open, 2.9 ms/call).** Repro: exp4 table.
  Cause: full-state `view()` copy per sampled point. Would dominate a metrics-heavy agent's shift at scale.
- **F5 (low, closest to a real bug): duplicate agent ids are silently accepted.** Repro: `withAgents(spec,
  ["ops-1","ops-1"], HOUR)` + `runAgents(..., {untilDay: 2, maxShifts: 10})` -> 10 shifts, no error; the
  `byId` map collapses both wakes into one driver while two dead actor entries sit in the spec. Harmless
  today, but fail-fast validation in `withAgents`/`runAgents` would be safer.
- **F6 (info): no per-shift tool-call guard in `runAgents` itself** (5000 calls/shift in 448 ms, F-case c).
  Budgets exist only via the opt-in `budgeted()` wrapper. A runaway Tier-2 brain loops unthrottled by default.
- **Positive (no finding): determinism, resume, fault tolerance, and crash safety all hold** — bit-identical
  hashes across reruns and 5 close/reopen cycles (exp5); p=0.5 missing faults fully masked with 0 open (exp6);
  throwing/hanging/flooding brains cannot corrupt the world or move virtual time (exp7 a-c); past/far
  `untilDay` values are safe no-ops or capped stops (exp7 f-g); reopen cost is 1-5 ms even at 27 k events.

## What could not be measured

- Real Tier-2 (model) brains: turn-cap exhaustion, cost, and latency under storms need a model endpoint; the
  rules brain is a lower bound on shift cost.
- MTTR under faults (exp6 reports completeness only), and fault rates above p=0.5.
- Runs longer than 1000 days, more than 32 agents, storms above 5000: each would exceed the per-experiment
  time box once quadratic costs bite (extrapolating F1, 10 k days would take ~40 min and ~12 GB of snapshots).
- Concurrent multi-process drivers on one world file (SQLite locking) — single driver only here.
- Recorded-mode (tape) save/load/replay cost at scale.
- RSS peaks in isolation: memory was measured cumulatively in one process per script (peak observed 151 MB
  in the 1000-day run); per-experiment heap attribution was not done.
- The known M2 limit (`slow` faults report `delayMs` without advancing the world clock) was not re-measured.
