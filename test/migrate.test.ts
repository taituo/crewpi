import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-migrate-"));
process.env.SESSION_SECRET = "test-secret";

const { migrate, hasColumn } = await import("../src/migrate.ts");
const { MIGRATIONS } = await import("../src/migrations.ts");

// The schema exactly as the audited prototype (873a01a) created it, plus a few rows.
const OLD_SCHEMA = `
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, author_kind TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX messages_channel ON messages(channel_id, id);
CREATE TABLE convs (channel_id TEXT NOT NULL, agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL, current_message INTEGER, PRIMARY KEY (channel_id, agent_id));
CREATE TABLE approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, agent_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, note TEXT, created_at INTEGER NOT NULL, decided_at INTEGER);
CREATE TABLE attachments (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, owner TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}');
INSERT INTO messages (channel_id, author_kind, author_id, author_name, text, created_at, updated_at) VALUES ('general','human','dev-bob','Bob','hello',1,1);
INSERT INTO approvals (channel_id, agent_id, task_id, title, status, decided_by, created_at) VALUES ('incidents','ops','t-old','Apply x','approved','Alice',1);
INSERT INTO audit (at, actor, action) VALUES (1,'user:Alice','approval.approved');`;

test("a database made by the audited build is adopted, backfilled and keeps its rows", () => {
	const db = new DatabaseSync(":memory:");
	db.exec(OLD_SCHEMA);
	assert.deepEqual(migrate(db, MIGRATIONS), [1, 2, 3]);
	const m = db.prepare("SELECT * FROM messages").get() as any;
	assert.equal(m.text, "hello");
	assert.equal(m.tenant_id, "default");
	assert.equal(m.organization_id, "default");
	assert.equal(m.source, "live");
	assert.equal(m.actor_id, null, "old rows have no server-resolved actor");
	const a = db.prepare("SELECT * FROM approvals").get() as any;
	assert.equal(a.decided_by, "Alice");
	assert.equal(a.decided_by_sub, null);
	assert.equal(a.tenant_id, "default");
	assert.ok(hasColumn(db, "audit", "actor_id"));
	assert.equal((db.prepare("SELECT COUNT(*) n FROM entities e JOIN business_realms r ON r.id = e.realm_id WHERE e.id='default'").get() as any).n, 1);
	assert.equal((db.prepare("SELECT COUNT(*) n FROM organizations WHERE id='default' AND tenant_id='default'").get() as any).n, 1);
});

test("a fresh database reaches the same schema as an upgraded one, and re-running does nothing", () => {
	const fresh = new DatabaseSync(":memory:");
	assert.deepEqual(migrate(fresh, MIGRATIONS), [1, 2, 3]);
	assert.deepEqual(migrate(fresh, MIGRATIONS), []);
	const old = new DatabaseSync(":memory:");
	old.exec(OLD_SCHEMA);
	migrate(old, MIGRATIONS);
	const cols = (db: DatabaseSync, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name).sort();
	for (const t of ["messages", "approvals", "audit"]) assert.deepEqual(cols(fresh, t), cols(old, t), t);
});

test("a failing migration rolls back completely and is not recorded", () => {
	const db = new DatabaseSync(":memory:");
	migrate(db, [MIGRATIONS[0]]);
	const bad = { version: 99, name: "bad", up: (d: DatabaseSync) => { d.exec("CREATE TABLE half (x INTEGER)"); throw new Error("boom"); } };
	assert.throws(() => migrate(db, [MIGRATIONS[0], bad]), /migration 99 \(bad\) failed: boom/);
	assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='half'").get(), undefined);
	assert.equal(db.prepare("SELECT version FROM schema_migrations WHERE version=99").get(), undefined);
});

test("a database from a newer build is refused instead of being mangled", () => {
	const db = new DatabaseSync(":memory:");
	migrate(db, [...MIGRATIONS, { version: 4, name: "future", up: () => {} }]);
	assert.throws(() => migrate(db, MIGRATIONS), /does not know/);
});

test("approvals record the decider's stable subject, not only the display name", async () => {
	const { store } = await import("../src/db.ts");
	const a = store.openApproval({ channelId: "c", agentId: "ops", taskId: "t-sub", title: "x", detail: {} });
	const d = store.decideApproval(a.approval.id, "approved", "Alice (approver)", null, "kc-sub-123");
	assert.equal(d?.decidedBy, "Alice (approver)");
	assert.equal(d?.decidedBySub, "kc-sub-123");
	assert.equal(store.decideApproval(a.approval.id, "rejected", "Mallory", null, "other"), undefined, "first decision still wins");
	assert.equal(store.getApproval(a.approval.id)?.decidedBySub, "kc-sub-123");
});

test("messages get a server-side actor and live source; audit keeps the actor id", async () => {
	const { store } = await import("../src/db.ts");
	const h = store.addMessage({ channelId: "general", authorKind: "human", authorId: "kc-sub-9", authorName: "Bo", text: "hi" });
	const g = store.addMessage({ channelId: "general", authorKind: "agent", authorId: "ops", authorName: "Ops", text: "yo" });
	const s = store.addMessage({ channelId: "general", authorKind: "system", authorId: "system", authorName: "System", text: "n" });
	assert.deepEqual([h.actorType, g.actorType, s.actorType], ["human", "internal_agent", "system"]);
	assert.equal(h.actorId, "kc-sub-9");
	assert.equal(h.source, "live");
	assert.equal(h.tenantId, "default");
	store.audit("user:Bo", "x.y", {}, "kc-sub-9");
	assert.equal(store.listAudit(1)[0].actorId, "kc-sub-9");
});

test("the server refuses to start in OIDC mode with the built-in session secret", () => {
	const run = (env: Record<string, string>) =>
		execFileSync(process.execPath, ["-e", 'import("./src/config.ts").then((m) => { m.assertSafeConfig(); console.log("ok"); })'], { env: { PATH: process.env.PATH!, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	assert.throws(() => run({ AUTH_MODE: "oidc" }), /SESSION_SECRET must be set/);
	assert.match(run({ AUTH_MODE: "oidc", SESSION_SECRET: "x".repeat(32) }), /ok/);
	assert.match(run({ AUTH_MODE: "dev" }), /ok/);
});
