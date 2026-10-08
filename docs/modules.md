# Modules

One row per module in `src/`: what it is, whether it is a candidate for the Entropi core, and whether it has been synced there.

- **Core candidate** (my judgment, to be confirmed): *yes* = general, no demo or Crew UI assumptions; *maybe* = general idea, but tied to this repo's tables or the Pi Durable runtime; *no* = CrewPi-specific (demo data, UI, cluster).
- **Synced to Entropi**: none yet. Entropi (`taituo/entropi`) is where general parts land later; CrewPi is the working repo. Update this column when a part is ported.

## Domain: work, org, policy

| Module | What | Core candidate | Synced |
|---|---|---|---|
| `work/events.ts` | Domain events with a transactional outbox and a durable inbox (at-least-once, idempotent consumers) | yes | no |
| `work/handoffs.ts` | Task + Handoff: sent ≠ received ≠ understood ≠ done, each its own transition and event | yes | no |
| `work/escalation.ts` | The single place that decides what happens to an unacknowledged, rejected, failed or overdue handoff | yes | no |
| `work/lifecycle.ts` | Moves a handoff forward from the recipient's run lifecycle | maybe | no |
| `work/consumers.ts` | Outbox consumers (delivery, notifications) | maybe | no |
| `work/case.ts` | CaseContext: shared, sourced picture of a case; never a copy of private memory | yes | no |
| `work/index.ts` | Process-wide bus and handoff service | no | no |
| `org/registry.ts`, `types.ts` | Organization Registry: who is who, what they may do; authority checked in every function | yes | no |
| `org/routing.ts` | Who stands in for whom, who must be told | yes | no |
| `org/propose.ts` | Sentence → proposed registry operations; a person confirms | maybe | no |
| `org/templates.ts`, `seed.ts` | Example organizations; the demo as default org | no | no |
| `policy.ts` | Autonomy policy: allow / deny / escalate, deterministic, no model (the model proposes, this decides) | yes | no |
| `workitems.ts` | Seeded synthetic work items routed through the policy; reports what a person would see | maybe | no |
| `cases.ts`, `watch.ts` | Demo tickets and the anomaly watcher over fake metrics | no | no |

## Agents, memory, inference

| Module | What | Core candidate | Synced |
|---|---|---|---|
| `runtime.ts` | Pi Durable runtime: providers, agents, mirroring of conversations into channels, OptChat wiring | maybe | no |
| `optchat.ts` | OptChat memory tree: summaries of leaves, merge, fit to a token budget | yes | no |
| `memory.ts` | Agent notes: append-only, ≤280 chars, scoped to agent or channel | yes | no (Entropi has `memory-notes`, unmerged) |
| `agents.ts` | The four standing agents and their default models | no | no |
| `tools.ts` | Agent tools incl. the approval gate (opens/finds the approval, posts the card) | maybe (gate: yes) | no |
| `tools-insight.ts`, `tools-sandbox.ts`, `repo.ts` | Integration tools, sandbox tools, restricted git ops | no | no |
| `ui-spec.ts` | Generative UI: agents emit a JSON spec from a fixed component catalog | maybe | no |
| `budget.ts` | OpenRouter spend guard (soft cap) | no (generalize into provider-agnostic accounting first) | no |
| `demo.ts` | Scripted offline brains for the no-key fallback; not intelligent | no | no |

Inference providers wired in `runtime.ts`: `openai`, `openrouter`, `opencode-go` (key in `OPENCODE_API_KEY`), `local` (any OpenAI-compatible endpoint), `demo` (fallback). `AGENT_DEFAULT_MODEL` / `AGENT_<ID>_MODEL` take `provider/model`.

## Platform and surfaces

| Module | What | Core candidate | Synced |
|---|---|---|---|
| `channels.ts` | Channels, visibility (private chats belong to exactly one user), @mentions | yes (rule) | no |
| `hub.ts` | Server-side filtered SSE fan-out | maybe | no |
| `auth.ts` | Dev mode and OIDC (code + PKCE) | maybe | no |
| `config.ts` | Environment-driven configuration | no | no |
| `db.ts`, `migrate.ts`, `migrations.ts` | SQLite, forward-only migrations | maybe | no |
| `lock.ts` | Lease-file lock (Pi Durable allows one process per storage) | maybe | no |
| `cli.ts`, `cli/manifest.ts`, `cli/history.ts` | CLI-first surface: send, replay (read history), config-as-code (idempotent apply, export) | yes (rule E1) | no |
| `server.ts`, `public/` | HTTP API and the Crew UI | no | no |
| `temporal*.ts`, `activities.ts`, `workflows/` | Temporal worker, handoff watchdog, incident workflow (Temporal owns the clock/process, DB owns status) | optional add-on | no |
| `sandbox.ts`, `kube.ts`, `integrations.ts`, `fakes.ts`, `uploads.ts` | Sandbox pods, in-cluster client, fake integrations, upload checks | no | no |

## Crew World (synthetic world)

| Module | What | Core candidate | Synced |
|---|---|---|---|
| `world/engine.ts`, `types.ts`, `rng.ts` | Deterministic time-skipping engine, seeded RNG, event log | yes | no |
| `world/agents.ts`, `brains.ts`, `model-brain.ts`, `team.ts` | Agents in the world: rule brains (Tier 1) and model brains (Tier 2, OpenAI-compatible) | maybe | no |
| `world/itops/*`, `specs/*` | IT-ops domain: catalog, state, symptoms, synthetic tools; ticker spec | no (example domain) | no |
| `world/observe.ts`, `watch-server.ts`, `ui/world.html` | God eye: read-only view of any point in history | maybe | no |
| `world/bridge.ts`, `live.ts` | World shown as a read-only `#world-<name>` channel in the Crew UI; live runner | no | no |
| `world/report.ts` | Summary of a slice into the main log (scope synthetic), with a hash | maybe | no |
