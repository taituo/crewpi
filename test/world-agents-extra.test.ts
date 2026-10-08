// Agent-layer extras: mutations of agents.ts, model-brain.ts and brains.ts that the
// earlier suites did not catch. Each test kills at least one such mutation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-agentsextra-"));
process.env.SESSION_SECRET = "test-secret";

const { World, DAY, HOUR } = await import("../src/world/engine.ts");
const { seededRng } = await import("../src/world/rng.ts");
const { itopsSpec } = await import("../src/world/itops/spec.ts");
const { withAgents, runAgents, Tape, recording, replaying, budgeted } = await import("../src/world/agents.ts");
const { rulesOps } = await import("../src/world/brains.ts");
const { modelBrain } = await import("../src/world/model-brain.ts");
const require_tools = await import("../src/world/itops/tools.ts");

const dir = mkdtempSync(join(tmpdir(), "crew-agentsextra-files-"));
let n = 0;
const open = (seed = "extra-1", ids = ["ops-1"]) =>
	World.open(join(dir, `w${++n}.sqlite`), { spec: withAgents(itopsSpec("none"), ids, HOUR), seed, rng: seededRng });
const OPS = { id: "ops-1", brain: rulesOps, everyMs: HOUR };

// a stand-in model: does the runbook's work at a fixed price per shift
function fakeModel(cost = 3) {
	const calls = { n: 0 };
	const brain = { tier: 2 as const, name: "fake-model", async shift(s: any) { calls.n++; await rulesOps.shift(s); return { units: cost }; } };
	return { brain, calls };
}

// ---- tape ----

test("replay compares the error flag, not just the text", async () => {
	// kills: replay dropping the isError check (same words, ok vs error, must diverge)
	const tape = new Tape();
	tape.put({ agent: "ops-1", at: 5000, calls: [{ tool: "jira_search", args: { status: "Open" }, text: "SAME", isError: false }], result: { units: 1 } });
	const s = { agent: "ops-1", now: () => 5000, spentToday: () => 0, call: async () => ({ text: "SAME", isError: true }) };
	await assert.rejects(replaying(tape).shift(s as any), /diverged/);
});

test("replay reads the entry for the calling agent, not ops-1", async () => {
	// kills: tape.get with a hard-coded agent (single-agent suites never notice)
	const tape = new Tape();
	tape.put({ agent: "ops-2", at: 1000, calls: [], result: { units: 1 } });
	const stub = (agent: string) => ({ agent, now: () => 1000, spentToday: () => 0, call: async () => { throw new Error("must not be called"); } });
	assert.deepEqual(await replaying(tape).shift(stub("ops-2") as any), { units: 1 });
	await assert.rejects(replaying(tape).shift(stub("ops-1") as any), /no shift/);
});

test("an agent id with a colon records and replays cleanly", async () => {
	// pin: tape keys stay unambiguous when the id itself holds a separator
	const tape = new Tape();
	const live = fakeModel();
	const a = open("extra-colon", ["ops:1"]);
	await runAgents(a, { agents: [{ id: "ops:1", brain: recording(live.brain, tape), everyMs: HOUR }], untilDay: 1 });
	assert.ok(tape.size >= 23, `every shift recorded (${tape.size})`);
	const b = open("extra-colon", ["ops:1"]);
	await runAgents(b, { agents: [{ id: "ops:1", brain: replaying(tape), everyMs: HOUR }], untilDay: 1 });
	assert.equal(b.hash(), a.hash());
	a.close(); b.close();
});

// ---- budget ----

test("a brain that returns nothing still spends a unit a shift", async () => {
	// kills: budgeted defaulting a missing cost to 0 (never degrades then)
	const voidModel = { tier: 2 as const, name: "void-model", async shift(s: any) { await rulesOps.shift(s); } };
	const w = open("extra-void");
	const rep = await runAgents(w, { agents: [{ id: "ops-1", brain: budgeted(voidModel, rulesOps, { unitsPerDay: 3 }), everyMs: HOUR }], untilDay: 2 });
	const shifts = w.events().filter((e: any) => e.type === "agent.shift");
	assert.equal(shifts.filter((e: any) => e.payload.tier === 2).length, 7, "three model shifts a day, then Tier 1 (plus day 2's midnight shift)");
	assert.equal(rep.degraded, 41);
	w.close();
});

test("a degraded shift adds no spend", async () => {
	// kills: degraded shifts reporting units 1 (the next day starts in debt)
	const live = fakeModel(3);
	const w = open("extra-dunits");
	await runAgents(w, { agents: [{ id: "ops-1", brain: budgeted(live.brain, rulesOps, { unitsPerDay: 30 }), everyMs: HOUR }], untilDay: 3 });
	const shifts = w.events().filter((e: any) => e.type === "agent.shift");
	const degraded = shifts.filter((e: any) => e.payload.degraded);
	assert.ok(degraded.length > 0, "some shifts really degraded");
	assert.ok(degraded.every((e: any) => e.payload.units === 0), "a fallback shift is free");
	assert.ok(shifts.filter((e: any) => !e.payload.degraded).every((e: any) => e.payload.units === 3));
	w.close();
});

test("two agents on different budgets do not share spend", async () => {
	// kills: one spend ledger for all agents (B would pay for A's shifts)
	const a = fakeModel(3), b = fakeModel(3);
	const w = open("extra-2bud", ["ops-A", "ops-B"]);
	await runAgents(w, {
		agents: [
			{ id: "ops-A", brain: budgeted(a.brain, rulesOps, { unitsPerDay: 6 }), everyMs: HOUR },
			{ id: "ops-B", brain: budgeted(b.brain, rulesOps, { unitsPerDay: 3 }), everyMs: HOUR },
		],
		untilDay: 2,
	});
	const shifts = (id: string) => w.events().filter((e: any) => e.type === "agent.shift" && e.actor === id);
	assert.equal(shifts("ops-A").filter((e: any) => e.payload.tier === 2).length, 5, "A gets two model shifts a day (plus day 2's midnight shift)");
	assert.equal(shifts("ops-B").filter((e: any) => e.payload.tier === 2).length, 2, "B gets one model shift a day (its midnight shift is cut: it wakes 1 ms later)");
	assert.equal(shifts("ops-B")[0].payload.tier, 2, "B's first shift is its own, not A's bill");
	w.close();
});

test("a fractional daily budget buys exactly what it says", async () => {
	// kills: flooring the budget (0.5 becomes 0: the model never runs)
	const pricey = { tier: 2 as const, name: "pricey", async shift() { return { units: 1 }; } };
	const w = open("extra-frac");
	await runAgents(w, { agents: [{ id: "ops-1", brain: budgeted(pricey, rulesOps, { unitsPerDay: 0.5 }), everyMs: HOUR }], untilDay: 2 });
	const shifts = w.events().filter((e: any) => e.type === "agent.shift");
	assert.equal(shifts.filter((e: any) => e.payload.tier === 2).length, 3, "one model shift a day (plus day 2's midnight shift)");
	assert.equal(shifts[0].payload.tier, 2);
	w.close();
});

test("midnight starts a fresh budget, even across a restart", async () => {
	// kills: day-boundary off-by-ones (ceil/frozen ledgers move midnight's shift)
	const mk = () => budgeted(fakeModel(3).brain, rulesOps, { unitsPerDay: 3 });
	const whole = open("mid-whole");
	await runAgents(whole, { agents: [{ id: "ops-1", brain: mk(), everyMs: HOUR }], untilDay: 2 });
	const at = (vtime: number) => whole.events().filter((e: any) => e.type === "agent.shift" && e.vtime === vtime);
	assert.equal(at(DAY).length, 1, "a shift runs at exactly midnight");
	assert.equal(at(DAY)[0].payload.tier, 2, "midnight belongs to the new day");
	assert.ok(!at(DAY)[0].payload.degraded);
	assert.ok(at(DAY - HOUR)[0].payload.degraded, "23:00 still counts as the old day");
	const path = join(dir, "mid.sqlite");
	const spec = withAgents(itopsSpec("none"), ["ops-1"], HOUR);
	const x = World.open(path, { spec, seed: "mid-whole", rng: seededRng });
	await runAgents(x, { agents: [{ id: "ops-1", brain: mk(), everyMs: HOUR }], untilDay: 2, maxShifts: 5 });
	x.close();
	const y = World.open(path, { spec, seed: "mid-whole", rng: seededRng });
	await runAgents(y, { agents: [{ id: "ops-1", brain: mk(), everyMs: HOUR }], untilDay: 2 });
	assert.equal(y.hash(), whole.hash(), "a restart before midnight refills nothing");
	whole.close(); y.close();
});

test("recording a budgeted brain keeps the fallback's name and tier", async () => {
	// kills: recording that stamps every entry with the outer brain (degraded replays as Tier 2)
	const live = fakeModel(3);
	const tape = new Tape();
	const w = open("extra-recbud");
	await runAgents(w, { agents: [{ id: "ops-1", brain: recording(budgeted(live.brain, rulesOps, { unitsPerDay: 3 }), tape), everyMs: HOUR }], untilDay: 2 });
	const degraded = [];
	for (let k = 1; k <= 48; k++) { const e = tape.get("ops-1", k * HOUR) as any; if (e?.result?.degraded) degraded.push(e); }
	assert.ok(degraded.length > 40, `most shifts degraded (${degraded.length})`);
	assert.ok(degraded.every((e: any) => e.result.tier === 1 && e.result.brain === "rules-ops"));
	w.close();
});

test("the report counts every shift, call and error", async () => {
	// kills: a dead rep.calls counter (nothing else reads it)
	const w = open("extra-rep");
	const rep = await runAgents(w, { agents: [OPS], untilDay: 2 });
	const shifts = w.events().filter((e: any) => e.type === "agent.shift");
	assert.equal(rep.shifts, shifts.length);
	assert.equal(rep.calls, shifts.reduce((a: number, e: any) => a + (e.payload.calls ?? 0), 0));
	assert.ok(rep.calls >= rep.shifts, "every shift phones home at least once");
	assert.equal(rep.errors, 0);
	assert.equal(rep.degraded, 0);
	w.close();
});

// ---- model brain ----

type Req = { headers: Record<string, string | string[] | undefined>; body: any };
async function fakeServer(script: (r: Req, turn: number) => { content?: string; tool_calls?: any[] } | { status: number } | "hang") {
	const seen: Req[] = [];
	const srv = createServer((req, res) => {
		let raw = ""; req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const r: Req = { headers: req.headers, body: JSON.parse(raw || "{}") };
			seen.push(r);
			const out = script(r, seen.length - 1);
			if (out === "hang") return;
			if ("status" in out) { res.writeHead(out.status).end("boom"); return; }
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { role: "assistant", content: out.content ?? null, tool_calls: out.tool_calls } }], usage: {} }));
		});
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as any).port;
	return { url: `http://127.0.0.1:${port}/v1`, seen, close: () => srv.close() };
}
const toolCall = (id: string, name: string, args: object) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const mbSession = (w: any, agent = "ops-1") => {
	const tools = new require_tools.SyntheticTools(w);
	return { agent, now: () => w.now(), spentToday: () => 0, call: async (t: string, a: any) => tools.call(t, a, { agent }) };
};

test("the model is asked with JSON", async () => {
	// kills: a wrong content-type (the fake server ignores it; the gateway would not)
	const srv = await fakeServer(() => ({ content: "ok" }));
	const w = open("extra-ct");
	await modelBrain({ baseUrl: srv.url, apiKey: "k", model: "m", role: "ops" }).shift(mbSession(w) as any);
	assert.match(String(srv.seen[0].headers["content-type"] ?? ""), /application\/json/);
	w.close(); srv.close();
});

test("array arguments are rejected as not-an-object", async () => {
	// kills: dropping the Array check (an array would reach the tools as params)
	const srv = await fakeServer((r, turn) => turn === 0
		? { tool_calls: [{ id: "a", type: "function", function: { name: "jira_search", arguments: "[1,2]" } }] }
		: { content: "done" });
	const w = open("extra-arr");
	await modelBrain({ baseUrl: srv.url, apiKey: "k", model: "m", role: "ops" }).shift(mbSession(w) as any);
	const tm = srv.seen[1].body.messages.filter((m: any) => m.role === "tool");
	assert.match(tm[0].content, /JSON object/);
	w.close(); srv.close();
});

test("the request really times out near timeoutMs", async () => {
	// kills: a stretched timeout (the hang still rejects, just 100x too late)
	const srv = await fakeServer(() => "hang");
	const w = open("extra-to");
	const t0 = Date.now();
	await assert.rejects(modelBrain({ baseUrl: srv.url, apiKey: "k", model: "m", role: "ops", timeoutMs: 200 }).shift(mbSession(w) as any), /timed out|abort/i);
	assert.ok(Date.now() - t0 < 5000, "a 100x timeout would take 20 s");
	srv.close(); w.close();
});

test("an empty tool_calls list ends the shift", async () => {
	// kills: testing the array instead of its length (one ghost turn per shift)
	const srv = await fakeServer((r, turn) => turn === 0 ? { tool_calls: [] } : { content: "done" });
	const w = open("extra-empty");
	const res = await modelBrain({ baseUrl: srv.url, apiKey: "k", model: "m", role: "ops" }).shift(mbSession(w) as any);
	assert.equal(srv.seen.length, 1, "no second turn for zero calls");
	assert.deepEqual(res, { units: 1 });
	w.close(); srv.close();
});

test("a tool call without words is forwarded as content null", async () => {
	// kills: null turning into "" (the gateway treats them differently)
	const srv = await fakeServer((r, turn) => turn === 0
		? { tool_calls: [toolCall("c1", "jira_search", { status: "Open" })] }
		: { content: "done" });
	const w = open("extra-nullc");
	await modelBrain({ baseUrl: srv.url, apiKey: "k", model: "m", role: "ops" }).shift(mbSession(w) as any);
	const asst = srv.seen[1].body.messages.filter((m: any) => m.role === "assistant");
	assert.equal(asst[0].content, null);
	assert.deepEqual(asst[0].tool_calls.map((c: any) => c.id), ["c1"]);
	w.close(); srv.close();
});

test("a response without choices fails loudly", async () => {
	// kills: dropping the ?. (a TypeError instead of "no message")
	const srv = createServer((req, res) => {
		req.on("data", () => {});
		req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({})); });
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(srv.address() as any).port}/v1`;
	const w = open("extra-nc");
	await assert.rejects(modelBrain({ baseUrl: url, apiKey: "k", model: "m", role: "ops" }).shift(mbSession(w) as any), /no message/);
	srv.close(); w.close();
});

test("words alongside tool calls do not skip the tools", async () => {
	// kills: returning early on content (the tools would never run)
	const srv = await fakeServer((r, turn) => turn === 0
		? { content: "let me look", tool_calls: [toolCall("c1", "jira_search", { status: "Open" })] }
		: { content: "done" });
	const w = open("extra-both");
	const res = await modelBrain({ baseUrl: srv.url, apiKey: "k", model: "m", role: "ops" }).shift(mbSession(w) as any);
	assert.equal(srv.seen.length, 2, "the call still runs");
	assert.deepEqual(res, { units: 2 });
	assert.equal(srv.seen[1].body.messages.filter((m: any) => m.role === "tool").length, 1);
	w.close(); srv.close();
});

test("two calls sharing one id both run", async () => {
	// kills: deduping by id (the second answer would go missing)
	const dup = [
		{ id: "dup", type: "function", function: { name: "jira_search", arguments: JSON.stringify({ status: "Open" }) } },
		{ id: "dup", type: "function", function: { name: "k8s_pods", arguments: JSON.stringify({ namespace: "prod" }) } },
	];
	const srv = await fakeServer((r, turn) => turn === 0 ? { tool_calls: dup } : { content: "done" });
	const w = open("extra-dup");
	await modelBrain({ baseUrl: srv.url, apiKey: "k", model: "m", role: "ops" }).shift(mbSession(w) as any);
	const tm = srv.seen[1].body.messages.filter((m: any) => m.role === "tool");
	assert.equal(tm.length, 2, "no dedup: both answers are shown");
	assert.deepEqual(tm.map((m: any) => m.tool_call_id), ["dup", "dup"]);
	w.close(); srv.close();
});

test("a call without arguments means an empty object", async () => {
	// kills: defaulting missing arguments to "" (every bare call would error)
	const srv = await fakeServer((r, turn) => turn === 0
		? { tool_calls: [{ id: "m1", type: "function", function: { name: "jira_search" } }] }
		: { content: "done" });
	const w = open("extra-noargs");
	const res = await modelBrain({ baseUrl: srv.url, apiKey: "k", model: "m", role: "ops" }).shift(mbSession(w) as any);
	const tm = srv.seen[1].body.messages.filter((m: any) => m.role === "tool");
	assert.doesNotMatch(tm[0].content, /arguments must be/i);
	assert.deepEqual(res, { units: 2 });
	w.close(); srv.close();
});

// ---- Tier 1 rules, one alternative at a time ----

// canned tool text: the brain only ever sees strings, so the rules pin down per alternative
const stubSession = (texts: Record<string, string>) => {
	const acted: { tool: string; args: any }[] = [];
	const session = {
		agent: "stub", now: () => 0, spentToday: () => 0,
		call: async (tool: string, args: any) => { acted.push({ tool, args }); return { text: texts[tool] ?? "ok", isError: false }; },
	};
	return { acted, session };
};

test("failover needs the port in the refusal", async () => {
	// kills: matching "connection refused: db" with no port (a stray line would fail over)
	const t = stubSession({
		jira_search: "OPS-102  [Open]  High  Unassigned  5m ago  checkout: checkout error rate 90%",
		k8s_logs: "12:00 connection refused: db",
	});
	await rulesOps.shift(t.session as any);
	assert.ok(!t.acted.some((c) => c.tool === "db_failover"), "a port-less refusal is not a database outage");
});

test("an expiry without the x509 word still rotates", async () => {
	// kills: matching x509 alone (wording variants would miss the rotation)
	const t = stubSession({
		jira_search: "OPS-103  [Open]  High  Unassigned  5m ago  payments: payments error rate 60%",
		k8s_logs: "12:00 tls: certificate has expired",
	});
	await rulesOps.shift(t.session as any);
	assert.deepEqual(t.acted.filter((c) => c.tool === "cert_rotate").map((c) => c.args.service), ["payments"]);
});

test("an OOM kill alone rolls back", async () => {
	// kills: matching only the softer GC lines (a hard OOM would sit there)
	const t = stubSession({
		jira_search: "OPS-104  [Open]  High  Unassigned  5m ago  api: api error rate 35%",
		k8s_logs: "12:00 OOMKilled: container exceeded its memory limit",
	});
	await rulesOps.shift(t.session as any);
	assert.ok(t.acted.some((c) => c.tool === "k8s_rollback"), "the leaking build goes, not just a restart");
});

test("shedding load alone scales", async () => {
	// kills: matching only "queue full" (the other half of the line would be dead)
	const t = stubSession({
		jira_search: "OPS-105  [Open]  High  Unassigned  5m ago  api: api error rate 8%",
		k8s_logs: "12:00 backpressure: shedding load, latency high",
		k8s_deployments: "api  ready=2/2  image=registry.local/api:v141  configmaps=api-config",
	});
	await rulesOps.shift(t.session as any);
	assert.equal(t.acted.filter((c) => c.tool === "k8s_scale").length, 1);
});

test("capacity grows by exactly one replica", async () => {
	// kills: scaling by two (it heals, but burns a spare every time)
	const t = stubSession({
		jira_search: "OPS-106  [Open]  High  Unassigned  5m ago  api: api error rate 8%",
		k8s_logs: "12:00 request queue full, shedding load",
		k8s_deployments: "api  ready=2/2  image=registry.local/api:v141  configmaps=api-config",
	});
	await rulesOps.shift(t.session as any);
	const s = t.acted.filter((c) => c.tool === "k8s_scale");
	assert.equal(s.length, 1);
	assert.equal(s[0].args.replicas, 3, "one more replica, not two");
});

test("a colon in the summary does not hide a false alarm", async () => {
	// kills: stopping the summary at the first colon (the dismissal would never fire)
	const t = stubSession({
		jira_search: "OPS-107  [Open]  High  Unassigned  5m ago  api: note: single sample",
		k8s_logs: "12:00 level=info msg=\"request served\"",
	});
	await rulesOps.shift(t.session as any);
	assert.ok(t.acted.some((c) => c.tool === "alert_dismiss"), "the whole summary is read, not just up to the colon");
});

test("scale reads the total, not the ready count", async () => {
	// kills: reading ready= instead of /total (fewer heads than the fleet has)
	const t = stubSession({
		jira_search: "OPS-108  [Open]  High  Unassigned  5m ago  api: api error rate 8%",
		k8s_logs: "12:00 request queue full, shedding load",
		k8s_deployments: "api  ready=0/3  image=registry.local/api:v141  configmaps=api-config",
	});
	await rulesOps.shift(t.session as any);
	const s = t.acted.filter((c) => c.tool === "k8s_scale");
	assert.equal(s.length, 1);
	assert.equal(s[0].args.replicas, 4);
});
