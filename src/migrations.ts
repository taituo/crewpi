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
];
