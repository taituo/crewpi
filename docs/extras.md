# Extras (requests that are not in `goal`)

Things the owner asked for on top of the 16 prompts. Each has an id, the wording that matters, and where it is built.
They never reorder the prompts; they ride on the same services.

| Id | Request | Status |
|---|---|---|
| E1 | **CLI-first, config-as-code.** The whole thing must be doable from a config file and a CLI; the UI is only one manifestation of the same domain operations. Examples given: `--send #channel --as alice`; `--replay --start --end` to *browse what happened* (history, not a Temporal-style re-execution); `--create-realm` followed by config files. | Built on `feat/cli-config-as-code`: `docs/cli.md` (send, replay, create-realm, apply/validate/export; 63 tests) |
| E2 | Design bets (attention points, agent backlog, resumable SSE) - my own ideas, kept on `feat/bets-first-bite`, parked until Prompts 01/09/14. | Parked |

## Rules that follow from E1 (apply to every later prompt)
1. A feature is not done until it can be driven without the browser: a service operation, then a CLI verb, then (optionally) a UI view.
2. Anything the CLI changes goes through the same application services and checks as HTTP; the CLI never writes tables directly.
3. Config is declarative, versioned and idempotent: applying the same file twice changes nothing, and `export` produces a file `apply` accepts.
4. "Replay" means reading recorded history. Re-execution of a workflow stays Temporal's job, and re-execution of a synthetic world stays the World Engine's (Prompts 06-07).
