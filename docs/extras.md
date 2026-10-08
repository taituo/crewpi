# Extras (requests that are not in `goal`)

Things the owner asked for on top of the 16 prompts. Each has an id, the wording that matters, and where it is built.
They never reorder the prompts; they ride on the same services.

| Id | Request | Status |
|---|---|---|
| E1 | **CLI-first, config-as-code.** The whole thing must be doable from a config file and a CLI; the UI is only one manifestation of the same domain operations. Examples given: `--send #channel --as alice`; `--replay --start --end` to *browse what happened* (history, not a Temporal-style re-execution); `--create-realm` followed by config files. | Built on `feat/cli-config-as-code`: `docs/cli.md` (send, replay, create-realm, apply/validate/export; 63 tests) |
| E3 | **ENDGAME - "Crew World" / godmode.** A playable, relaxed *game world* view of the platform: agents and their instances take part in it as characters; the problems are synthetic, the tools are synthetic, and the surrounding world is a stateful synthetic one (Restate or DBOS as its engine); hard-coded statistics and proper graphs; you can watch it, and play god. Owner's words: "this is an unbelievable platform". | Recorded 2026-10-08, not started. Fits goal Prompts 06-08 and 15 (World Engine, snapshots/forks, stress, noise): see below |
| E2 | Design bets (attention points, agent backlog, resumable SSE) - my own ideas, kept on `feat/bets-first-bite`, parked until Prompts 01/09/14. | Parked |

## Rules that follow from E1 (apply to every later prompt)
1. A feature is not done until it can be driven without the browser: a service operation, then a CLI verb, then (optionally) a UI view.
2. Anything the CLI changes goes through the same application services and checks as HTTP; the CLI never writes tables directly.
3. Config is declarative, versioned and idempotent: applying the same file twice changes nothing, and `export` produces a file `apply` accepts.
4. "Replay" means reading recorded history. Re-execution of a workflow stays Temporal's job, and re-execution of a synthetic world stays the World Engine's (Prompts 06-07).

## E3 in more detail (idea, not a plan yet)
- **World = projection of events.** The domain events from Prompt 05 (`events`: handoffs, facts, decisions, approvals) are exactly what a world view needs to draw: who is working on what, who waits for whom, what went wrong, what was decided. The first world view can be built on the live system before any synthetic world exists.
- **Synthetic side = the World Engine of Prompts 06-08.** Synthetic problems and tools, a stateful surrounding world (event log + reducer; the engine under it may be Restate or DBOS). Per the plan's section B4 this is the *simulation* track: it does not replace Temporal in the live system (owner decision: Temporal and Pi Durable both stay).
- **Statistics are code, not prompts.** Throughput, time to acknowledge/complete, escalation rate, conflicts found, cost per completed item, p50/p95: computed from events and drawn as real charts (the `render_ui` chart catalog already exists).
- **Godmode** = the operator controls the world: inject a problem (Prompt 15 noise profiles), pause/step the virtual clock, fork a branch, compare outcomes (Prompt 07), watch agent instances react.
- **Honest scope:** a game-like view does not make the simulation predictive; results stay "synthetic experiment", never a claim about a real organization (plan B6).
