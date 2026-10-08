// The live world with a language model behind the operators: the model is consulted only when something is open (a pager, not a
// polling loop), on a daily budget, recorded on a tape, with the conversation id the gateway needs for sticky routing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "crew-livemodel-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test-secret";

const { startLiveWorld } = await import("../src/world/live.ts");
const { store } = await import("../src/db.ts");
const { Tape } = await import("../src/world/agents.ts");

type Req = { headers: Record<string, any>; body: any };
const seen: Req[] = [];
const srv = createServer((req, res) => {
	let raw = ""; req.on("data", (c) => (raw += c));
	req.on("end", () => {
		const body = JSON.parse(raw); seen.push({ headers: req.headers, body });
		const msgs = body.messages;
		const last = msgs.at(-1);
		let message: any = { role: "assistant", content: "done" };
		if (last.role === "user") message = { role: "assistant", content: null, tool_calls: [{ id: "c" + seen.length, type: "function", function: { name: "jira_search", arguments: '{"status":"Open"}' } }] };
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message }] }));
	});
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(srv.address() as any).port}/v1`;
const wait = async (cond: () => boolean, ms = 30000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return cond(); };
const rows = (n: string) => store.listMessages(`world-${n}`, 100000) as any[];

test("a model-driven live world: the model is a pager (silent when nothing is open), budgeted, recorded, and the gateway gets a conversation id", async () => {
	const dir = join(dataDir, "worlds");
	const live = startLiveWorld({ dir, name: "lm", tickMs: 20, team: "ops=2,dev=1", faults: "heavy", brain: { kind: "model", baseUrl: base, apiKey: "live-key", model: "fake-m", budget: 12 }, log: () => {} });
	assert.ok(await wait(() => rows("lm").length > 15), "the world talks");
	live.stop();
	await new Promise((r) => setTimeout(r, 200));

	// The model was consulted, but far less often than there were shifts: idle shifts never reach it.
	const { Observer } = await import("../src/world/observe.ts");
	const o = new Observer(join(dir, "lm.sqlite"));
	const shifts = o.events({ type: "agent.shift", limit: 100000 }).filter((e: any) => e.actor.startsWith("ops-"));
	o.close();
	assert.ok(seen.length > 0, "the model was asked at least once");
	assert.ok(shifts.length > 100, `${shifts.length} operator shifts happened`);
	assert.ok(seen.length < shifts.length / 2, `the model saw ${seen.length} requests for ${shifts.length} shifts: silent when nothing is open`);
	const modelShifts = shifts.filter((e: any) => e.payload.tier === 2 && e.payload.brain === "model:fake-m");
	assert.ok(modelShifts.length > 0 && modelShifts.length < shifts.length, "some shifts by the model, the rest by others");
	// budget: 12 units a day at >= 2 turns a shift is at most 6 model shifts per operator-day... in total per agent
	const perDay = new Map<string, number>();
	for (const e of modelShifts) { const k = `${e.actor}@${Math.floor(e.vtime / 86400000)}`; perDay.set(k, (perDay.get(k) ?? 0) + Number(e.payload.units)); }
	for (const [k, u] of perDay) assert.ok(u <= 12 + 8, `${k} spent ${u} units against a budget of 12 (one shift may overshoot)`);
	assert.ok(shifts.some((e: any) => e.payload.degraded) || modelShifts.length < 10, "running out of budget is visible");
	// the gateway needs a conversation id, and the key travels only in the header
	assert.ok(seen.every((r) => /^crew-world/.test(String(r.headers["x-session-id"]))));
	assert.equal(seen[0].headers.authorization, "Bearer live-key");
	assert.ok(!JSON.stringify(seen[0].body).includes("live-key"));
	// recorded
	const tape = join(dir, "lm.tape.jsonl");
	assert.ok(existsSync(tape));
	assert.ok(Tape.load(tape).size > 0);
});

test("without a model option the live world uses rules and makes no request at all", async () => {
	const before = seen.length;
	const live = startLiveWorld({ dir: join(dataDir, "worlds"), name: "rl", tickMs: 20, team: "ops=2,dev=1", faults: "heavy", log: () => {} });
	assert.ok(await wait(() => rows("rl").length > 10));
	live.stop();
	assert.equal(seen.length, before);
	srv.close();
});
