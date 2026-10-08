// M3c: a Tier 2 brain is expensive and not repeatable, so (1) its work can be recorded on a tape and replayed with zero model calls,
// reproducing the same world, and (2) it has a daily budget; when the budget is spent the agent degrades to a Tier 1 brain, and that is counted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-tape-"));
process.env.SESSION_SECRET = "test-secret";

const { World, HOUR } = await import("../src/world/engine.ts");
const { seededRng } = await import("../src/world/rng.ts");
const { itopsSpec } = await import("../src/world/itops/spec.ts");
const { withAgents, runAgents, Tape, recording, replaying, budgeted } = await import("../src/world/agents.ts");
const { rulesOps } = await import("../src/world/brains.ts");

const dir = mkdtempSync(join(tmpdir(), "crew-tape-files-"));
let n = 0;
const open = (seed = "tape-1", ids = ["ops-1"]) => World.open(join(dir, `w${++n}.sqlite`), { spec: withAgents(itopsSpec("none"), ids, HOUR), seed, rng: seededRng });

/** A stand-in for a language model: it is slow and costs money, so every thinking step is counted. It does the runbook's work. */
function fakeModel() {
	const calls = { n: 0 };
	const brain = { tier: 2 as const, name: "fake-model", async shift(s: any) { calls.n++; await new Promise((r) => setTimeout(r, 0)); await rulesOps.shift(s); return { units: 3 }; } };
	return { brain, calls };
}

test("a recorded run replays with zero model calls and reproduces the world byte for byte", async () => {
	const tape = new Tape();
	const live = fakeModel();
	const a = open();
	await runAgents(a, { agents: [{ id: "ops-1", brain: recording(live.brain, tape), everyMs: HOUR }], untilDay: 10 });
	assert.ok(live.calls.n >= 230, `the model really worked (${live.calls.n} calls)`);
	assert.ok(tape.size >= 230);
	const again = fakeModel();
	const b = open();
	const rep = await runAgents(b, { agents: [{ id: "ops-1", brain: replaying(tape), everyMs: HOUR }], untilDay: 10 });
	assert.equal(again.calls.n, 0, "the replay never touches a model");
	assert.equal(rep.errors, 0);
	assert.equal(b.hash(), a.hash());
	a.close(); b.close();
});

test("a replay in a different world notices: the tape says what the tools answered, and they answer differently", async () => {
	const tape = new Tape();
	const a = open("tape-A");
	await runAgents(a, { agents: [{ id: "ops-1", brain: recording(fakeModel().brain, tape), everyMs: HOUR }], untilDay: 6 });
	const b = open("tape-B");
	const rep = await runAgents(b, { agents: [{ id: "ops-1", brain: replaying(tape), everyMs: HOUR }], untilDay: 6 });
	assert.ok(rep.errors > 0, "divergence is reported");
	assert.ok(b.events().some((e: any) => e.type === "agent.shift" && /diverged/.test(String(e.payload.error))), "and it is in the history");
	a.close(); b.close();
});

test("a tape survives a restart of the process: saved as lines, loaded, replayed", async () => {
	const tape = new Tape();
	const a = open();
	await runAgents(a, { agents: [{ id: "ops-1", brain: recording(fakeModel().brain, tape), everyMs: HOUR }], untilDay: 5 });
	const file = join(dir, "tape.jsonl");
	tape.save(file);
	const loaded = Tape.load(file);
	assert.equal(loaded.size, tape.size);
	assert.ok(readFileSync(file, "utf8").split("\n").filter(Boolean).every((l) => JSON.parse(l).agent === "ops-1"));
	const b = open();
	await runAgents(b, { agents: [{ id: "ops-1", brain: replaying(loaded), everyMs: HOUR }], untilDay: 5 });
	assert.equal(b.hash(), a.hash());
	a.close(); b.close();
});

test("a budget degrades the agent to Tier 1 for the rest of the day, counts it, and starts fresh the next day", async () => {
	const live = fakeModel();
	const mk = (units: number) => budgeted(live.brain, rulesOps, { unitsPerDay: units });
	const w = open();
	const rep = await runAgents(w, { agents: [{ id: "ops-1", brain: mk(30), everyMs: HOUR }], untilDay: 6 });
	// 30 units/day at 3 units/shift = 10 model shifts a day, 14 degraded ones
	const shifts = w.events().filter((e: any) => e.type === "agent.shift");
	const degraded = shifts.filter((e: any) => e.payload.degraded);
	assert.equal(rep.degraded, degraded.length);
	assert.ok(degraded.length >= 6 * 13 && degraded.length <= 6 * 15, `degraded ${degraded.length}`);
	for (let d = 0; d < 6; d++) {
		const day = shifts.filter((e: any) => Math.floor(e.vtime / 86_400_000) === d);
		assert.equal(day.filter((e: any) => e.payload.tier === 2).length, 10, `day ${d}: exactly ten model shifts, then Tier 1`);
		assert.ok(day.filter((e: any) => e.payload.degraded).every((e: any) => e.payload.tier === 1 && e.payload.brain === "rules-ops"));
	}
	// the work still gets done on Tier 1
	const inc = Object.values((w.state() as any).incidents) as any[];
	assert.ok(inc.filter((i) => i.status === "resolved").length / inc.length >= 0.7);
	w.close();
});

test("no budget pressure means no degradation; zero budget means Tier 1 all the way and the model is never called", async () => {
	const live = fakeModel();
	const a = open();
	const ra = await runAgents(a, { agents: [{ id: "ops-1", brain: budgeted(live.brain, rulesOps, { unitsPerDay: 1e9 }), everyMs: HOUR }], untilDay: 3 });
	assert.equal(ra.degraded, 0);
	const before = live.calls.n;
	const b = open();
	const rb = await runAgents(b, { agents: [{ id: "ops-1", brain: budgeted(live.brain, rulesOps, { unitsPerDay: 0 }), everyMs: HOUR }], untilDay: 3 });
	assert.equal(live.calls.n, before, "not a single model call");
	assert.equal(rb.degraded, rb.shifts);
	a.close(); b.close();
});

test("the budget is part of the history: stopping and reopening in the middle of a day does not give the agent a fresh budget", async () => {
	const live = fakeModel();
	const agents = () => [{ id: "ops-1", brain: budgeted(live.brain, rulesOps, { unitsPerDay: 30 }), everyMs: HOUR }];
	const whole = open(); await runAgents(whole, { agents: agents(), untilDay: 4 });
	const path = join(dir, "bud.sqlite");
	const spec = withAgents(itopsSpec("none"), ["ops-1"], HOUR);
	const x = World.open(path, { spec, seed: "tape-1", rng: seededRng });
	await runAgents(x, { agents: agents(), untilDay: 4, maxShifts: 37 }); // stops mid-day-1
	x.close();
	const y = World.open(path, { spec, seed: "tape-1", rng: seededRng });
	await runAgents(y, { agents: agents(), untilDay: 4 });
	assert.equal(y.hash(), whole.hash());
	whole.close(); y.close();
});

test("a replay that runs past the end of the tape says so instead of quietly doing nothing", async () => {
	const tape = new Tape();
	const a = open(); await runAgents(a, { agents: [{ id: "ops-1", brain: recording(fakeModel().brain, tape), everyMs: HOUR }], untilDay: 3 });
	const b = open();
	const rep = await runAgents(b, { agents: [{ id: "ops-1", brain: replaying(tape), everyMs: HOUR }], untilDay: 5 });
	assert.ok(rep.errors >= 40, `the second half has no tape (${rep.errors} errors)`);
	assert.ok(b.events().some((e: any) => /tape has no shift/.test(String(e.payload.error))));
	a.close(); b.close();
});

test("a shift that failed when recorded fails the same way when replayed, and the histories still match", async () => {
	let k = 0;
	const flaky = { tier: 2 as const, name: "flaky-model", async shift(s: any) { if (++k % 7 === 0) { await s.call("jira_search", {}); throw new Error("model timeout"); } await rulesOps.shift(s); return { units: 2 }; } };
	const tape = new Tape();
	const a = open(); const ra = await runAgents(a, { agents: [{ id: "ops-1", brain: recording(flaky, tape), everyMs: HOUR }], untilDay: 6 });
	assert.ok(ra.errors >= 15);
	const b = open(); const rb = await runAgents(b, { agents: [{ id: "ops-1", brain: replaying(tape), everyMs: HOUR }], untilDay: 6 });
	assert.equal(rb.errors, ra.errors);
	assert.equal(b.hash(), a.hash());
	assert.ok(a.events().some((e: any) => e.payload.error === "model timeout"));
	a.close(); b.close();
});
