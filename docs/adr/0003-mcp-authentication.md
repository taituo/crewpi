# ADR-0003: MCP authentication and identity

Status: Proposed (re-verify against the current MCP specification and TypeScript SDK before Prompt 03)

## Context
External coding/AI clients must act inside organization permissions; the MCP adapter must not become a bypass (plan Prompt 03). [Current] only browser OIDC sessions exist; no API tokens.

## Options
A. Static API keys per client. Simple, weak (no user binding, hard rotation).
B. **OAuth 2.1-style resource server (recommended)**: Keycloak as authorization server; MCP endpoint validates access tokens (audience = MCP resource, scopes per tool); clients registered per organization; user-delegated tokens carry the human `sub`; service clients carry their own `participantId`.
C. mTLS only. Strong for services; poor for desktop coding clients.

## Recommendation
B, with these rules:
1. Every request resolves to a server-side `ActorRef`; a token never carries `scope.mode`.
2. Tool-level scopes (e.g. `conversation:read`, `conversation:post`, `task:create`) **and** object-level checks in application services.
3. `conversation_post` by an external agent is stored with `actorType=external_agent`; posting "as a human" requires a human-approved draft (Prompt 02).
4. Token lifetime short; refresh/revocation via Keycloak; client registration is an admin action recorded in audit.
5. stdio transport only for local development with a developer token.
6. Rate limits and idempotency keys per client+tool.

## Consequences
Depends on Keycloak client-registration and audience mapping work; dev-mode Keycloak (H2) is not acceptable for this beyond demos.

## Verify
Current MCP auth spec revision and SDK helpers; Keycloak features available for dynamic/admin client registration; token audience handling in `jose` setup (`auth.ts` currently validates ID/access tokens for the browser client only).
