# Crew World: progress log (append only, newest last)

## 2026-10-08 design written
- Context: endgame idea E3 from the owner ("a game-like world to follow the platform; synthetic problems and tools; stateful synthetic surroundings on Restate or DBOS; hard-coded statistics and real graphs; godmode").
- Decisions D1-D7 in `README.md`. Main deviations from the idea as first stated: own engine first, Restate/DBOS as a later experiment (M8) because their journals are not domain time travel and their APIs are unchecked here; world data in a separate SQLite file per world, not in the live `events` table.
- Reusable today: org registry (04), events/handoffs/CaseContext (05), `fakes.ts` fixtures, `render_ui` chart catalog, OptChat memory, CLI, `events.scope/world_id/branch_id` columns. Missing: virtual time on events, snapshots, scheduler, budgets, recorded responses.
- Next: M0. Nothing built yet.
