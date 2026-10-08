import type { Migration } from "./migrate.ts";
import { addColumn } from "./migrate.ts";

export const DEFAULT_TENANT = "default";
export const DEFAULT_ORG = "default";

/**
 * 1 baseline: the tables of the audited prototype (873a01a), unchanged. Written with IF NOT EXISTS so that a
 *   database created by that build is simply adopted as version 1.
 * 2 tenant/org: the default tenant and organization, and the columns later prompts build on. Existing rows are
 *   backfilled by the column defaults, so the demo behaves exactly as before.
 */
export const MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "baseline",
		up: (db) =>
			db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, author_kind TEXT NOT NULL, author_id TEXT NOT NULL,
  author_name TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id);
CREATE TABLE IF NOT EXISTS convs (
  channel_id TEXT NOT NULL, agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL, current_message INTEGER,
  PRIMARY KEY (channel_id, agent_id));
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, agent_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT, note TEXT, created_at INTEGER NOT NULL, decided_at INTEGER);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  owner TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}');`),
	},
	{
		version: 2,
		name: "tenant-org-provenance",
		up: (db) => {
			db.exec(`
CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, created_at INTEGER NOT NULL);`);
			db.prepare("INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?,?,?)").run(DEFAULT_TENANT, "Default tenant", Date.now());
			db.prepare("INSERT OR IGNORE INTO organizations (id, tenant_id, name, created_at) VALUES (?,?,?,?)").run(DEFAULT_ORG, DEFAULT_TENANT, "Default organization", Date.now());
			const scope = [["tenant_id", `TEXT NOT NULL DEFAULT '${DEFAULT_TENANT}'`], ["organization_id", `TEXT NOT NULL DEFAULT '${DEFAULT_ORG}'`]];
			for (const t of ["messages", "approvals", "audit"]) for (const [c, d] of scope) addColumn(db, t, c, d);
			// Provenance (nullable on purpose: rows from before this migration have no server-resolved actor).
			addColumn(db, "messages", "actor_id", "TEXT");
			addColumn(db, "messages", "actor_type", "TEXT");
			addColumn(db, "messages", "source", "TEXT NOT NULL DEFAULT 'live'");
			// Approvals: identity by stable subject, not by display name.
			addColumn(db, "approvals", "requested_by_sub", "TEXT");
			addColumn(db, "approvals", "decided_by_sub", "TEXT");
			addColumn(db, "audit", "actor_id", "TEXT");
			db.exec("CREATE INDEX IF NOT EXISTS messages_org ON messages(tenant_id, organization_id, channel_id, id)");
		},
	},
	{
		version: 3,
		name: "realm-entity",
		up: (db) => {
			// Prompt 13 names a default realm and one entity for the migrated single-org install. BusinessRealm is a
			// product grouping, not a Keycloak realm, and says nothing about who may see what.
			db.exec(`
CREATE TABLE IF NOT EXISTS business_realms (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), realm_id TEXT NOT NULL REFERENCES business_realms(id),
  name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'organization', created_at INTEGER NOT NULL);`);
			db.prepare("INSERT OR IGNORE INTO business_realms (id, tenant_id, name, created_at) VALUES (?,?,?,?)").run("default", DEFAULT_TENANT, "Default realm", Date.now());
			db.prepare("INSERT OR IGNORE INTO entities (id, tenant_id, realm_id, name, created_at) VALUES (?,?,?,?,?)").run("default", DEFAULT_TENANT, "default", "Default entity", Date.now());
			addColumn(db, "organizations", "entity_id", "TEXT NOT NULL DEFAULT 'default'");
		},
	},
	{
		version: 4,
		name: "org-registry",
		up: (db) => {
			addColumn(db, "organizations", "current_version_id", "TEXT");
			addColumn(db, "organizations", "created_by", "TEXT");
			// Participants are tenant-level actors; versions describe how they are arranged.
			db.exec(`
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL CHECK (kind IN ('human','assistant_agent','internal_agent','external_agent','service')),
  name TEXT NOT NULL, external_ref TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS participants_ref ON participants(tenant_id, kind, external_ref);
CREATE TABLE IF NOT EXISTS org_versions (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), tenant_id TEXT NOT NULL,
  number INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('draft','adopted','archived')),
  parent_version_id TEXT, note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, adopted_at INTEGER,
  UNIQUE (organization_id, number));
CREATE TABLE IF NOT EXISTS org_nodes (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES org_versions(id), tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('team','role','capability','system','external_party')),
  name TEXT NOT NULL, attrs TEXT NOT NULL DEFAULT '{}', UNIQUE (version_id, kind, name));
CREATE TABLE IF NOT EXISTS org_edges (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES org_versions(id), tenant_id TEXT NOT NULL,
  from_node TEXT NOT NULL REFERENCES org_nodes(id), to_node TEXT NOT NULL REFERENCES org_nodes(id),
  type TEXT NOT NULL, class TEXT NOT NULL CHECK (class IN ('descriptive','authoritative')),
  granted_by TEXT, valid_to INTEGER, policy_version_id TEXT, created_at INTEGER NOT NULL,
  UNIQUE (version_id, from_node, to_node, type));
CREATE TABLE IF NOT EXISTS org_memberships (
  version_id TEXT NOT NULL REFERENCES org_versions(id), tenant_id TEXT NOT NULL,
  participant_id TEXT NOT NULL REFERENCES participants(id), node_id TEXT NOT NULL REFERENCES org_nodes(id),
  role TEXT NOT NULL DEFAULT 'member', valid_from INTEGER, valid_to INTEGER, PRIMARY KEY (version_id, participant_id, node_id));
CREATE TABLE IF NOT EXISTS org_agent_configs (
  version_id TEXT NOT NULL REFERENCES org_versions(id), tenant_id TEXT NOT NULL,
  participant_id TEXT NOT NULL REFERENCES participants(id), model TEXT, instructions TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (version_id, participant_id));
CREATE TABLE IF NOT EXISTS org_policies (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES org_versions(id), tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL, UNIQUE (version_id, kind, name));
CREATE INDEX IF NOT EXISTS org_nodes_v ON org_nodes(version_id);
CREATE INDEX IF NOT EXISTS org_edges_v ON org_edges(version_id);`);
		},
	},
	{
		version: 5,
		name: "events-handoffs-case",
		up: (db) => {
			db.exec(`
CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT 'default', organization_id TEXT NOT NULL DEFAULT 'default',
  scope TEXT NOT NULL DEFAULT 'live', world_id TEXT, branch_id TEXT,
  type TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
  actor_id TEXT NOT NULL, actor_type TEXT NOT NULL, correlation_id TEXT NOT NULL, causation_id TEXT,
  source_refs TEXT NOT NULL DEFAULT '[]', visibility TEXT NOT NULL, channel_id TEXT,
  occurred_at INTEGER NOT NULL, payload TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS events_channel ON events(channel_id, sequence);
CREATE INDEX IF NOT EXISTS events_correlation ON events(correlation_id);
CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT NOT NULL REFERENCES events(event_id), destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  PRIMARY KEY (event_id, destination));
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS inbox (
  consumer TEXT NOT NULL, event_id TEXT NOT NULL, processed_at INTEGER NOT NULL, PRIMARY KEY (consumer, event_id));
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default', organization_id TEXT NOT NULL DEFAULT 'default',
  channel_id TEXT NOT NULL, title TEXT NOT NULL, owner TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  due_at INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_channel ON tasks(channel_id, status);
CREATE TABLE IF NOT EXISTS handoffs (
  handoff_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT 'default', organization_id TEXT NOT NULL DEFAULT 'default',
  channel_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(task_id),
  from_actor TEXT NOT NULL, to_actor TEXT NOT NULL, backup_actor TEXT, text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','accepted','rejected','in_progress','completed','failed','escalated','cancelled')),
  depth INTEGER NOT NULL DEFAULT 1, parent_handoff_id TEXT, origin_sub TEXT, correlation_id TEXT NOT NULL, causation_id TEXT,
  ack_by_at INTEGER, due_at INTEGER, requested_event_id TEXT, ack_event_id TEXT, result_ref TEXT, reason TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS handoffs_channel ON handoffs(channel_id, status);
CREATE INDEX IF NOT EXISTS handoffs_recipient ON handoffs(channel_id, to_actor, status);
CREATE TABLE IF NOT EXISTS conv_origin (
  channel_id TEXT NOT NULL, agent_id TEXT NOT NULL, origin_sub TEXT, correlation_id TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0, handoff_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (channel_id, agent_id));
CREATE TABLE IF NOT EXISTS case_facts (
  fact_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'default', fact_key TEXT NOT NULL, statement TEXT NOT NULL,
  source_refs TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL CHECK (confidence IN ('confirmed','reported','inferred','unverified')),
  status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','superseded','retracted')),
  supersedes TEXT, added_by TEXT NOT NULL, observed_at INTEGER NOT NULL, created_at INTEGER NOT NULL, event_id TEXT);
CREATE INDEX IF NOT EXISTS case_facts_case ON case_facts(case_id, status);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'default', decision_key TEXT NOT NULL, statement TEXT NOT NULL,
  outcome TEXT NOT NULL, made_by TEXT NOT NULL, authority_ref TEXT, approval_id INTEGER, event_id TEXT,
  state TEXT NOT NULL DEFAULT 'decided' CHECK (state IN ('proposed','decided','executed','reversed')), created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS decisions_case ON decisions(case_id);`);
		},
	},
];
