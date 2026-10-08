// M3b: agents live in the world. A Tier 1 agent is a rule-based brain that sees the world only through the synthetic tools;
// it is driven from outside the engine loop (M3a), so a Tier 2 brain (a language model) can take its place later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-agents-"));
process.env.SESSION_SECRET = "test-secret";

const { World, DAY, HOUR } = await import("../src/world/engine.ts");
const { seededRng } = await import("../src/world/rng.ts");
const { itopsSpec } = await import("../src/world/itops/spec.ts");
const { impactMinutes } = await import("../src/world/itops/state.ts");
const { SyntheticTools } = await import("../src/world/itops/tools.ts");
const { withAgents, runAgents } = await import("../src/world/agents.ts");
const { rulesOps } = await import("../src/world/brains.ts");

const dir = mkdtempSync(join(tmpdir(), "crew-agents-files-"));
let n = 0;
const OPS = { id: "ops-1", brain: rulesOps, everyMs: HOUR };
const open = (agents = [OPS], seed = "agents-1", policy: "none" | "oracle" = "none") =>
	World.open(join(dir, `w${++n}.sqlite`), { spec: withAgents(itopsSpec(policy), agents.map((a) => a.id), HOUR), seed, rng: seededRng });
const counts = (w: any) => {
	const inc = Object.values(w.state().incidents) as any[];
	return { total: inc.length, resolved: inc.filter((i) => i.status === "resolved").length, open: inc.filter((i) => i.status === "open").length };
};

test("a rule-based ops agent, seeing only tool output, resolves most incidents in 30 days and beats nobody-at-home", async () => {
	const none = open([], "agents-1"); none.run({ days: 30 });
	const w = open();
	const rep = await runAgents(w, { agents: [OPS], untilDay: 30 });
	const c = counts(w), c0 = counts(none);
	assert.equal(c.total, c0.total, "the weather is the same: the same incidents arrive");
	assert.ok(c.total >= 12, `enough incidents to mean something (${c.total})`);
	assert.ok(c.resolved / c.total >= 0.75, `resolved ${c.resolved}/${c.total}`);
	assert.ok(c.resolved > c0.resolved);
	assert.ok(impactMinutes(w.state(), w.now()) < impactMinutes(none.state(), none.now()) * 0.6, "customers feel much less pain");
	assert.ok(rep.shifts >= 30 * 24 - 2, `it works every hour (${rep.shifts} shifts)`);
	const acts = w.events().filter((e: any) => e.type === "action.performed");
	assert.ok(acts.length > 0 && acts.every((e: any) => e.actor === "tool:ops-1"), "every action is attributed to the agent's tool");
	assert.ok(w.events().some((e: any) => e.type === "agent.shift" && e.actor === "ops-1"), "its shifts are in the history");
	w.close(); none.close();
});

test("the same seed gives the same history; stopping and reopening in the middle changes nothing", async () => {
	const a = open(); await runAgents(a, { agents: [OPS], untilDay: 12 });
	const b = open(); await runAgents(b, { agents: [OPS], untilDay: 12 });
	assert.equal(a.hash(), b.hash());
	const path = join(dir, "resume.sqlite");
	const spec = withAgents(itopsSpec("none"), ["ops-1"], HOUR);
	const c = World.open(path, { spec, seed: "agents-1", rng: seededRng });
	await runAgents(c, { agents: [OPS], untilDay: 5 }); c.close();
	const d = World.open(path, { spec, seed: "agents-1", rng: seededRng });
	await runAgents(d, { agents: [OPS], untilDay: 12 });
	assert.equal(d.hash(), a.hash());
	a.close(); b.close(); d.close();
});

test("an agent actor cannot be run inside the loop: its work is not the engine's to fake", () => {
	const w = open();
	assert.throws(() => w.run({ days: 2 }), /driven from outside/);
	w.close();
});

test("two agents never collide, and each is attributed correctly", async () => {
	const two = [OPS, { id: "ops-2", brain: rulesOps, everyMs: HOUR }];
	const w = open(two);
	await runAgents(w, { agents: two, untilDay: 10 });
	const who = new Set(w.events().filter((e: any) => e.type === "action.performed").map((e: any) => e.actor));
	assert.ok([...who].every((x) => /^tool:ops-[12]$/.test(String(x))));
	const shifts = (id: string) => w.events().filter((e: any) => e.type === "agent.shift" && e.actor === id).length;
	assert.ok(Math.abs(shifts("ops-1") - shifts("ops-2")) <= 1, "both work every hour (ops-2 wakes 1 ms later, so the day boundary can cut one shift)");
	assert.ok(shifts("ops-1") >= 239 && shifts("ops-2") >= 239);
	const at = (id: string) => new Set(w.events().filter((e: any) => e.type === "agent.shift" && e.actor === id).map((e: any) => e.vtime));
	assert.ok([...at("ops-1")].every((t) => !at("ops-2").has(t)), "no two agents ever wake at the same instant (a tool call would run the other's shift inside the loop)");
	w.close();
});

test("the brain is blind by construction: it cannot import the world's secrets", () => {
	for (const f of ["src/world/brains.ts", "src/world/agents.ts"]) {
		const src = readFileSync(f, "utf8");
		for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) assert.doesNotMatch(m[1], /catalog|symptoms|itops\/state|itops\/spec/, `${f} imports ${m[1]}`);
	}
});

test("a tool that fails, or lies, does not stop the shift: faulty tools make the agent worse, never crash the world", async () => {
	const w = open();
	const rep = await runAgents(w, { agents: [OPS], untilDay: 10, faults: { rules: [{ tool: "*", kind: "missing", p: 0.4 }, { tool: "k8s_logs", kind: "wrong", p: 0.5 }] } });
	assert.ok(rep.shifts > 200);
	assert.ok(w.faultLog().length > 50, "faults really happened");
	w.close();
});

test("each kind of problem, injected on its own, is diagnosed from tool output and resolved by the agent (not by the scripted responder)", async () => {
	const { KINDS } = await import("../src/world/itops/catalog.ts");
	for (const kind of KINDS) {
		const w = open([OPS], `kind-${kind}`);
		w.scheduleAt({ actor: "chaos", at: 10 * 60_000, kind: "inject", data: { kind } });
		// the world's own arrivals would blur the picture: look only at the injected incident
		await runAgents(w, { agents: [OPS], untilDay: 2 });
		const opened = w.events().find((e: any) => e.type === "incident.opened" && e.actor === "operator");
		assert.ok(opened, `${kind}: the injection happened`);
		const id = opened.payload.id, inc = (w.state() as any).incidents[id];
		assert.equal(inc.cause.kind, kind);
		assert.equal(inc.status, "resolved", `${kind} resolved`);
		const by = w.events().find((e: any) => e.type === "incident.resolved" && e.payload.id === id)?.actor;
		assert.equal(by, "tool:ops-1", `${kind}: resolved by the agent's tool`);
		w.close();
	}
});

test("one outage seen from two tickets gets one fix per shift, not two", async () => {
	const w = open([OPS], "twin-tickets");
	w.scheduleAt({ actor: "chaos", at: 10 * 60_000, kind: "inject", data: { kind: "dependency_down", service: "checkout" } });
	w.scheduleAt({ actor: "chaos", at: 11 * 60_000, kind: "inject", data: { kind: "dependency_down", service: "api" } });
	await runAgents(w, { agents: [OPS], untilDay: 1, maxShifts: 3 });
	const failovers = w.events().filter((e: any) => e.type === "action.performed" && e.payload.action.type === "failover");
	assert.equal(failovers.length, 1, "the database is failed over once; that fixes both tickets");
	assert.equal(w.events().filter((e: any) => e.type === "incident.resolved").length, 2);
	w.close();
});
