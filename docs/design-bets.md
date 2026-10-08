# Design bets

Opinionated replacement for the dry ADR list. Each bet says what we do, why it's fun *and* useful, and what would make us back out.
The ADRs in `docs/adr/` stay as the sober reference; where a bet disagrees with an ADR, the bet wins (and the ADR gets a note when we build it).

Fixed by the owner: Temporal and Pi Durable both stay, k3s + Keycloak are the stack (ADR-0002 constraints).

---

## Bet 1 - Attention is the currency, not messages

The whole product exists to spend **human attention** well. So attention is a first-class, measured thing:

- Every item that reaches a human costs *attention points* (a decision costs more than an FYI; an interrupt costs more than a digest item).
- Each human has a daily **attention budget**. The oversight centre (Prompt 14) ranks by "value of this human's time", not by recency.
- Agents get a **reputation per kind of work**: how often their output was accepted untouched, edited, or reverted. High-reputation agents on low-risk work earn *wider autonomy automatically*; a bad week narrows it. The dial is policy data with an audit trail, so a human can always overrule it.

*Why:* this is the real answer to "scale work, not chat noise". *Back out if:* the numbers can't be made honest (gaming, no baseline).

## Bet 2 - Everything is an event; the chat is just one view

Take Entropi's best idea, not its absence of a process engine: one append-only **event log** is the truth (ADR-0005 outbox lives *inside* it). Channels, case boards, the exception centre, Teams posts, MCP reads and the synthetic world are **projections** of it.

- A "what happened here?" question is always a replay, never an archaeology dig through agent transcripts.
- Agents get a **briefing** (a projection) when they join a case instead of re-reading history.
- Time travel for the twin falls out for free: a world is a log prefix plus a fork.

*Back out if:* write amplification or projection lag hurts latency; then keep the log but make hot projections synchronous.

## Bet 3 - Rehearse before you reorganize ("org dry-run")

Changing the org graph or an autonomy policy is the riskiest edit in the system, so it gets a **dry-run**: the registry forks the current org into a synthetic branch, replays the last N days of real (scrubbed) work items through the *proposed* version, and shows the diff: queue length, exceptions raised, who gets overloaded, which approvals vanish.

- Prompt 04 (builder) and 06-08 (twin) become one story: *edit → rehearse → adopt*.
- The first twin domain is **our own incident handling** (the existing checkout incident), not a made-up supply chain. We already have a believable fixture and a real fix to compare against.

*Back out if:* replays are too slow or too unfaithful to trust; then ship only the structural analysis (Prompt 08 level A).

## Bet 4 - Agents are colleagues with calendars, not chat bots

Roles are *people-shaped*: an agent has a working window, a backlog, a backup, and a handover note. "Ops is busy / on shift / out" is real state (the Temporal task queue is its calendar). Handoffs (Prompt 05) are therefore normal workplace behaviour: "I can take it after the current task", "I'm unavailable, routing to backup". Overdue means *escalation to the backup*, not a red badge.

- One physical Pi runtime can host many roles (the plan allows it); the calendar makes that visible rather than hidden.

*Back out if:* it adds ceremony without improving throughput in the 200-work-item slice.

## Bet 5 - Two engines, one sentence

Temporal vs Pi, as a rule anyone can apply in one breath:

> **Due date, a human, or more than one agent → workflow. One agent thinking and calling tools → Pi run. Status lives in rows both update.**

Practical consequence: the agent-run API (`submit/status/cancel`) is the *only* door between them, so the day Pi is sharded or replaced nobody else notices.

## Bet 6 - Postgres when the first worker splits off, not before

SQLite is a feature for the demo (one file, instant start, trivially snapshot-able for the twin). We stay on it **until Prompt 11 needs a second writer**. The move is made easy on purpose: repositories take an `ActorRef`, SQL stays boring, ids are ULIDs. No big-bang migration, no "Postgres first" tax on 80% of the roadmap.

## Bet 7 - Safety by absence

Not "the model promises not to": in a synthetic scope the live tools **do not exist** (ADR-0004), for an external MCP client the approval path **cannot be addressed**, and for an agent without a grant the capability **isn't in its tool list**. Absence beats a check that someone forgets to write. Each of these gets a tripwire test that tries the forbidden thing.

## Bet 8 - Make the weirdness measurable (noise testing as a game day)

Prompt 15 becomes a recurring **game day**: pick a noise profile, run control and perturbed branches from the same snapshot, and get one scorecard (time to detect, time to correct, wrong decisions, escalation quality). The scoreboard history is a product feature: "our org got 40 % better at catching a stale delivery date since March" is a sentence a manager can use.

---

## What this changes in the roadmap

| Plan item | Change |
|---|---|
| P0a / 04 | add `participant.kind` incl. `agent` with `calendar`/`window` fields (Bet 4) |
| 05 | event log is the core table; handoff = state machine over events (Bet 2, 4) |
| 11 | policy engine reads an **autonomy dial** per agent+risk class; reputation updates it (Bet 1) |
| 14 | ranking by attention cost/value, per-human budget (Bet 1) |
| 06-08 | first twin domain = replay of our incident/checkout world; "org dry-run" as the headline feature (Bet 3) |
| 15 | game-day scorecards with history (Bet 8) |

## Smallest first bite (nothing here waits for approvals of ADRs)

1. Event log table + SSE `Last-Event-ID` resume (Bet 2) - fixes F-13 and gives every later prompt a spine.
2. `attention_cost` on approvals and handoffs, a daily total per human, shown in the UI header (Bet 1) - tiny, and instantly tells us if the idea is any good.
3. Agent "shift" state in presence (Bet 4): working / waiting / off, derived from Temporal task queue + pending approvals.

## Status of the first bite (branch `feat/bets-first-bite`)

| Item | State |
|---|---|
| 1. Resumable event spine | **Partly.** A *change feed* (`change_feed`, migration 3) numbers message/approval changes and the SSE stream honours `Last-Event-ID` (replay of changed entities once, in current state; `reset` when too far behind; private chats filtered). It is **not** yet the domain event log of Bet 2: that arrives with Prompt 05. |
| 2. Attention | **Done (minimal).** `approvals.attention_cost` (5 per decision, 8 for a live cluster change), `GET /api/attention`, sidebar line "Attention spent + waiting / budget" (`ATTENTION_BUDGET`, default 100). Charged to the decider by `sub`. Handoff/FYI costs, per-human delivery of items and agent reputation are not built. |
| 3. Agent shift | **Minimal.** Presence carries `backlog {running, approvals}`; the sidebar shows "N waiting". Calendars/windows/backups are not built. |

Honest note: Bets 1, 4 and 8 are my proposals, not part of `goal`; nothing above changes behaviour of the existing demo apart from the extra UI line and ids on the SSE stream.
