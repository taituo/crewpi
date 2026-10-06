import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-mem-"));
const { saveNote, recall, memorySection, visibleNotes, deleteNote, scopeFor } = await import("../src/memory.ts");
const { createDm } = await import("../src/channels.ts");

test("notes are cleaned, deduplicated and recalled by keywords", () => {
	const a = saveNote({ agentId: "ops", channelId: "incidents", text: "Root cause of PAY-412:\n POOL_SIZE=0 in checkout-config", source: "agent" });
	assert.equal(a.created, true);
	assert.equal(a.note.text, "Root cause of PAY-412: POOL_SIZE=0 in checkout-config");
	assert.equal(saveNote({ agentId: "ops", channelId: "incidents", text: a.note.text, source: "agent" }).created, false);
	assert.throws(() => saveNote({ agentId: "ops", channelId: "incidents", text: "hi", source: "agent" }), /too short/);
	assert.equal(recall("ops", "incidents", "pool_size checkout", 5).length, 1);
	assert.equal(recall("ops", "incidents", "nonexistent", 5).length, 0);
	assert.equal(recall("developer", "incidents", "pool_size", 5).length, 0, "other agents do not share notes");
});

test("agent-wide notes follow the agent; channel notes stay in their channel", () => {
	saveNote({ agentId: "ops", channelId: "production", scope: "channel", text: "prod channel only: freeze deploys on Fridays", source: "agent" });
	assert.match(memorySection("ops", "production")!, /freeze deploys/);
	assert.doesNotMatch(memorySection("ops", "incidents")!, /freeze deploys/);
	assert.match(memorySection("ops", "incidents")!, /POOL_SIZE=0/, "agent-wide note shows everywhere");
	assert.match(memorySection("ops", "incidents")!, /DATA written/, "framed as data, not instructions");
});

test("private chat notes can never become agent-wide and stay invisible to others", () => {
	const dm = createDm({ sub: "u-alice", userName: "Alice", agentId: "ops" }).channel;
	assert.equal(scopeFor(dm.id, "agent"), `channel:${dm.id}`, "agent scope is downgraded in a DM");
	const n = saveNote({ agentId: "ops", channelId: dm.id, scope: "agent", text: "Alice is job hunting, keep it quiet", source: "agent" }).note;
	assert.doesNotMatch(memorySection("ops", "incidents")!, /job hunting/);
	assert.ok(visibleNotes("u-alice").some((x) => x.id === n.id));
	assert.ok(!visibleNotes("u-bob").some((x) => x.id === n.id), "another user cannot read it");
	assert.equal(deleteNote(n.id, "u-bob", true), false, "not even an admin can delete a private note");
	assert.equal(deleteNote(n.id, "u-alice", false), true, "the owner can");
});
