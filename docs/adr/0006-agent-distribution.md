# ADR-0006: Distributing agent execution

Status: Proposed

## Context
Pi Durable allows one process per storage (README, F-9). Large-scale delegation (Prompt 11) needs more concurrent agent runs than one process comfortably serves, and workers separate from the HTTP server.

## Options
| | Option | Pros | Cons |
|---|---|---|---|
| A | Keep one process; raise concurrency only | zero change | hard ceiling; HTTP and agents share failure domain |
| B | **Dedicated `agent-runtime` service, single owner of `pi.sqlite`**, exposing submit/status/cancel; HTTP and Temporal workers become clients | removes HTTP from the lock; workers scale freely; small change | runtime itself still one process (vertical scale) |
| C | **Shard** runtimes: N runtimes each owning its own Pi storage; deterministic routing by `agentParticipantId`/`conversationId` hash | horizontal scale | needs routing table, rebalancing story, cross-shard ops |
| D | Re-implement agent loop on Temporal activities | native scaling | large rewrite; lose Pi compaction/tool replay |
| E | Stateless agents (per-call context from DB) | simplest scaling | loses durable multi-turn behaviour and tool replay guarantees |

## Recommendation
B at Prompt 11, designing the API so C is a routing change (client chooses runtime by shard key). D/E only if measurements show B/C insufficient. Do **not** claim multi-replica support (plan release gate).

## Verify
Pi Durable concurrency characteristics (parallel conversations in one process; measured, not assumed); file-lock behaviour that enforces single ownership; memory footprint per conversation; whether storage can be split per shard.
