# Crew World (E3, the endgame): design

Status: **design, nothing built**. Written 2026-10-08 so that development can be resumed later, by anyone, from this folder alone:
`README.md` (this: what and why) -> `BACKLOG.md` (milestones with acceptance commands) -> `PROGRESS.md` (the log; read last entry first).

## What it is
A relaxed, watchable **game world** in which Crew's agents, and many instances of them, live and work. Problems are synthetic, tools are synthetic, the surrounding world is a stateful synthetic one. Statistics are hard-coded code (not model prose) and drawn as real graphs. The operator can play god. It doubles as the platform's test bench: the goal's World Engine and noise testing (Prompts 06-08, 15) are this, seen from the engineering side.

It is not a prediction of any real organization (plan B6). Results are labelled synthetic experiments.

## How to make a simulation long
A year of virtual work must cost seconds of wall time and cents of model money. Seven rules, in order of importance:

1. **Virtual time jumps.** Discrete-event simulation: a priority queue of scheduled events; the clock leaps to the next one. No sleeping. One virtual day with no activity costs microseconds.
2. **Tiered cognition.** Most of the world is not a language model.
   - *Tier 0, rules and statistics:* customers, traffic, failures and their causes (arrival processes from a seeded RNG), deploys, recoveries. Free and deterministic.
   - *Tier 1, scripted or tiny-model policies:* routine agent behaviour (acknowledge, triage by rule, standard fixes). Cheap.
   - *Tier 2, real agents (Pi runtime, a real model):* only at **decision points**: an unfamiliar incident, an approval, a conflict. A budget decides how often.
3. **Budgets with graceful fallback.** Per virtual day and per run: max model calls, max cost, max wall time. When a budget is spent the world does not stop; Tier 2 falls back to a Tier 1 policy and the statistics record "degraded", so a long run always finishes and always says how honest it was.
4. **Checkpoints, resumable runs.** A snapshot every virtual day (state, RNG state, pending schedule, hash). A run is a *slice* (e.g. 30 virtual days) that can stop and resume tomorrow; a resumed run must equal an uninterrupted one.
5. **Recorded mode.** Every model and tool response in Tier 2 is stored keyed by request hash. Re-running the same world is then free and bit-for-bit identical; only a *counterfactual* branch asks new questions.
6. **Rollups, not raw scans.** Daily/hourly aggregates are written as the run goes, so a year of graphs reads a few hundred rows.
7. **Agent memory stays bounded.** Long-lived agent instances use the OptChat tree (constant-size view), so day 300 costs the same context as day 3.

## Architecture (one picture in words)
```
 operator (UI / CLI)        Crew World view          existing platform
        |                        |                         |
   WorldControl  ----------  Stats API  ------------  org registry, handoffs,
   (godmode)                  (rollups)               CaseContext, OptChat, CLI
        |                        ^
   +----v--------------------------------------------+
   |  World Engine  (src/world/, one world = one SQLite file)
   |   VirtualClock | SeededRng | Scheduler | Reducer(events -> state)
   |   Actors: tier 0 / tier 1 / tier 2 (Pi runtime in synthetic scope)
   |   Synthetic tool adapters (k8s, repo, tickets, metrics) + fault injection
   |   Snapshots | Recorded responses | Budgets | Rollups
   +-------------------------------------------------+
        | summaries only (world.started, scorecard, ...)
   main `events` log (scope=synthetic, worldId, branchId)
```

### Decisions made now (change them in `PROGRESS.md` with a reason)
| # | Decision | Why |
|---|---|---|
| D1 | **One world = one SQLite file** (`worlds/<id>.sqlite`) with its own `world_events(branch, seq, vtime, type, actor, payload)`, snapshots, recorded responses, rollups. Only summaries go to the main `events` table. | A year is millions of events; keeps live tables clean; a fork is a file copy plus a branch row; a world can be deleted or archived whole. |
| D2 | **Our own deterministic engine first**, behind a `WorldPort` interface. Restate or DBOS can be tried later as the executor behind the same port (M8). | Determinism, fork and replay need control of state and time. A durable-execution journal is not the same as domain time travel (plan B3, "Temporal replay is not time travel"). The Restate/DBOS APIs are **unverified here**; check them before M8. |
| D3 | **Temporal stays for live work only** (owner decision). The world does not use Temporal; its clock is virtual. | Two engines, one sentence: due date/human/many agents in the *live* system is Temporal; the simulation has its own clock. |
| D4 | **First domain: IT operations** (services, deploys, incidents, tickets), not supply chain. A second domain (order-to-delivery, plan Prompt 15) comes after M6. | Reuses what exists: agents ops/developer/reviewer/insight, `fakes.ts` fixtures, handoffs, CaseContext, the checkout story. |
| D5 | **Synthetic scope removes live tools** (deny by absence): the synthetic toolset is built from adapters over world state; no live adapter object exists there. A tripwire test tries every live tool. | Safety by absence, not by a check someone forgets. |
| D6 | **Statistics are code.** Metrics are defined in one file, computed from events, tested against hand-calculated cases. Agents may narrate them, never produce them. | Plan: measure from events and end states, never from an agent's own report. |
| D7 | The **game view** is a projection like the rest: the same events draw services as buildings, agents as characters, handoffs as walking between desks, incidents as fires. No state of its own. | One source of truth; the view can be rebuilt or replaced. |

## The domain (M1), enough to be a world
- **Services** (api, checkout, payments, search, db, queue) with health, load, version, config, dependencies.
- **Problems** from a catalog with seeded causes: bad config, leak, capacity, dependency down, bad deploy, expired certificate, noisy alert (false positive). Each has symptoms in metrics/logs, a real fix, and wrong fixes that make it worse.
- **Arrival process:** incidents, tickets and deploys arrive by seeded rates that vary with time of day and week.
- **People and agents:** instances of Ops/Developer/Reviewer/Insight with shifts and a backlog (the "colleagues with calendars" idea), plus a few simulated humans (approver, customer) as Tier 0.
- **Tools:** the same names and shapes as the real ones (`k8s_pods`, `k8s_logs`, `repo_*`, `jira_*`, `grafana_query`) but answering from world state, with fault injection (stale, wrong, slow, missing).

## Statistics and graphs (hard-coded, M4)
Throughput (incidents opened/closed per day), time to acknowledge/resolve (p50/p95), mean time to recovery, escalation rate, handoffs per incident, human attention minutes per resolved item, wrong-fix rate, repeat-incident rate, conflicts found in CaseContext, model calls and cost per resolved incident, degraded-day count, service uptime (SLO burn). Charts use the existing `render_ui` catalog (line/area/bar, StatusBoard, Timeline, Table) plus a heat strip per service and a "world clock" bar.

## Godmode (M5)
Pause, step, speed (1x ... max); inject an incident (pick a cause), kill or spawn an agent instance, change a policy or the budget, change an organization version (the "org dry-run"), fork a branch at any snapshot and run both forward; compare scorecards side by side. Every godmode act is an event with `actor: "operator"`.

## How a future session resumes development (the loop)
1. Read `PROGRESS.md` (last entry), then the next unchecked milestone in `BACKLOG.md`.
2. **Test first:** write the milestone's acceptance test; watch it fail.
3. Build the smallest thing that passes it; keep `npm run world:check` (created in M0) green: determinism hash, invariants, no-live-write tripwire.
4. Never tick a milestone without running its acceptance command and pasting the result into `PROGRESS.md`.
5. One milestone per branch (`feat/world-mN`), commit small, update the docs in the same commit.
6. Record every decision change and every honest limit in `PROGRESS.md`. If a number in this folder was a target and reality differs, write the real number.
7. Stop at the end of a milestone; say what is next. Do not start the next one "while here".
Long runs themselves (M6) are driven by `crew world run --days N --slice 30` and can be started by a scheduler or `/loop`; each slice ends with a checkpoint and a one-line report.

## Risks (honest)
- **Fun vs rigor.** A beautiful view over a world with weak causality teaches nothing. M1 spends its effort on causal fidelity of problems and fixes before any drawing.
- **Model cost drift.** Tier 2 is the only expensive part; budgets must be enforced in code, and every run reports spend.
- **Determinism leaks:** wall-clock time, iteration order, floating point, model nondeterminism. Hash every day; fail loudly on divergence.
- **Over-claiming.** The world proves the platform behaves under synthetic stress; it does not predict a real company.
- **Scope.** Eight milestones; M0-M4 are a coherent product ("watch a synthetic ops team live for a year"); M5+ are bonus.
