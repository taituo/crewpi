import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-cases-"));
const { store } = await import("../src/db.ts");
const ch = await import("../src/channels.ts");
const { openCase } = await import("../src/cases.ts");
const { evaluate, setAnomaly } = await import("../src/watch.ts");
const f = await import("../src/fakes.ts");
const { setEnabled } = await import("../src/integrations.ts");

test("standing channels are seeded; case channels are idempotent per ticket", async () => {
	assert.ok(ch.channelById("general"));
	const a = await openCase({ ticket: "PAY-412", createdBy: "t", source: "manual" });
	assert.equal(a.created, true);
	assert.equal(a.channel.id, "pay-412");
	assert.equal(a.channel.kind, "issue");
	const again = await openCase({ ticket: "pay-412", createdBy: "t", source: "agent" });
	assert.equal(again.created, false);
	const card = store.listMessages("pay-412").find((m) => m.meta.kind === "case")!;
	assert.equal((card.meta.related as any).prs[0].label, "acme/platform-config#77");
	assert.equal(store.listMessages("pay-412").filter((m) => m.meta.kind === "case").length, 1);
});

test("bad input is rejected", async () => {
	await assert.rejects(openCase({ ticket: "NOPE-1", createdBy: "t", source: "manual" }), /no ticket/);
	await assert.rejects(openCase({ ticket: "not a key", createdBy: "t", source: "manual" }), /not a ticket key/);
	await assert.rejects(openCase({ createdBy: "t", source: "manual" }), /ticket key or a topic/);
	setEnabled("jira", false, "t");
	await assert.rejects(openCase({ ticket: "PAY-407", createdBy: "t", source: "manual" }), /Jira is not connected/);
	setEnabled("jira", true, "t");
});

test("standing channels cannot be archived, cases can", () => {
	assert.equal(ch.setChannelStatus("general", "archived"), undefined);
	assert.equal(ch.setChannelStatus("pay-412", "archived")?.status, "archived");
	assert.ok(!ch.listChannels(false).some((c) => c.id === "pay-412"));
	ch.setChannelStatus("pay-412", "open");
});

test("anomaly watcher opens exactly one ticket + channel, then re-arms after recovery", async () => {
	const before = ch.listChannels(true).length;
	await evaluate(); // calm: nothing for orders, existing checkout incident is only recorded
	assert.equal(ch.listChannels(true).length, before);
	setAnomaly("orders_queue_depth", true);
	await evaluate();
	await evaluate();
	const added = ch.listChannels(true).filter((c) => c.kind === "issue" && c.createdBy === "Watcher");
	assert.equal(added.length, 1, "no duplicate on the second tick");
	assert.equal(f.findIssue(added[0].ticket!)?.status, "Open");
	assert.ok(store.listMessages("incidents").some((m) => m.meta.link === added[0].id), "announced in #incidents");
	setAnomaly("orders_queue_depth", false);
	await evaluate();
	assert.ok(store.listMessages(added[0].id).some((m) => /back to normal/.test(m.text)));
	setAnomaly("orders_queue_depth", true);
	await evaluate();
	assert.equal(ch.listChannels(true).filter((c) => c.kind === "issue" && c.createdBy === "Watcher").length, 2, "re-armed: a new anomaly opens a new case");
});
