import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-handoffs-"));
process.env.SESSION_SECRET = "test-secret";
process.env.MAX_DELEGATIONS = "5";

const { migrate } = await import("../src/migrate.ts");
const { MIGRATIONS } = await import("../src/migrations.ts");
const { EventBus } = await import("../src/work/events.ts");
const { HandoffService, HandoffError, setOrigin, getOrigin } = await import("../src/work/handoffs.ts");

function fresh() {
	const db = new DatabaseSync(":memory:");
	migrate(db, MIGRATIONS);
	const bus = new EventBus(db);
	return { db, bus, svc: new HandoffService(bus) };
}
const req = (n: number, extra: object = {}) => ({ requestId: `ask:t${n}`, channelId: "incidents", from: "ops", to: "developer", text: `please fix thing ${n}`, correlationId: "corr-1", ...extra });

test("the same request twice is one handoff, one task and one event", () => {
	const { db, svc } = fresh();
	const a = svc.request(req(1));
	const b = svc.request(req(1));
	assert.equal(a.created, true);
	assert.equal(b.created, false);
	assert.equal(b.handoff.handoffId, a.handoff.handoffId);
	for (const t of ["handoffs", "tasks", "events"]) assert.equal((db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n, 1, t);
});

test("sent, acknowledged, in progress and done are separate transitions with their own events", () => {
	const { db, svc } = fresh();
	const { handoff } = svc.request(req(1));
	assert.equal(handoff.status, "requested");
	svc.accept(handoff.handoffId, "runtime");
	svc.start(handoff.handoffId, "runtime");
	const done = svc.complete(handoff.handoffId, "runtime", "message:42");
	assert.equal(done.handoff.status, "completed");
	assert.equal(done.handoff.resultRef, "message:42");
	assert.ok(done.handoff.ackEventId, "the acknowledgement is itself an event");
	const types = (db.prepare("SELECT type FROM events ORDER BY sequence").all() as any[]).map((r) => r.type);
	assert.deepEqual(types, ["handoff.requested", "handoff.accepted", "handoff.in_progress", "handoff.completed"]);
	assert.equal((db.prepare("SELECT status FROM tasks").get() as any).status, "done", "completing the handoff completes its task");
	// every event of the chain shares the correlation id and points back to the request
	const chain = db.prepare("SELECT correlation_id c, causation_id k FROM events ORDER BY sequence").all() as any[];
	assert.ok(chain.every((e) => e.c === "corr-1"));
	assert.ok(chain.slice(1).every((e) => e.k === (db.prepare("SELECT event_id FROM events ORDER BY sequence LIMIT 1").get() as any).event_id));
});

test("repeated and out-of-date signals change nothing; people get an error for illegal moves", () => {
	const { db, svc } = fresh();
	const { handoff } = svc.request(req(1));
	svc.accept(handoff.handoffId, "runtime");
	const again = svc.accept(handoff.handoffId, "runtime");
	assert.equal(again.changed, false);
	svc.complete(handoff.handoffId, "runtime");
	assert.equal(svc.start(handoff.handoffId, "runtime").changed, false, "a late 'started' after completion is ignored");
	assert.equal(svc.get(handoff.handoffId)!.status, "completed");
	assert.throws(() => svc.cancel(handoff.handoffId, "alice"), (e: any) => e instanceof HandoffError && e.status === 409);
	assert.equal((db.prepare("SELECT COUNT(*) n FROM events").get() as any).n, 3, "no events for ignored signals");
});

test("rejection and failure can be escalated; escalated is final", () => {
	const { svc } = fresh();
	const a = svc.request(req(1)).handoff;
	svc.reject(a.handoffId, "developer", "not my area");
	assert.equal(svc.get(a.handoffId)!.reason, "not my area");
	assert.equal(svc.transition(a.handoffId, "escalated", { by: "workflow", byType: "workflow", reason: "rejected" }).handoff.status, "escalated");
	assert.equal(svc.transition(a.handoffId, "completed", { by: "runtime" }).changed, false);
	const b = svc.request(req(2)).handoff;
	svc.accept(b.handoffId, "r"); svc.fail(b.handoffId, "r", "model error");
	assert.equal(svc.transition(b.handoffId, "escalated", { by: "workflow", byType: "workflow" }).changed, true);
});

test("limits are rows, not memory: depth, duplicates and rate hold across a restart", () => {
	const { db, svc } = fresh();
	assert.throws(() => svc.request(req(1, { requesterDepth: 3 })), (e: any) => e.status === 429 && /depth limit/.test(e.message));
	svc.request(req(2));
	assert.throws(() => svc.request(req(3, { text: "  PLEASE fix thing 2 " })), (e: any) => e.status === 409 && /already asked/.test(e.message));
	for (let i = 10; i < 14; i++) svc.request(req(i));
	assert.throws(() => svc.request(req(20)), (e: any) => e.status === 429 && /delegation limit/.test(e.message));
	// a "restart": a new service over the same database sees the same limits
	const again = new HandoffService(new EventBus(db));
	assert.throws(() => again.request(req(21)), (e: any) => e.status === 429);
	// a rejected request can be asked again
	const r = again.list({ statuses: ["requested"] })[0];
	again.reject(r.handoffId, "developer", "busy");
	assert.throws(() => again.request(req(22, { text: "something new" })), /delegation limit/, "the rate counts requests, not outcomes");
});

test("origin of a conversation is stored, so the human who started a chain is known later", () => {
	const { db } = fresh();
	assert.equal(getOrigin(db, "incidents", "ops"), undefined);
	setOrigin(db, { channelId: "incidents", agentId: "ops", originSub: "kc-alice", correlationId: "c9", depth: 0, handoffId: null });
	setOrigin(db, { channelId: "incidents", agentId: "developer", originSub: "kc-alice", correlationId: "c9", depth: 1, handoffId: "hand_x" });
	assert.equal(getOrigin(db, "incidents", "developer")!.depth, 1);
	assert.equal(getOrigin(db, "incidents", "developer")!.originSub, "kc-alice");
});
