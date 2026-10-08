// M3e: agents ask each other for help inside the world. A handoff is history (requested / completed / escalated), delivered to the
// recipient's inbox, watched by a watchdog, and a second pair of eyes helps when the first pair is misled by faulty tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-ho-"));
process.env.SESSION_SECRET = "test-secret";

const { World, HOUR } = await import("../src/world/engine.ts");
const { seededRng } = await import("../src/world/rng.ts");
const { itopsSpec } = await import("../src/world/itops/spec.ts");
const { SyntheticTools } = await import("../src/world/itops/tools.ts");
const { impactMinutes } = await import("../src/world/itops/state.ts");
const { withAgents, runAgents } = await import("../src/world/agents.ts");
const { rulesOps, rulesDev } = await import("../src/world/brains.ts");

const dir = mkdtempSync(join(tmpdir(), "crew-ho-files-"));
let n = 0;
const OPS = { id: "ops-1", brain: rulesOps, everyMs: HOUR };
const DEV = { id: "dev-1", brain: rulesDev, everyMs: HOUR };
const open = (ids: string[], seed = "ho-1", quiet = false) => World.open(join(dir, `w${++n}.sqlite`), { spec: withAgents(itopsSpec("none"), ids, HOUR), seed, rng: seededRng, quiet });
const types = (w: any, t: string) => w.events().filter((e: any) => e.type === t);

test("ask_agent is a tool with the real tool's parameters; it writes a handoff into history, attributed to the caller", () => {
	const w = open([], "a", true); const t = new SyntheticTools(w);
	assert.deepEqual(t.paramNames("ask_agent"), ["agent", "request"]);
	const r = t.call("ask_agent", { agent: "dev-1", request: "please look at checkout" }, { agent: "ops-1" });
	assert.equal(r.isError, false);
	assert.match(r.text, /hand_1/);
	const e = types(w, "handoff.requested");
	assert.equal(e.length, 1);
	assert.deepEqual([e[0].actor, e[0].payload.from, e[0].payload.to, e[0].payload.task], ["tool:ops-1", "ops-1", "dev-1", "please look at checkout"]);
	// bad requests are errors and write nothing
	for (const args of [{}, { agent: "dev-1" }, { agent: "", request: "x" }, { agent: "Dev One", request: "x" }, { agent: "dev-1", request: "" }, { agent: "dev-1", request: "x".repeat(5000) }, { agent: "ops-1", request: "myself" }, { agent: 5, request: "x" }])
		assert.equal(t.call("ask_agent", args as any, { agent: "ops-1" }).isError, true, JSON.stringify(args).slice(0, 60));
	assert.equal(types(w, "handoff.requested").length, 1);
	// like the real tool: case-insensitive, a leading @ is fine
	assert.equal(t.call("ask_agent", { agent: "@DEV-2", request: "x" }, { agent: "ops-1" }).isError, false);
	assert.equal(types(w, "handoff.requested")[1].payload.to, "dev-2");
	w.close();
});

test("a request nobody answers is escalated once by the watchdog after four hours", async () => {
	const w = open(["ops-1"], "b");
	new SyntheticTools(w).call("ask_agent", { agent: "ghost", request: "anyone there?" }, { agent: "ops-1" });
	await runAgents(w, { agents: [{ id: "ops-1", brain: { tier: 1, name: "idle", async shift() {} }, everyMs: HOUR }], untilDay: 2 });
	const esc = types(w, "handoff.escalated");
	assert.equal(esc.length, 1);
	assert.equal(esc[0].actor, "watchdog");
	assert.ok(esc[0].vtime >= 4 * HOUR && esc[0].vtime < 4 * HOUR + 1000);
	w.close();
});

test("a handoff reaches the recipient's inbox, is answered exactly once, and cancels the watchdog's escalation", async () => {
	const w = open(["ops-1", "dev-1"], "c");
	new SyntheticTools(w).call("ask_agent", { agent: "dev-1", request: "look at service checkout" }, { agent: "ops-1" });
	const seen: string[] = [];
	const dev = { tier: 1 as const, name: "dev-probe", async shift(s: any) { for (const h of s.inbox()) { seen.push(`${h.id}:${h.from}:${h.task}`); s.reply(h.id, "looked, all fine"); } } };
	await runAgents(w, { agents: [{ id: "ops-1", brain: { tier: 1, name: "idle", async shift() {} }, everyMs: HOUR }, { id: "dev-1", brain: dev, everyMs: HOUR }], untilDay: 2 });
	assert.deepEqual(seen, ["hand_1:ops-1:look at service checkout"], "delivered once, then gone from the inbox");
	const done = types(w, "handoff.completed");
	assert.equal(done.length, 1);
	assert.deepEqual([done[0].actor, done[0].payload.id, done[0].payload.result], ["dev-1", "hand_1", "looked, all fine"]);
	assert.equal(types(w, "handoff.escalated").length, 0);
	w.close();
});

test("replying to something that is not in your inbox is an error, not an event", async () => {
	const w = open(["ops-1", "dev-1"], "d");
	new SyntheticTools(w).call("ask_agent", { agent: "dev-1", request: "t" }, { agent: "ops-1" });
	const bad = { tier: 1 as const, name: "bad", async shift(s: any) { s.reply("hand_99", "x"); } };
	const rep = await runAgents(w, { agents: [{ id: "dev-1", brain: bad, everyMs: HOUR }, { id: "ops-1", brain: { tier: 1, name: "idle", async shift() {} }, everyMs: HOUR }], untilDay: 1 });
	assert.ok(rep.errors > 0);
	assert.equal(types(w, "handoff.completed").length, 0);
	// somebody else's handoff either
	const w2 = open(["ops-1", "dev-1", "dev-2"], "d2");
	new SyntheticTools(w2).call("ask_agent", { agent: "dev-1", request: "t" }, { agent: "ops-1" });
	const thief = { tier: 1 as const, name: "thief", async shift(s: any) { s.reply("hand_1", "mine now"); } };
	const idle = (id: string) => ({ id, brain: { tier: 1 as const, name: "idle", async shift() {} }, everyMs: HOUR });
	const r2 = await runAgents(w2, { agents: [{ id: "dev-2", brain: thief, everyMs: HOUR }, idle("ops-1"), idle("dev-1")], untilDay: 1 });
	assert.ok(r2.errors > 0);
	assert.equal(types(w2, "handoff.completed").length, 0);
	w.close(); w2.close();
});

test("with misleading tools a developer's second opinion cuts the customers' pain (the operator alone gets there too, only later)", async () => {
	const faults = { rules: [{ tool: "k8s_logs", kind: "wrong" as const, p: 0.45 }, { tool: "k8s_logs", kind: "missing" as const, p: 0.25 }] };
	let alone = 0, team = 0, asked = 0, answered = 0;
	for (const seed of ["f1", "f2", "f3", "f4"]) {
		const a = open(["ops-1"], seed); await runAgents(a, { agents: [OPS], untilDay: 30, faults });
		const b = open(["ops-1", "dev-1"], seed); await runAgents(b, { agents: [OPS, DEV], untilDay: 30, faults });
		alone += impactMinutes(a.state(), a.now()); team += impactMinutes(b.state(), b.now());
		asked += types(b, "handoff.requested").length; answered += types(b, "handoff.completed").length;
		a.close(); b.close();
	}
	assert.ok(asked >= 20, `the operator asked for help (${asked})`);
	assert.ok(answered >= asked * 0.9, `and the developer answered (${answered}/${asked})`);
	assert.ok(team < alone * 0.9, `impact with the team ${Math.round(team)} min, operator alone ${Math.round(alone)} min`);
});

test("handoffs survive a restart: same history as an uninterrupted run, nothing answered twice", async () => {
	const faults = { rules: [{ tool: "k8s_logs", kind: "missing" as const, p: 0.5 }] };
	const whole = open(["ops-1", "dev-1"], "r"); await runAgents(whole, { agents: [OPS, DEV], untilDay: 12, faults });
	const path = join(dir, "ho-resume.sqlite");
	const spec = withAgents(itopsSpec("none"), ["ops-1", "dev-1"], HOUR);
	const x = World.open(path, { spec, seed: "r", rng: seededRng });
	await runAgents(x, { agents: [OPS, DEV], untilDay: 12, faults, maxShifts: 101 }); x.close();
	const y = World.open(path, { spec, seed: "r", rng: seededRng });
	await runAgents(y, { agents: [OPS, DEV], untilDay: 12, faults });
	assert.equal(y.hash(), whole.hash());
	const ids = types(y, "handoff.completed").map((e: any) => e.payload.id);
	assert.equal(new Set(ids).size, ids.length);
	assert.ok(ids.length > 0);
	whole.close(); y.close();
});

test("an agent sees only its own inbox", async () => {
	const w = open(["ops-1", "dev-1", "dev-2"], "inbox");
	new SyntheticTools(w).call("ask_agent", { agent: "dev-1", request: "for dev-1 only" }, { agent: "ops-1" });
	const seen: Record<string, string[]> = { "dev-1": [], "dev-2": [] };
	const peek = (id: string) => ({ id, everyMs: HOUR, brain: { tier: 1 as const, name: "peek", async shift(s: any) { seen[id].push(...s.inbox().map((h: any) => h.task)); } } });
	const idle = { id: "ops-1", everyMs: HOUR, brain: { tier: 1 as const, name: "idle", async shift() {} } };
	await runAgents(w, { agents: [idle, peek("dev-1"), peek("dev-2")], untilDay: 1 });
	assert.ok(seen["dev-1"].length > 0);
	assert.deepEqual(seen["dev-2"], []);
	w.close();
});

test("the operator waits two hours before asking, and asks about a ticket only once while the question is open", async () => {
	const w = open(["ops-1"], "patience");
	w.scheduleAt({ actor: "chaos", at: 10 * 60_000, kind: "inject", data: { kind: "bad_config", service: "checkout" } });
	// every log read fails, so the operator can never diagnose it
	await runAgents(w, { agents: [OPS], untilDay: 1, faults: { rules: [{ tool: "k8s_logs", kind: "missing", p: 1 }] } });
	const asks = types(w, "handoff.requested");
	const mine = asks.filter((e: any) => /OPS-\d+/.test(e.payload.task) && /checkout/.test(e.payload.task));
	assert.equal(mine.length, 1, "one question, not one per shift");
	assert.ok(mine[0].vtime >= 2 * HOUR && mine[0].vtime < 3 * HOUR, `asked at ${mine[0].vtime / HOUR} h, not on first sight`);
	w.close();
});

test("a developer who is asked about a real fault finds the cause, fixes it, and says so", async () => {
	const w = open(["ops-1", "dev-1"], "dev-fix");
	w.scheduleAt({ actor: "chaos", at: 10 * 60_000, kind: "inject", data: { kind: "expired_cert", service: "payments" } });
	new SyntheticTools(w).call("ask_agent", { agent: "dev-1", request: "Please look at service payments." }, { agent: "ops-1" });
	const idle = { id: "ops-1", everyMs: HOUR, brain: { tier: 1 as const, name: "idle", async shift() {} } };
	await runAgents(w, { agents: [idle, DEV], untilDay: 1 });
	const fixed = types(w, "incident.resolved");
	assert.equal(fixed.length, 1);
	assert.equal(fixed[0].actor, "tool:dev-1");
	assert.match(types(w, "handoff.completed")[0].payload.result, /applied cert_rotate/);
	w.close();
});
