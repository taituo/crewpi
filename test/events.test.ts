import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-events-"));
process.env.SESSION_SECRET = "test-secret";

const { migrate } = await import("../src/migrate.ts");
const { MIGRATIONS } = await import("../src/migrations.ts");
const { EventBus, tx } = await import("../src/work/events.ts");

function fresh() {
	const db = new DatabaseSync(":memory:");
	migrate(db, MIGRATIONS);
	return { db, bus: new EventBus(db) };
}
const ev = (type = "t.one", extra: object = {}) => ({ type, actorId: "alice", actorType: "human" as const, correlationId: "c1", visibility: "channel:general" as const, channelId: "general", ...extra });

test("an event and the state change that caused it succeed or fail together", () => {
	const { db, bus } = fresh();
	bus.register({ name: "a", types: () => true, handle: () => {} });
	db.exec("CREATE TABLE thing (n INTEGER)");
	assert.throws(() => tx(db, () => { db.exec("INSERT INTO thing VALUES (1)"); bus.emit(ev()); throw new Error("crash after emit"); }));
	assert.equal((db.prepare("SELECT COUNT(*) n FROM thing").get() as any).n, 0);
	assert.equal((db.prepare("SELECT COUNT(*) n FROM events").get() as any).n, 0, "no event for a change that did not happen");
	assert.equal((db.prepare("SELECT COUNT(*) n FROM outbox").get() as any).n, 0);
	tx(db, () => { db.exec("INSERT INTO thing VALUES (1)"); bus.emit(ev()); });
	assert.equal((db.prepare("SELECT COUNT(*) n FROM events").get() as any).n, 1);
	assert.equal(bus.pending(), 1);
});

test("the envelope carries lineage, scope and visibility", () => {
	const { bus } = fresh();
	bus.register({ name: "a", types: () => true, handle: () => {} });
	const e = bus.emit(ev("x.y", { causationId: "evt_prev", sourceRefs: ["message:7"], scope: { mode: "synthetic", worldId: "w1", branchId: "b2" }, visibility: "owner:alice" }));
	assert.deepEqual([e.scope, e.worldId, e.branchId, e.schemaVersion, e.causationId, e.sourceRefs, e.visibility], ["synthetic", "w1", "b2", 1, "evt_prev", ["message:7"], "owner:alice"]);
	assert.ok(e.eventId.startsWith("evt_") && e.sequence > 0 && e.occurredAt > 0);
});

test("each destination gets the event, and a consumer sees it once even if delivery is repeated", async () => {
	const { db, bus } = fresh();
	const seen: string[] = [];
	bus.register({ name: "dispatch", types: (t) => t.startsWith("handoff."), handle: (e) => { seen.push(`dispatch:${e.type}`); } });
	bus.register({ name: "case", types: () => true, handle: (e) => { seen.push(`case:${e.type}`); } });
	const e = bus.emit(ev("handoff.requested"));
	bus.emit(ev("note.added"));
	await bus.drain();
	assert.deepEqual(seen.sort(), ["case:handoff.requested", "case:note.added", "dispatch:handoff.requested"]);
	// crash after the consumer finished but before the outbox row was marked done: the row is pending again
	db.prepare("UPDATE outbox SET status = 'pending', next_attempt_at = 0 WHERE event_id = ?").run(e.eventId);
	await bus.drain();
	assert.equal(seen.length, 3, "the inbox stopped the second execution");
	assert.equal(bus.pending(), 0);
});

test("a failing consumer is retried with back-off and then marked failed, without blocking the others", async () => {
	const { db, bus } = fresh();
	let tries = 0, ok = 0;
	bus.maxAttempts = 3;
	bus.register({ name: "bad", types: () => true, handle: () => { tries++; throw new Error("boom"); } });
	bus.register({ name: "good", types: () => true, handle: () => { ok++; } });
	bus.emit(ev());
	await bus.relayOnce();
	assert.deepEqual([tries, ok], [1, 1]);
	assert.equal(await bus.relayOnce(), 0, "not due yet: back-off");
	await bus.drain();
	assert.equal(tries, 3);
	const bad = db.prepare("SELECT status, attempts, last_error FROM outbox WHERE destination = 'bad'").get() as any;
	assert.deepEqual([bad.status, bad.attempts, bad.last_error], ["failed", 3, "boom"]);
	assert.equal(ok, 1, "the healthy consumer is not repeated");
});

test("a destination that is not registered in this process waits instead of being lost", async () => {
	const { db, bus } = fresh();
	bus.emit(ev("x", { destinations: ["later"] }));
	await bus.drain();
	assert.equal(bus.pending(), 1);
	let got = 0;
	bus.register({ name: "later", types: () => true, handle: () => { got++; } });
	await bus.drain();
	assert.equal(got, 1);
	void db;
});

test("events can be listed by channel, correlation and time without a consumer", () => {
	const { bus } = fresh();
	bus.emit(ev("a", { correlationId: "x" }));
	bus.emit(ev("b", { correlationId: "y", channelId: "other", visibility: "channel:other" }));
	bus.emit(ev("c", { correlationId: "x" }));
	assert.deepEqual(bus.list({ correlationId: "x" }).map((e) => e.type), ["a", "c"]);
	assert.deepEqual(bus.list({ channelId: "other" }).map((e) => e.type), ["b"]);
	assert.equal(bus.list({ since: Date.now() + 10_000 }).length, 0);
});
