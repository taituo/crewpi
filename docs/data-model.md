# Data model proposal

Status: **proposal** (Prompt 00). Types are conceptual; final TypeScript/SQL are fixed by ADR-0001 and the prompt that implements each part.
Current-state tables are in `src/db.ts`, `channels.ts`, `memory.ts`, `optchat.ts`, `sandbox.ts`, `watch.ts`, `cases.ts`.

## 1. Identifiers

All new ids are opaque strings (ULID/UUIDv7: sortable, no meaning). Existing integer ids (`messages.id`, `approvals.id`) stay as internal row keys and gain a stable `public_id` where exposed outside the process.

| Id | Meaning | Owner |
|---|---|---|
| `tenantId` | Customer account boundary. Hard isolation. | Registry |
| `businessRealmId` | Group of cooperating entities. **Not** Keycloak realm. | Registry |
| `entityId` | Acting unit (company, sister company, unit, AI-only org). | Registry |
| `organizationId` / `organizationVersionId` | Org profile / immutable version of it. | Registry |
| `participantId` | Any actor: human, assistant, internal agent, external agent, service. | Registry |
| `agentId` | Today's string ids (`ops`, …) become `participantId`s of kind `internal_agent`. | Registry |
| `conversationId`, `threadId` | Today's `channelId` maps to `conversationId`. | Conversation |
| `caseId` | Shared situation (today an `issue` channel ≈ a case). | Case |
| `workItemId`, `taskId`, `handoffId` | See §4. | Work |
| `workflowId` | Temporal workflow id; stable and derived (`wi:<workItemId>`) so duplicate starts collapse. | Temporal |
| `eventId`, `correlationId`, `causationId` | Event identity and lineage. | Event log |
| `policyVersionId` | Immutable policy snapshot used for a decision. | Registry |
| `representationId` | A Teams/Slack representative binding. | Registry |
| `worldId`, `branchId`, `snapshotId` | Synthetic world, branch, snapshot. | World Engine |

Mapping from today: `channels.id` → `conversationId` (kept as-is for the default org); Pi `conversation_id` ↔ `(conversationId, agentId)` stays in `convs`; `approvals.task_id` (Pi task id) is the idempotency key kept inside `ToolInvocation`.

## 2. Organization model (Prompt 04, 13)

```
Tenant 1─* BusinessRealm 1─* Entity 1─* Organization 1─* OrganizationVersion
OrganizationVersion 1─* Node ─* Edge (typed)
Node.kind ∈ team | role | participant_slot | system | external_party
Participant (human|assistant_agent|internal_agent|external_agent|service)
Membership(participant, node, role, validFrom, validTo)
Capability(name, risk_class)  GrantedBy: Edge(can_*) or Policy
Policy(policyVersionId, kind: authority|routing|visibility|autonomy|budget, body, hash)
```

**Edge types** (descriptive vs. authoritative, plan prompt 04 #2-3):

| Class | Types | Effect |
|---|---|---|
| Descriptive | `belongs_to`, `reports_to`, `collaborates_with`, `responsible_for`, `depends_on`, `must_inform`, `substitutes_for` | Routing hints, projections, validation. **Never** authorizes. |
| Authoritative | `can_approve`, `can_delegate`, `has_access_to` | Only creatable by a principal holding `org.admin` on the node; stored with `grantedBy`, `validTo`, `policyVersionId`. Tool Gateway reads these. |

Validation (deterministic, no LLM): ownerless responsibilities, approval cycles, delegation cycles, single points of failure, orphan work, conflicting authority, unreachable approvers.

**Federation** (Prompt 13): `FederationAgreement(entityA, entityB, terms, validTo)`, `ShareGrant(agreement, resourceType, resourceId|query, direction, expires)`, `CrossEntityTask(workItemId, fromEntity, toEntity, agreementId)`. No row → no cross-entity read.

## 3. Conversation model (Prompts 01, 02, 05)

Extends the existing `messages` table (additive columns, default-filled for old rows):

```
Message {
  id, conversationId, threadId?, parentMessageId?, caseId?,
  kind: message|question|task_assignment|proposal|decision|approval,
  text, meta,
  -- provenance (Prompt 02) --
  actorId (participantId, server-resolved),
  actorType: human|assistant_draft|delegated_agent|external_agent|internal_agent|system,
  representedHumanId?, assistedBy?, delegationId?,
  identityProvider, originSystem, correlationId,
  source: live|demo|synthetic, worldId?, branchId?
}
Delivery/Receipt { messageId, participantId, deliveredAt, readAt }
Draft { id, authorHumanId, assistedBy, text, status: open|published|discarded }
Delegation { id, humanId, agentId, scope{conversations,tools,timeWindow}, expiresAt, revokedAt? }
```

Rule: a message *written by an agent for a human* is never stored with `actorType=human`.

## 4. Work model (Prompts 05, 11, 14)

```
WorkItem { workItemId, organizationId, entityId, type, source(origin ref), payloadRef,
           status: received|classified|authorized|queued|running|needs_review|escalated|completed|failed|cancelled,
           ownerParticipantId, policyDecisionId, riskClass, correlationId, workflowId, dedupeKey UNIQUE,
           createdAt, dueAt, scope(WorldScope) }
Task      { taskId, workItemId?, caseId?, assigneeId, status, dueAt, parentTaskId? }
Handoff   { handoffId, taskId, fromId, toId, backupId?, status: requested|accepted|rejected|in_progress|completed|failed|escalated,
            requestId (stable), requestedAt, acceptedAt?, dueAt, ackEventId?, resultRef? }
PolicyDecision { id, workItemId, policyVersionId, inputs(hash), outcome: auto|review|human|deny, reasons[], decidedAt }
```

Ownership split (plan C.6): row status = *business status* (Work Service); position inside the process, timers and retries = Temporal workflow `wi:<id>`; agent LLM state = Pi. A Temporal signal updates a row; rows never contain workflow internals.

**Handoff semantics**: `requested` ≠ received ≠ understood ≠ done. UI text must say "acknowledged", never "understood".

## 5. Case & knowledge (Prompt 05)

```
Case { caseId, organizationId, title, status, ownerId, ticketRef?, createdFrom }
CaseFact { factId, caseId, statement, sourceRefs[], observedAt, confidence: confirmed|reported|inferred|unverified,
           supersedes?, status: current|stale|contradicted|retracted }
Decision { decisionId, caseId, statement, madeBy, authorityRef, eventId, state: proposed|decided|executed|reversed }
```

`CaseContext` = deterministic projection over events (facts not contradicted, open tasks, owners). Stale = `observedAt` older than a per-fact-type TTL. Private (DM) content never feeds a shared `CaseFact`.

## 6. Event log, outbox, inbox, audit

```
events(sequence PK, eventId UNIQUE, tenantId, organizationId, scope, type, schemaVersion, actorId,
       correlationId, causationId, sourceRefs, visibilityPolicyId, occurredAt, payload)
outbox(eventId, destination, status, attempts, nextAttemptAt)
inbox(consumer, eventId, processedAt)  PRIMARY KEY (consumer, eventId)
audit(id, at, tenantId, actorId, actorType, action, subject, decisionRef, prevHash, hash)   -- append-only, hash chained
```

`sequence` doubles as the SSE event id (resume). `EventEnvelope` fields match plan section C.

## 7. World model (Prompts 06-08, 15)

```
World { worldId, name, domain, referenceOrg, createdFromSnapshot? }
Branch { branchId, worldId, parentBranchId?, forkSequence?, createdAt }
WorldEvent { branchId, sequence, type, payload, virtualTime }   -- append-only, reducer-versioned
Snapshot { snapshotId, branchId, lastEventSequence, virtualTime, schemaVersion, reducerVersion, rngState, stateHash, data (immutable) }
RecordedResponse { branchId, key(hash of request), response, kind: llm|tool }   -- for recorded replay
GroundTruthState vs BeliefState(actorId): separate tables; noise only writes BeliefState/observations
NoiseProfile / PerturbationSchedule: type, params, seed, targets
```

Branch isolation: agent conversations and memory trees in a branch are keyed `(branchId, agentId)`; memory is **copied lazily** from the snapshot (copy-on-write), never shared.

## 8. Migration from the current schema

1. Introduce `schema_migrations` and a runner; wrap the existing `CREATE TABLE IF NOT EXISTS` blocks as migration `0001_baseline` without altering them.
2. Add `tenants`, `organizations`, `participants`; create **default tenant + demo organization** and seed participants from `AGENTS` + Keycloak users on first login.
3. Add columns to `messages`/`approvals`/`audit` (`tenant_id`, `organization_id`, provenance, `requested_by`, `source`) with defaults pointing to the default tenant/org; backfill by SQL.
4. Store `decided_by_sub` next to `decided_by` (name) in `approvals`; stop writing names as identity.
5. Move in-memory limiters to a `rate_counters` table.
6. Flip repositories to require `ActorRef`; the default org makes the demo behave identically.

Rollback: each migration is additive; flags off = old code paths unused. Postgres move: ADR-0001.
