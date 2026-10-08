// M3 acceptance (BACKLOG): a 30-day run with several operators and developers; every incident ends resolved, escalated, or open with an owner;
// budget exhaustion degrades to Tier 1 and is counted; a recorded replay of the same run makes zero model calls and reproduces the hash.
// Deviation, on purpose: no reviewer role yet (it has nothing real to review until approvals exist in the world).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-m3-"));
process.env.SESSION_SECRET = "test-secret";

const { World, HOUR } = await import("../src/world/engine.ts");
const { seededRng } = await import("../src/world/rng.ts");
const { itopsSpec } = await import("../src/world/itops/spec.ts");
const { impactMinutes } = await import("../src/world/itops/state.ts");
const { withAgents, runAgents, Tape, recording, replaying, budgeted } = await import("../src/world/agents.ts");
const { opsBrain, rulesDev } = await import("../src/world/brains.ts");

const dir = mkdtempSync(join(tmpdir(), "crew-m3-files-"));
let n = 0;
const OPS = ["ops-1", "ops-2", "ops-3"], DEVS = ["dev-1", "dev-2"];
const open = (seed = "m3", ids = [...OPS, ...DEVS]) => World.open(join(dir, `w${++n}.sqlite`), { spec: withAgents(itopsSpec("none"), ids, HOUR), seed, rng: seededRng });
const FAULTS = { rules: [{ tool: "k8s_logs", kind: "wrong" as const, p: 0.2 }, { tool: "k8s_logs", kind: "missing" as const, p: 0.15 }] };
const ops = opsBrain({ devs: DEVS });

/** A language-model stand-in: slow, and it costs 3 units a shift. */
function fakeModel() {
	const calls = { n: 0 };
	return { calls, brain: { tier: 2 as const, name: "fake-model", async shift(s: any) { calls.n++; await ops.shift(s); return { units: 3 }; } } };
}
const roster = (opsBrainFor: (id: string) => any) => [...OPS.map((id) => ({ id, brain: opsBrainFor(id), everyMs: HOUR })), ...DEVS.map((id) => ({ id, brain: rulesDev, everyMs: HOUR }))];

test("3 operators + 2 developers, 30 days: every incident ends resolved, escalated, or open with an owner", async () => {
	const w = open();
	const rep = await runAgents(w, { agents: roster(() => ops), untilDay: 30, faults: FAULTS });
	const st: any = w.state(), inc = Object.values(st.incidents) as any[];
	const resolved = inc.filter((i) => i.status === "resolved");
	assert.ok(inc.length >= 12);
	assert.ok(resolved.length / inc.length >= 0.9, `resolved ${resolved.length}/${inc.length}`);
	const now = w.now();
	for (const i of inc.filter((x) => x.status === "open")) {
		const owned = (Object.values(st.handoffs) as any[]).some((h) => h.task.includes(i.service) && h.at >= i.openedAt);
		assert.ok(owned || now - i.openedAt < 4 * HOUR, `${i.id} (${i.kind} on ${i.service}) is open for ${Math.round((now - i.openedAt) / HOUR)} h and nobody owns it`);
	}
	assert.equal(rep.errors, 0);
	// more people never means two people answering the same question: a request is completed at most once, by its addressee
	const done = w.events().filter((e: any) => e.type === "handoff.completed");
	assert.equal(new Set(done.map((e: any) => e.payload.id)).size, done.length);
	for (const e of done) assert.equal(e.actor, st.handoffs[e.payload.id].to);
	w.close();
});

test("when the log tool is nearly useless the whole chain is exercised: handoffs to both developers, no question spam, and every open incident has an owner", async () => {
	const w = open("m3-storm");
	const heavy = { rules: [{ tool: "k8s_logs", kind: "wrong" as const, p: 0.9 }, { tool: "k8s_logs", kind: "missing" as const, p: 0.9 }] };
	const rep = await runAgents(w, { agents: roster(() => ops), untilDay: 30, faults: heavy });
	const st: any = w.state(), inc = Object.values(st.incidents) as any[], hs = Object.values(st.handoffs) as any[];
	assert.ok(hs.length >= 8, `handoffs ${hs.length}`);
	// no spam: a ticket is asked about at most three times, at least eight hours apart
	const byTicket = new Map<string, number[]>();
	for (const h of hs) { const k = /OPS-\d+/.exec(h.task)?.[0] ?? h.id; byTicket.set(k, [...(byTicket.get(k) ?? []), h.at]); }
	for (const [k, ts] of byTicket) {
		assert.ok(ts.length <= 3, `${k} was asked about ${ts.length} times`);
		for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 8 * HOUR, `${k}: asked again after ${(ts[i] - ts[i - 1]) / HOUR} h`);
	}
	assert.ok(hs.length <= inc.length * 3, `${hs.length} handoffs for ${inc.length} incidents`);
	assert.deepEqual([...new Set(hs.map((h) => h.to))].sort(), ["dev-1", "dev-2"], "work is spread over both developers");
	assert.ok(hs.some((h) => h.status === "completed"), "some were answered");
	const now = w.now();
	for (const i of inc.filter((x) => x.status === "open")) {
		const owned = hs.some((h) => h.task.includes(i.service) && h.at >= i.openedAt);
		assert.ok(owned || now - i.openedAt < 4 * HOUR, `${i.id} open ${Math.round((now - i.openedAt) / HOUR)} h without an owner`);
	}
	assert.equal(rep.errors, 0);
	w.close();
});

test("a team is not worse than one operator: more hands, same weather", async () => {
	const one = open("m3-cmp", ["ops-1"]), team = open("m3-cmp");
	await runAgents(one, { agents: [{ id: "ops-1", brain: opsBrain({ devs: [] }), everyMs: HOUR }], untilDay: 20, faults: FAULTS });
	await runAgents(team, { agents: roster(() => ops), untilDay: 20, faults: FAULTS });
	assert.equal(Object.keys((one.state() as any).incidents).length, Object.keys((team.state() as any).incidents).length, "the same incidents arrive");
	assert.ok(impactMinutes(team.state() as any, team.now()) <= impactMinutes(one.state() as any, one.now()) * 1.05);
	one.close(); team.close();
});

test("a model-driven team on a daily budget degrades to Tier 1 when it runs out, counts it, and still keeps up", async () => {
	const live = fakeModel();
	const w = open();
	const rep = await runAgents(w, { agents: roster(() => budgeted(live.brain, ops, { unitsPerDay: 30 })), untilDay: 30, faults: FAULTS });
	assert.ok(live.calls.n > 0, "the model did work");
	assert.ok(rep.degraded > 0, "and the budget ran out");
	const shifts = w.events().filter((e: any) => e.type === "agent.shift" && OPS.includes(e.actor));
	assert.equal(shifts.filter((e: any) => e.payload.degraded).length, rep.degraded);
	assert.ok(shifts.filter((e: any) => e.payload.tier === 2).length <= OPS.length * 30 * 10 + OPS.length, "never more model shifts than the budget allows");
	const inc = Object.values((w.state() as any).incidents) as any[];
	assert.ok(inc.filter((i) => i.status === "resolved").length / inc.length >= 0.85);
	w.close();
});

test("the recorded run replays with zero model calls and the same hash", async () => {
	const tape = new Tape(), live = fakeModel();
	const a = open("m3-tape");
	await runAgents(a, { agents: roster(() => recording(budgeted(live.brain, ops, { unitsPerDay: 30 }), tape)), untilDay: 30, faults: FAULTS });
	const before = live.calls.n;
	assert.ok(before > 0);
	const b = open("m3-tape");
	const rep = await runAgents(b, { agents: roster(() => replaying(tape)), untilDay: 30, faults: FAULTS });
	assert.equal(live.calls.n, before, "zero model calls in the replay");
	assert.equal(rep.errors, 0);
	assert.equal(b.hash(), a.hash());
	a.close(); b.close();
});
