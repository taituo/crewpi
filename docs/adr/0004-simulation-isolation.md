# ADR-0004: Synthetic world isolation

Status: Proposed

## Context
Synthetic worlds must never cause live side effects and must be forkable/replayable (plan B3, Prompts 06-07). [Current] fixtures (`fakes.ts`) already coexist with real actions and have one deliberate crossover (`markCheckoutFixed`), F-10.

## Decision (recommended)
1. **Scope is server-resolved.** `WorldScope` is attached to a run context by the server (workflow start, API route, MCP session). Browser/MCP supply at most a *requested* world id; the server checks the right to enter it.
2. **Deny-by-absence adapters.** Tool Gateway builds the toolset per scope. The synthetic toolset contains only simulation adapters; live write adapters are not constructed, so a prompt-injected call has nothing to call. A tripwire test asserts that every live adapter throws if invoked under synthetic scope.
3. **No secrets in branches.** Branch creation copies state, not credentials; live tokens are not readable from the synthetic runtime.
4. **Separate persistence namespace.** World events/snapshots/memory keyed by `(worldId, branchId)`; live tables never receive synthetic rows (and vice versa); every row carries `source`.
5. **Separate Temporal task queues/namespace** for simulations so heavy runs cannot starve live work; workflow ids include branch id.
6. **Temporal replay != domain time travel.** Forks start new workflows with new ids; world state is rebuilt by the World Engine from snapshot+events.
7. **Replay modes:** `recorded` (no new LLM/tool calls; responses served from the log) and `counterfactual` (new calls allowed in the new branch, logged). Snapshot carries `reducerVersion`; mismatch refuses silent replay.

## Alternatives
Separate deployment per world (strongest isolation, heavy); flag-only checks in each tool (rejected: easy to miss one).

## Verify
That Pi Durable conversations can be created per branch cheaply or whether an alternative simulation agent runtime is needed for scale.
