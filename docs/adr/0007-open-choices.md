# ADR-0007: Open choices from the plan (section F) - recommended answers

Status: Proposed. Each needs a human decision before the dependent prompt.

| # | Question | Recommended answer | Revisit when |
|---|---|---|---|
| 1 | SQLite vs Postgres for new domain state | Phased, ADR-0001 | Before Prompt 11 |
| 2 | Pi Durable long term | Single-owner runtime service now (ADR-0006 B) | Load test results |
| 3 | Shared knowledge: relational projections vs vector search | Relational projections + SQLite FTS5/Postgres FTS first; no vector layer until a retrieval need is shown | Prompt 05 findings |
| 4 | Meetings | Async text meetings first, no live audio/calendar | After Prompt 10 MVP |
| 5 | First synthetic domain | Order-to-delivery (orders, inventory, shipments, cash); small but end-to-end | Prompt 06 start |
| 6 | Reproducibility depth | Record every LLM and tool response in recorded mode; scrub synthetic copies of live data through an allow-list of fields | Prompt 06/07 |
| 7 | Agent autonomy limits | Per-policy `autonomy` rules by risk class; low-risk reversible actions auto, anything money/legal/external-communication needs a named human approver of the real organization | Prompt 11/14 with the customer |
| 8 | MCP identity | ADR-0003 (per-client registration + delegated user tokens, revocable) | Prompt 03 |
| 9 | Simulation scaling | Separate task queues/workers/namespace; recorded replay needs no LLM capacity | Prompt 08 |
