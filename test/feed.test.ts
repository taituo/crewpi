import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-feed-"));
process.env.SESSION_SECRET = "test-secret";
process.env.ATTENTION_BUDGET = "20";

const { store } = await import("../src/db.ts");
const { hub } = await import("../src/hub.ts");
const { changesSince, latestSequence, prune } = await import("../src/feed.ts");
const { attentionFor, ATTENTION_COST } = await import("../src/attention.ts");

class FakeRes {
	out = "";
	write(s: string) { this.out += s; return true; }
	on() { return this; }
}
const ids = (r: FakeRes) => [...r.out.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));

test("published message/approval changes get increasing ids on the wire", () => {
	const live = new FakeRes();
	hub.add(live as any, "u1");
	const m = store.addMessage({ channelId: "general", authorKind: "human", authorId: "u2", authorName: "Bo", text: "one" });
	hub.publish({ type: "message", message: m });
	hub.publish({ type: "presence", presence: [] });
	const m2 = store.addMessage({ channelId: "general", authorKind: "human", authorId: "u2", authorName: "Bo", text: "two" });
	hub.publish({ type: "message", message: m2 });
	const got = ids(live);
	assert.equal(got.length, 2, "presence is ephemeral and has no id");
	assert.ok(got[1] > got[0]);
	assert.match(live.out, /event: presence/);
});

test("a reconnecting client gets only what changed, each entity once, in its current state", () => {
	const m = store.addMessage({ channelId: "general", authorKind: "agent", authorId: "ops", authorName: "Ops", text: "draft" });
	hub.publish({ type: "message", message: m });
	const seen = latestSequence();
	// the same message is updated three times (streaming) and another one is added while the client is away
	for (const t of ["a", "ab", "abc"]) hub.publish({ type: "message", message: store.updateMessage(m.id, { text: t })! });
	const other = store.addMessage({ channelId: "general", authorKind: "human", authorId: "u2", authorName: "Bo", text: "later" });
	hub.publish({ type: "message", message: other });
	const back = new FakeRes();
	hub.add(back as any, "u1", seen);
	const msgs = [...back.out.matchAll(/^data: (.*)$/gm)].map((x) => JSON.parse(x[1]).message);
	assert.deepEqual(msgs.map((x) => x.text), ["abc", "later"]);
	assert.equal(changesSince(latestSequence()).length, 0, "nothing after the latest id");
});

test("private chats are not replayed to other users", () => {
	const dm = store.addMessage({ channelId: "dm-secret", authorKind: "human", authorId: "owner", authorName: "O", text: "private" });
	hub.setVisibility((sub, ch) => ch !== "dm-secret" || sub === "owner", () => []);
	const before = latestSequence();
	hub.publish({ type: "message", message: dm });
	const other = new FakeRes(), owner = new FakeRes();
	hub.add(other as any, "intruder", before - 1);
	hub.add(owner as any, "owner", before - 1);
	assert.doesNotMatch(other.out, /private/);
	assert.match(owner.out, /private/);
});

test("a client behind the retention window, or from another database, is told to reset", () => {
	for (let i = 0; i < 30; i++) hub.publish({ type: "message", message: store.addMessage({ channelId: "general", authorKind: "system", authorId: "s", authorName: "S", text: `n${i}` }) });
	prune(latestSequence(), 10);
	assert.equal(changesSince(1), "reset");
	assert.equal(changesSince(latestSequence() + 1000), "reset");
	const r = new FakeRes();
	hub.add(r as any, "u1", 1);
	assert.match(r.out, /event: reset/);
});

test("attention: decisions cost points, the queue counts, the budget is soft", () => {
	const a = store.openApproval({ channelId: "general", agentId: "ops", taskId: "att-1", title: "x", detail: {} });
	const b = store.openApproval({ channelId: "general", agentId: "ops", taskId: "att-2", title: "y", detail: {}, attentionCost: ATTENTION_COST.liveChange });
	assert.equal(attentionFor("alice").queued, 5 + 8);
	assert.equal(attentionFor("alice").over, false);
	store.decideApproval(b.approval.id, "approved", "Alice", null, "alice");
	let s = attentionFor("alice");
	assert.deepEqual([s.spent24h, s.queued, s.waiting], [8, 5, 1]);
	assert.equal(attentionFor("bob").spent24h, 0, "only the decider is charged");
	store.decideApproval(a.approval.id, "rejected", "Alice", null, "alice");
	store.openApproval({ channelId: "general", agentId: "ops", taskId: "att-3", title: "z", detail: {}, attentionCost: 8 });
	s = attentionFor("alice");
	assert.equal(s.spent24h + s.queued, 21);
	assert.equal(s.over, true, "21 > budget 20");
});
