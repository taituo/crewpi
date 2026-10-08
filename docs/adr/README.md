# Architecture decision records (proposals)

All records are **Proposed** (Prompt 00). Accepting, amending or rejecting them is the human gate before Prompt 04 starts.
Format: Context → Options → Recommendation → Consequences → What must be verified.

| ADR | Title | Recommendation |
|---|---|---|
| [0001](0001-storage-sqlite-postgres.md) | Storage: keep SQLite for the demo, Postgres for new domain state | Phased; repository interface first |
| [0002](0002-temporal-pi-durable-boundary.md) | Temporal vs Pi Durable responsibility | Temporal = process, Pi = one agent run |
| [0003](0003-mcp-authentication.md) | MCP authentication and identity | OAuth 2.1 resource server, per-client registration, delegated user tokens |
| [0004](0004-simulation-isolation.md) | Synthetic world isolation | Deny-by-absence adapters, server-resolved scope |
| [0005](0005-message-delivery.md) | Message and event delivery | Transactional outbox + idempotent inbox |
| [0006](0006-agent-distribution.md) | Distributing agent execution | Single-owner runtime service now; shard later |
| [0007](0007-open-choices.md) | Open choices from the plan (section F) | Recommended answers |
