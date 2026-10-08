import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-consumers-"));
process.env.SESSION_SECRET = "test-secret";

await import("../src/channels.ts"); // creates the standing channels
const { db, store } = await import("../src/db.ts");
const { bridge } = await import("../src/hub.ts");
const { bus, handoffs } = await import("../src/work/index.ts");
const { registerWorkConsumers } = await import("../src/work/consumers.ts");
const { escalate } = await import("../src/work/escalation.ts");
const { getOrigin } = await import("../src/work/handoffs.ts");
const { backupFor, informTargets } = await import("../src/org/routing.ts");
const { Registry } = await import("../src/org/registry.ts");
const { migrate } = await import("../src/migrate.ts");
const { MIGRATIONS } = await import("../src/migrations.ts");

registerWorkConsumers();
const sent: any[] = [];
bridge.submitToAgent = async (o: any) => { sent.push(o); return {}; };
const notices = (channel: string) => store.listMessages(channel).filter((m) => m.authorId === "handoffs").map((m) => m.text);
const base = (n: number, extra: object = {}) => ({ requestId: `ask:c${n}`, channelId: "incidents", from: "ops", to: "developer", text: `do thing ${n}`, correlationId: `corr-${n}`, originSub: "kc-alice", requesterDepth: 0, ...extra });

test("dispatch hands the request to the recipient once, records who started the chain, and acknowledges", async () => {
	const { handoff } = handoffs.request(base(1));
	await bus.drain();
	assert.equal(sent.length, 1);
	assert.deepEqual([sent[0].agentId, sent[0].requestId, sent[0].channelId, sent[0].from.id], ["developer", "ask:c1", "incidents", "ops"]);
	assert.equal(handoffs.get(handoff.handoffId)!.status, "accepted");
	const origin = getOrigin(db, "incidents", "developer")!;
	assert.deepEqual([origin.originSub, origin.depth, origin.handoffId, origin.correlationId], ["kc-alice", 1, handoff.handoffId, "corr-1"]);
	// the event is delivered again (a crash before the outbox row was marked): the inbox stops a second submit
	db.prepare("UPDATE outbox SET status = 'pending', next_attempt_at = 0 WHERE destination = 'dispatch'").run();
	await bus.drain();
	assert.equal(sent.length, 1);
});

test("a recipient that cannot be reached is retried, not lost, and the handoff stays requested", async () => {
	const before = sent.length;
	let fail = true;
	bridge.submitToAgent = async (o: any) => { if (fail) throw new Error("runtime not ready"); sent.push(o); return {}; };
	const { handoff } = handoffs.request(base(2));
	await bus.relayOnce();
	assert.equal(handoffs.get(handoff.handoffId)!.status, "requested");
	assert.match((db.prepare("SELECT last_error e FROM outbox WHERE destination='dispatch' AND status='pending'").get() as any).e, /runtime not ready/);
	fail = false;
	await bus.drain();
	assert.equal(sent.length, before + 1);
	assert.equal(handoffs.get(handoff.handoffId)!.status, "accepted");
	bridge.submitToAgent = async (o: any) => { sent.push(o); return {}; };
});

test("escalation re-asks the backup once, keeps the chain's origin, and the channel is told", async () => {
	const { handoff } = handoffs.request(base(3, { backup: "reviewer", text: "check the pool size" }));
	await bus.drain();
	const r1 = escalate(handoffs, handoff.handoffId, "not acknowledged in time");
	assert.equal(r1.handoff.status, "escalated");
	assert.equal(r1.rerouted!.to, "reviewer");
	assert.equal(r1.rerouted!.originSub, "kc-alice");
	assert.equal(r1.rerouted!.parentHandoffId, handoff.handoffId);
	assert.equal(r1.rerouted!.backup, null, "a backup has no backup: no loops");
	assert.equal(r1.rerouted!.requestId, `${handoff.requestId}:esc`);
	const again = escalate(handoffs, handoff.handoffId, "overdue");
	assert.equal(again.rerouted, null, "escalating twice does nothing the second time");
	assert.equal(handoffs.list({ channelId: "incidents" }).filter((h) => h.parentHandoffId === handoff.handoffId).length, 1);
	await bus.drain();
	assert.ok(sent.some((s) => s.agentId === "reviewer" && /escalated: not acknowledged/.test(s.text)), "the backup received the request");
	assert.ok(notices("incidents").some((t) => /did not handle "check the pool size".*Asked @reviewer instead/.test(t)));
});

test("with no backup the task is escalated to people: the channel says so, and private chats get nothing", async () => {
	const { handoff } = handoffs.request(base(4, { text: "no backup for this" }));
	await bus.drain();
	escalate(handoffs, handoff.handoffId, "overdue");
	await bus.drain();
	assert.ok(notices("incidents").some((t) => /no backup for this.*a person needs to look/.test(t)));
	// a handoff row can never put chatter into a private chat
	db.prepare("INSERT INTO channels (id, name, topic, kind, agents, created_by, created_at, owner) VALUES ('dm-test','T','','dm','[\"ops\"]','t',1,'u1')").run();
	const dm = handoffs.request(base(5, { channelId: "dm-test", text: "secret errand" })).handoff;
	await bus.drain();
	escalate(handoffs, dm.handoffId, "overdue");
	await bus.drain();
	assert.deepEqual(notices("dm-test"), []);
});

test("routing reads the organization graph: backups from substitutes_for, rooms from must_inform", () => {
	const d = new DatabaseSync(":memory:");
	migrate(d, MIGRATIONS);
	const reg = new Registry(d);
	const op = { tenantId: "default", participantId: "p", platformRoles: [], operator: true };
	const ops = reg.ensureParticipant("default", "internal_agent", "ops", "Ops"), dev = reg.ensureParticipant("default", "internal_agent", "developer", "Dev");
	const { versionId } = reg.createOrg(op, { name: "Routing Org", id: "default2" });
	assert.equal(backupFor(d, "ops", "default2"), null, "nothing adopted yet");
	reg.applyOps(op, "default2", versionId, [
		...["Ops", "Standby", "general", "production"].map((n) => ({ op: "addNode", kind: "team", name: n }) as const),
		{ op: "addEdge", type: "substitutes_for", from: "team:Standby", to: "team:Ops" },
		{ op: "addEdge", type: "must_inform", from: "team:Ops", to: "team:production" },
		{ op: "addMember", participant: ops, node: "team:Ops" }, { op: "addMember", participant: dev, node: "team:Standby" },
	]);
	reg.adopt(op, "default2", versionId);
	assert.equal(backupFor(d, "ops", "default2"), "developer");
	assert.equal(backupFor(d, "developer", "default2"), null, "a substitute is not itself covered");
	assert.deepEqual(informTargets(d, "ops", "default2"), ["production"]);
	assert.deepEqual(informTargets(d, "developer", "default2"), []);
});
