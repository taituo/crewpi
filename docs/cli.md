# `crew` - the command line (Extra E1)

The UI is one surface of Crew. Everything built so far can also be driven from a terminal and from config files.
Run it as `./bin/crew ...` or `npm run crew -- ...` (Node >= 22.19).

```text
crew send <channel> <text...> --as <user> [--url http://localhost:8080] [--wait 60]
crew --send '#insights' -m "how is checkout?" --as alice        # quote '#': shells treat it as a comment
crew replay [--start <when>] [--end <when>] [--channel <name>] [--kind message,approval,decision,audit] [--json] [--include-dm]
crew create-realm <name> [--entity <name>]                       # or: crew --create-realm <name>
crew apply -f <file.yaml|json> [--dry-run] [--no-adopt]          # crew validate -f is the same as --dry-run
crew export [<organization name or id>] [--format yaml|json] [-o file]
crew orgs
```

## Two kinds of commands
| | Talks to | Acts as | Needs |
|---|---|---|---|
| `send` | the running server over HTTP, exactly like the browser | the login you name with `--as` (same permissions: a viewer gets 403) | server in `AUTH_MODE=dev` for now (alice, bob, carol, root). Token login for real accounts is **not built yet**. |
| `replay`, `apply`, `validate`, `create-realm`, `export`, `orgs` | the local data directory (`DATA_DIR`) | the local operator `cli:<user>` (like `kubectl` on a node), recorded in the audit trail | filesystem access to the data directory |

The local commands never write tables directly. They call the same `Registry` service and checks as `/api/orgs`; the operator flag only skips the "who holds `org.admin`" lookup because whoever has the data directory is the operator anyway. HTTP and MCP can never set it.

## `replay` is history, not re-execution
It lists what happened between two moments, in order: messages, approvals, decisions, audit entries. It changes nothing and runs no agent, workflow or tool. (A Temporal workflow replay and a synthetic-world replay are different things and stay in Temporal and the World Engine, Prompts 06-07.) Times: `2026-10-08T10:00`, `today`, `now`, `-90m`, `-2h`, `-3d`. Private chats are hidden unless `--include-dm`.

```sh
./bin/crew replay --start -2h --channel incidents
./bin/crew replay --start today --kind decision,audit --json
```

## Config as code
One file describes a realm, its entities and organizations (`docs/examples/realm.yaml`):

```yaml
realm: {name: Acme Group}
entities: [{id: acme-hq, name: Acme HQ}]
organizations:
  - name: Acme Ops
    entity: acme-hq
    nodes:   [{kind: team, name: Ops}, ...]
    edges:   [{type: reports_to, from: "team:Ops", to: "team:Exec"}]
    members: [{participant: "human:alice", node: "team:Exec"}]
    agents:  [{participant: "agent:ops", model: "openai/gpt-5.6-terra", instructions: "...", tools: [k8s]}]
    policies: [{kind: authority, name: release, body: {requires: release.approve}}]
```
Participants are `human:`, `agent:`, `external:`, `assistant:` or `service:` plus a handle. Unknown keys are errors (a typo is not silently ignored).

- **Idempotent:** applying the same file twice reports `unchanged`. A changed file becomes a **new version**; the adopted one is never edited.
- **Validated:** the registry's checks run before adoption; errors (cycles, unstaffed approver) refuse it with the reasons and exit code 1, nothing is adopted. `--no-adopt` leaves a draft.
- **Dry run:** validates the desired organization in a scratch database and writes nothing.
- **Round trip:** `export` writes a file that `apply` reports as `unchanged`.
- A new organization is created if no organization of that name exists in the tenant; renaming is therefore a new organization for now.

## Not done
- `send` for real (OIDC) accounts; there is no API token mechanism yet (needed for MCP too, ADR-0003).
- Channels, agents-as-runtime and workflows are not configurable from files yet, because the runtime does not read the registry yet (see `docs/org-registry.md`). Apply only changes the registry.
- No `crew` verbs for approvals, handoffs or workflows yet; they arrive with the prompts that create those objects (rule 1 in `docs/extras.md`).
- `replay --follow` (live tail) is not built.
