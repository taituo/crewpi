import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-case-"));
process.env.SESSION_SECRET = "test-secret";
process.env.CASE_FACT_TTL_MS = "3600000";

const { migrate } = await import("../src/migrate.ts");
const { MIGRATIONS } = await import("../src/migrations.ts");
const { EventBus } = await import("../src/work/events.ts");
const { HandoffService } = await import("../src/work/handoffs.ts");
const { CaseService, CaseError } = await import("../src/work/case.ts");

function fresh() {
	const db = new DatabaseSync(":memory:");
	migrate(db, MIGRATIONS);
	db.exec("CREATE TABLE channels (id TEXT PRIMARY KEY, kind TEXT NOT NULL)");
	db.exec("INSERT INTO channels VALUES ('inc','issue'), ('dm-1','dm')");
	const bus = new EventBus(db);
	return { db, bus, cases: new CaseService(bus), hand: new HandoffService(bus) };
}
const f = (over: object = {}) => ({ caseId: "inc", key: "checkout.pool_size", statement: "POOL_SIZE is 0", sourceRefs: ["tool:k8s_configmap"], confidence: "confirmed" as const, by: "ops", ...over });

test("a fact needs a key, a statement, a confidence and at least one source", () => {
	const { cases } = fresh();
	assert.throws(() => cases.addFact(f({ sourceRefs: [] })), (e: any) => e instanceof CaseError && /source/.test(e.message));
	assert.throws(() => cases.addFact(f({ sourceRefs: ["  "] })), /source/);
	assert.throws(() => cases.addFact(f({ key: "Bad Key!" })), /key/);
	assert.throws(() => cases.addFact(f({ statement: "x" })), /statement/);
	assert.throws(() => cases.addFact(f({ confidence: "sure" as any })), /confidence/);
	const ok = cases.addFact(f());
	assert.deepEqual([ok.status, ok.confidence, ok.sourceRefs], ["current", "confirmed", ["tool:k8s_configmap"]]);
});

test("the picture separates what is current, stale, unverified and contradictory", () => {
	const { cases } = fresh();
	const now = Date.now(), old = now - 2 * 3600_000;
	cases.addFact(f());
	cases.addFact(f({ key: "checkout.replicas", statement: "2 replicas", observedAt: old, sourceRefs: ["message:3"] }));
	cases.addFact(f({ key: "cause.guess", statement: "probably the pool", confidence: "inferred" }));
	cases.addFact(f({ key: "checkout.owner", statement: "owned by payments", confidence: "unverified", sourceRefs: ["person:bob"] }));
	// two sources disagree about the same topic
	cases.addFact(f({ key: "delivery.date", statement: "delivery on 10 Oct", by: "sales", sourceRefs: ["message:11"] }));
	cases.addFact(f({ key: "delivery.date", statement: "delivery on 14 Oct", by: "production", sourceRefs: ["message:15"] }));
	const c = cases.context("inc");
	assert.deepEqual(c.facts.stale.map((x) => x.key), ["checkout.replicas"], "not re-observed within the TTL");
	assert.deepEqual(c.facts.unverified.map((x) => x.key).sort(), ["cause.guess", "checkout.owner"]);
	assert.equal(c.conflicts.length, 1);
	assert.deepEqual([c.conflicts[0].key, c.conflicts[0].facts.map((x) => x.addedBy).sort()], ["delivery.date", ["production", "sales"]]);
	assert.ok(!c.facts.unverified.some((x) => x.key === "delivery.date"), "a conflict is reported once, as a conflict");
	assert.ok(c.facts.current.some((x) => x.key === "checkout.pool_size"));
	// superseding settles the conflict and keeps the history
	const winner = c.conflicts[0].facts.find((x) => x.addedBy === "production")!;
	const loser = c.conflicts[0].facts.find((x) => x.addedBy === "sales")!;
	cases.addFact(f({ key: "delivery.date", statement: "delivery on 14 Oct", by: "finance", sourceRefs: ["ticket:OPS-1"], supersedes: loser.factId }));
	void winner;
	assert.equal(cases.context("inc").conflicts.length, 0);
	assert.throws(() => cases.addFact(f({ supersedes: "fact_nope" })), (e: any) => e.status === 404);
});

test("decisions are recorded with their authority, and opposite outcomes on one topic are flagged", () => {
	const { cases } = fresh();
	cases.recordDecision({ caseId: "inc", key: "apply configmap:demo-apps/checkout", statement: "Apply checkout config", outcome: "approved", madeBy: "kc-alice", authorityRef: "platform-role:approver", approvalId: 7 });
	assert.deepEqual(cases.context("inc").decisions.conflicting, []);
	cases.recordDecision({ caseId: "inc", key: "apply configmap:demo-apps/checkout", statement: "Apply checkout config", outcome: "rejected", madeBy: "kc-carol" });
	const c = cases.context("inc");
	assert.equal(c.decisions.conflicting.length, 1);
	assert.deepEqual(c.decisions.conflicting[0].decisions.map((d) => d.outcome).sort(), ["approved", "rejected"]);
	assert.equal(c.decisions.all.find((d) => d.approvalId === 7)!.authorityRef, "platform-role:approver");
});

test("who is waiting for whom, and what is nobody's", () => {
	const { cases, hand, db } = fresh();
	const a = hand.request({ requestId: "r1", channelId: "inc", from: "ops", to: "developer", text: "fix pool size", correlationId: "c", dueInMs: 60_000 }).handoff;
	hand.accept(a.handoffId, "rt");
	hand.request({ requestId: "r2", channelId: "inc", from: "ops", to: "reviewer", text: "review later", correlationId: "c" });
	let c = cases.context("inc");
	assert.deepEqual(c.awaiting.map((x) => [x.to, x.status, x.acknowledged]), [["developer", "accepted", true], ["reviewer", "requested", false]], "acknowledged vs only sent");
	assert.equal(c.responsible, "developer");
	assert.deepEqual(c.orphanTasks, []);
	// the developer's handoff is rejected and nobody picks the task up: the open task is now orphaned
	hand.reject(a.handoffId, "developer", "not mine");
	c = cases.context("inc");
	assert.equal(c.orphanTasks.length, 1);
	assert.equal(c.orphanTasks[0].title, "fix pool size");
	// an overdue task is shown as such
	db.prepare("UPDATE tasks SET due_at = ?").run(Date.now() - 1000);
	assert.ok(cases.context("inc").openTasks.every((t) => t.overdue));
});

test("private chats neither receive nor reveal a case picture", () => {
	const { cases } = fresh();
	for (const call of [() => cases.addFact(f({ caseId: "dm-1" })), () => cases.context("dm-1"), () => cases.recordDecision({ caseId: "dm-1", key: "k.k", statement: "x", outcome: "approved", madeBy: "u" })]) {
		assert.throws(call, (e: any) => e instanceof CaseError && e.status === 403);
	}
});

test("every fact and decision is an event with its sources, in the channel's visibility", () => {
	const { cases, bus } = fresh();
	cases.addFact(f({ sourceRefs: ["message:3", "tool:logs"] }));
	cases.recordDecision({ caseId: "inc", key: "a.b", statement: "go", outcome: "approved", madeBy: "kc-alice", approvalId: 3 });
	const evs = bus.list({ channelId: "inc" });
	assert.deepEqual(evs.map((e) => e.type), ["fact.added", "decision.made"]);
	assert.deepEqual(evs[0].sourceRefs, ["message:3", "tool:logs"]);
	assert.deepEqual(evs[1].sourceRefs, ["approval:3"]);
	assert.ok(evs.every((e) => e.visibility === "channel:inc"));
});

test("facts added within the same millisecond come back in a stable order (newest first), and conflicts oldest first", () => {
	const { cases, db } = fresh();
	cases.addFact(f({ key: "delivery.date", statement: "10 Oct", by: "sales", sourceRefs: ["message:1"] }));
	cases.addFact(f({ key: "delivery.date", statement: "14 Oct", by: "production", sourceRefs: ["message:2"] }));
	cases.addFact(f({ key: "other.topic", statement: "something else", sourceRefs: ["message:3"] }));
	db.exec("UPDATE case_facts SET observed_at = 1700000000000, created_at = 1700000000000");
	for (let i = 0; i < 20; i++) {
		const c = cases.context("inc", 1700000000000 + 1000);
		assert.deepEqual(c.facts.current.map((x) => x.statement), ["something else", "14 Oct", "10 Oct"], "newest insert first");
		assert.deepEqual(c.conflicts[0].facts.map((x) => x.addedBy), ["sales", "production"], "a conflict reads in the order it arose");
	}
});
