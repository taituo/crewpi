// The world in the Crew UI: a synthetic world's conversation appears as a read-only channel (#world-<name>) in the same workspace the
// people already use, with the same message rows, so the existing UI renders it. The bridge only reads the world and only writes messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "crew-bridge-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-secret";

const { World, HOUR } = await import("../src/world/engine.ts");
const { seededRng } = await import("../src/world/rng.ts");
const { itopsSpec } = await import("../src/world/itops/spec.ts");
const { runAgents } = await import("../src/world/agents.ts");
const { parseTeam, teamSpec, teamAgents, FAULT_PRESETS } = await import("../src/world/team.ts");
const { Observer } = await import("../src/world/observe.ts");
const { syncWorldChannel, worldChannelId, isWorldChannel } = await import("../src/world/bridge.ts");
const { store } = await import("../src/db.ts");
const { channelById, listChannels } = await import("../src/channels.ts");
const { hub } = await import("../src/hub.ts");

mkdirSync(join(dataDir, "worlds"), { recursive: true });
const team = parseTeam("ops=2,dev=1", "heavy");
const path = join(dataDir, "worlds", "demo.sqlite");
const world = World.open(path, { spec: teamSpec(itopsSpec("none"), team), seed: "bridge", rng: seededRng, name: "demo" });
const advance = (untilDay: number) => runAgents(world, { agents: teamAgents(team), untilDay, faults: FAULT_PRESETS[team.faults] });
const rows = () => store.listMessages(worldChannelId("demo"), 100000) as any[];

test("the first sync creates a read-only standing channel and fills it with the conversation, as ordinary messages", async () => {
	await advance(12);
	const o = new Observer(path); const chat = o.chat({ since: 0, limit: 5000 }); o.close();
	assert.ok(chat.length > 20);
	const r = syncWorldChannel(path, "demo");
	assert.equal(r.added, chat.length);
	const ch = channelById("world-demo")!;
	assert.equal(ch.kind, "standing");
	assert.deepEqual(ch.agents, [], "no live agent is in this room: nobody answers if somebody types");
	assert.match(ch.topic, /synthetic/i);
	assert.ok(isWorldChannel("world-demo") && !isWorldChannel("general"));
	assert.ok(listChannels(false, "someone").some((c: any) => c.id === "world-demo"), "everyone who can see channels sees it");
	const msgs = rows();
	assert.equal(msgs.length, chat.length);
	const req = msgs.find((m) => m.meta.world.kind === "request");
	assert.equal(req.authorKind, "agent");
	assert.match(req.authorId, /^(ops|dev)-\d$/);
	assert.match(req.text, /^day \d+ \d\d:\d\d · @(ops|dev)-\d /, "the world time, then who the request is for");
	assert.match(req.text, /day \d+ \d\d:\d\d/, "the world's own time is shown (the row's timestamp is wall-clock)");
	const note = msgs.find((m) => m.meta.world.kind === "alert");
	assert.equal(note.authorKind, "system");
	assert.equal(note.meta.kind, "notice");
	assert.ok(msgs.every((m) => typeof m.meta.world.seq === "number" && typeof m.meta.world.vtime === "number"));
	assert.deepEqual(msgs.map((m) => m.meta.world.seq), [...msgs.map((m) => m.meta.world.seq)].sort((a, b) => a - b), "in the world's order");
});

test("syncing again adds nothing; after the world moves on only the new part is added; a restart (state read from the rows) changes nothing", async () => {
	assert.equal(syncWorldChannel(path, "demo").added, 0);
	const before = rows().length;
	await advance(20);
	const o = new Observer(path); const all = o.chat({ since: 0, limit: 50000 }).length; o.close();
	const r = syncWorldChannel(path, "demo");
	assert.equal(r.added, all - before);
	assert.equal(rows().length, all);
	assert.equal(syncWorldChannel(path, "demo").added, 0);
	// no message twice
	const seqs = rows().map((m) => m.meta.world.seq);
	assert.equal(new Set(seqs).size, seqs.length);
});

test("open UIs are told as it happens: every added message is published to the hub", async () => {
	const seen: any[] = [];
	const res: any = { write: (s: string) => seen.push(s), on: () => {} };
	hub.add(res, "viewer");
	await advance(22);
	const n = syncWorldChannel(path, "demo").added;
	assert.ok(n > 0);
	assert.equal(seen.filter((s) => s.startsWith("event: message")).length, n);
});

test("a world that does not exist is an error, not an empty channel", () => {
	assert.throws(() => syncWorldChannel(join(dataDir, "worlds", "nope.sqlite"), "nope"), /no such world/i);
	assert.equal(channelById("world-nope"), undefined);
	assert.throws(() => worldChannelId("Bad Name!"), /world name/i);
	world.close();
});
