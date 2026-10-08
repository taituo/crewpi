# Organization Registry (Prompt 04)

Behind `FEATURE_ORG_MODEL=true` (default off). Code: `src/org/` (`registry.ts`, `types.ts`, `templates.ts`, `seed.ts`, `propose.ts`), migration 4, routes under `/api/orgs`.

## What it is
An organization is a **graph per version**: nodes (`team`, `role`, `capability`, `system`, `external_party`), typed edges, memberships (participant -> node), per-version agent configuration (model, instructions, tools) and policies. Versions are `draft` (editable) -> `adopted` (immutable, one per organization) -> `archived`. Participants are tenant-level (`human`, `internal_agent`, `external_agent`, `assistant_agent`, `service`).

## The rule that matters
- **Descriptive edges** (`belongs_to, reports_to, collaborates_with, responsible_for, depends_on, must_inform, substitutes_for`, and `custom:<name>`) explain the work. They never authorize anything.
- **Authoritative edges** (`can_approve, can_delegate, has_access_to`) are the only source of rights. Creating, removing them, or setting a policy needs `org.admin`; ordinary edits need `org.edit`. Both are themselves capabilities granted by `has_access_to` edges in the *adopted* version.
- A platform role from Keycloak (`admin`, `approver`, ...) counts as holding the role node of the same name, so the existing login keeps working. Creating an organization and filling its **first** draft needs the platform `admin` role (nothing exists yet to grant rights).

## Access
Same-tenant rule first (another tenant gets 404, as for a missing organization). Inside a tenant, reading needs a place in the organization (membership or a matching platform role); strangers get 404 and an empty list. Agent instructions and tools are shown to `org.edit` holders only.

## Validation (deterministic, same code for every organization)
Errors block adoption: approval, delegation and reporting cycles; an approver node nobody holds. Warnings are returned: dependency cycles, nodes nobody holds, capabilities/systems with no owner, `must_inform` towards an empty node, a responsibility that depends on one participant without a substitute, self-approval (responsible for and approver of the same target).

## HTTP
`GET /api/orgs`, `POST /api/orgs {name}`, `GET /api/orgs/:id[?version=]`, `GET|POST /api/orgs/:id/versions`, `POST /api/orgs/:id/versions/:v/{ops|validate|adopt|propose}`. `ops` takes `{ops:[...]}` and applies them atomically. `propose {text}` turns a sentence ("Add team Data. Data reports to Platform") into operations **without applying** them; a language model can replace `rulePlanner` later.

## Try it
```sh
FEATURE_ORG_MODEL=true AUTH_MODE=dev DEMO_MODE=true npm start     # log in at /auth/login?as=root (admin)
```
The original demo is seeded as organization `default` (4 agents, roles, standing channels as teams).

## Test organizations
`templates.ts` builds a hierarchical company, a network of autonomous squads and an agents-only company through the same operations; `test/org.test.ts` runs identical assertions over all three.

## Not done (honest list)
- **The runtime does not read the registry yet.** Channels and agents still come from `agents.ts`/`channels.ts`; the registry describes the demo, it does not drive it. Wiring (agents and channel membership from the adopted version) is a separate step.
- **No graph UI.** The graph is available as JSON (`GET /api/orgs/:id`); a visual builder is not built.
- Planner is rule-based (a few English/Finnish sentence forms); no language-model planner.
- Memberships are per version; human participants are created on first API call, not yet linked to a node unless an admin adds them (their platform role still maps to a role node).
- No hash-chained audit; org edits are audited with actor id (`org.create/draft/edit/adopt`).
