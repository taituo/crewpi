import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-test-"));
process.env.SESSION_SECRET = "test-secret";

const { parseMentions } = await import("../src/channels.ts");
const { store } = await import("../src/db.ts");
const { safePath, safeRef, initRepo, repo } = await import("../src/repo.ts");

test("mentions only resolve agents present in the channel", () => {
	assert.deepEqual(parseMentions("production", "@ops please look, cc @developer"), ["ops"]);
	assert.deepEqual(parseMentions("incidents", "@Ops @reviewer @nobody @ops").sort(), ["ops", "reviewer"]);
	assert.deepEqual(parseMentions("general", "no mentions, mail me at a@b.c"), []);
});

test("repo path and ref validation rejects traversal and option injection", () => {
	for (const bad of ["../x", "/etc/passwd", ".git/config", "a/../../b", "", "x\0y"]) assert.throws(() => safePath(bad), undefined, bad);
	for (const bad of ["--upload-pack=x", "a..b", "-n", "a b", "x;rm"]) assert.throws(() => safeRef(bad), undefined, bad);
	assert.equal(safePath("demo-apps/checkout-config.json"), "demo-apps/checkout-config.json");
	assert.equal(safeRef("agent/fix-1"), "agent/fix-1");
});

test("repo.write commits on agent/* branches only and never touches main", async () => {
	await initRepo();
	const before = await repo.read("demo-apps/checkout-config.json");
	await assert.rejects(repo.write({ branch: "main", path: "demo-apps/checkout-config.json", content: "x", message: "m", author: "T" }));
	await assert.rejects(repo.write({ branch: "agent/x", path: "../escape", content: "x", message: "m", author: "T" }));
	const r = await repo.write({ branch: "agent/t1", path: "demo-apps/checkout-config.json", content: before.replace('"0"', '"10"'), message: "fix", author: "Tester" });
	assert.equal(r.committed, true);
	assert.equal(await repo.read("demo-apps/checkout-config.json"), before, "main unchanged");
	assert.match(await repo.diff("agent/t1"), /\+\s+"POOL_SIZE": "10"/);
	const again = await repo.write({ branch: "agent/t1", path: "demo-apps/checkout-config.json", content: before.replace('"0"', '"10"'), message: "fix", author: "Tester" });
	assert.equal(again.committed, false, "idempotent rewrite makes no new commit");
});

test("approvals are idempotent per task and first decision wins", () => {
	const a = store.openApproval({ channelId: "c", agentId: "ops", taskId: "t-1", title: "x", detail: {} });
	assert.equal(a.created, true);
	assert.equal(store.openApproval({ channelId: "c", agentId: "ops", taskId: "t-1", title: "x", detail: {} }).created, false);
	assert.equal(store.decideApproval(a.approval.id, "approved", "alice", null)?.status, "approved");
	assert.equal(store.decideApproval(a.approval.id, "rejected", "bob", null), undefined);
	assert.equal(store.getApproval(a.approval.id)?.decidedBy, "alice");
});
