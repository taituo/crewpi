# Security

Crew is a **demo-grade** system that lets language-model agents act on real infrastructure under human control.
Read this before running it anywhere that matters.

## Reporting a problem

Please report vulnerabilities privately (GitHub "Report a vulnerability" on the repository, or contact the maintainer)
rather than in a public issue. Include steps to reproduce and the version or commit.

## Security model in one page

The design assumes the model can be wrong and can be manipulated: tool output, logs and files are untrusted input
that may contain instructions (prompt injection). Safety therefore comes from boundaries around the model, not
from its prompt.

| Boundary | What it enforces |
|---|---|
| **Tools** | Agents have no shell on the workspace. They get a fixed set of tools; file paths and git refs are validated; repo writes go only to `agent/*` branches. |
| **Kubernetes RBAC** | The workspace may read and patch a few kinds in `demo-apps`, and create/delete pods in `ai-sandboxes`. Nothing else (no secrets, no exec). |
| **Human approval** | Changes to a live system block until a person with the `approver` role decides. Approvals are stored in the database, so a restart resumes the same wait. |
| **Sandbox pods** | Untrusted commands run in a pod: non-root, read-only root, no service-account token, no capabilities, resource limits, a deadline, default-deny NetworkPolicy with only DNS and public web (80/443) allowed. |
| **Authentication** | Keycloak (OIDC authorization code with PKCE). Roles come from the verified token; nothing is trusted from the browser. Writes need an `X-Requested-With` header. |
| **Privacy** | Private chats are visible to their owner only, enforced server-side for lists, messages, approvals, files and the live stream. Private-chat memory never becomes agent-wide. |
| **Uploads** | Raster images only, checked by magic bytes, size-limited, served with `nosniff` and a sandboxing CSP, and only to people who can see the channel. |
| **Spend** | A soft budget cap stops dispatch to OpenRouter models; the API key has its own hard limit at the provider. Agent-to-agent delegation is depth- and rate-limited. |

## Known limitations

- **Not production hardened.** Keycloak runs in `start-dev` mode, Temporal runs its dev server (SQLite), traffic is plain
  HTTP unless you put TLS in front (set `COOKIE_SECURE=true`), and demo user passwords are generated at deploy time.
- **Sandbox network.** The egress policy excludes private ranges but cannot exclude the node's own public address by
  itself. Review it for your network, and consider a stronger runtime (gVisor, Kata) for hostile workloads.
- **Prompt injection is mitigated, not solved.** Approvals and RBAC bound the damage; there is no content filtering.
- **Any approver can approve any request,** including one they triggered. There are no per-person spend limits.
- **Sessions are stateless signed cookies** (8 h); role changes apply at the next login.
- **One workspace replica.** Pi Durable allows one process per storage. Pi Durable itself is experimental upstream.
- **Audit log** records approvals and actions but may contain approval titles from private chats (approvers can read it).
