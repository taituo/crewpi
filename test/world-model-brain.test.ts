// M3d: a Tier 2 brain is a language model with the synthetic tools, reached through an OpenAI-compatible endpoint (the inference gateway).
// Tested here against a local fake server that plays the model, so nothing real is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-mb-"));
process.env.SESSION_SECRET = "test-secret";

const { World, HOUR } = await import("../src/world/engine.ts");
const { seededRng } = await import("../src/world/rng.ts");
const { itopsSpec } = await import("../src/world/itops/spec.ts");
const { withAgents, runAgents, Tape, recording, replaying } = await import("../src/world/agents.ts");
const { modelBrain } = await import("../src/world/model-brain.ts");

const dir = mkdtempSync(join(tmpdir(), "crew-mb-files-"));
let n = 0;
const open = (seed = "mb-1") => World.open(join(dir, `w${++n}.sqlite`), { spec: withAgents(itopsSpec("none"), ["ops-1"], HOUR), seed, rng: seededRng });

type Req = { headers: Record<string, string | string[] | undefined>; body: any };
/** A fake model: `script(request, turn)` returns the assistant message for each request. */
async function fakeServer(script: (r: Req, turn: number) => { content?: string; tool_calls?: any[] } | { status: number } | "hang") {
	const seen: Req[] = [];
	const srv = createServer((req, res) => {
		let raw = ""; req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const r: Req = { headers: req.headers, body: JSON.parse(raw || "{}") };
			seen.push(r);
			const out = script(r, seen.length - 1);
			if (out === "hang") return; // never answers
			if ("status" in out) { res.writeHead(out.status).end("boom"); return; }
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { role: "assistant", content: out.content ?? null, tool_calls: out.tool_calls } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
		});
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as any).port;
	return { url: `http://127.0.0.1:${port}/v1`, seen, close: () => srv.close() };
}
const toolCall = (id: string, name: string, args: object) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const session = (w: any, agent = "ops-1") => {
	const { SyntheticTools } = require_tools;
	const tools = new SyntheticTools(w);
	return { agent, now: () => w.now(), spentToday: () => 0, call: async (t: string, a: any) => tools.call(t, a, { agent }) };
};
const require_tools = await import("../src/world/itops/tools.ts");

test("the model's tool calls are run in the world and their results are shown to it; the shift ends when it answers in words", async () => {
	const srv = await fakeServer((r, turn) => turn === 0
		? { tool_calls: [toolCall("c1", "jira_search", { status: "Open" }), toolCall("c2", "k8s_deployments", { namespace: "prod" })] }
		: { content: "Nothing is open. All quiet." });
	const w = open();
	const brain = modelBrain({ baseUrl: srv.url, apiKey: "k", model: "m", role: "ops" });
	const res = await brain.shift(session(w));
	assert.equal(srv.seen.length, 2, "two model turns");
	const second = srv.seen[1].body.messages;
	const toolMsgs = second.filter((m: any) => m.role === "tool");
	assert.deepEqual(toolMsgs.map((m: any) => m.tool_call_id), ["c1", "c2"], "each call answered, in order");
	assert.match(toolMsgs[1].content, /^api\s+ready=2\/2/m, "with the world's real output");
	assert.deepEqual(res, { units: 2 });
	assert.equal(brain.tier, 2);
	w.close(); srv.close();
});

test("the model sees the tools with the real tools' names and parameters, and nothing hidden", async () => {
	const srv = await fakeServer(() => ({ content: "ok" }));
	const w = open();
	await modelBrain({ baseUrl: srv.url, apiKey: "k", model: "m", role: "ops" }).shift(session(w));
	const body = srv.seen[0].body;
	const { SyntheticTools } = require_tools;
	const t = new SyntheticTools(w);
	assert.deepEqual(body.tools.map((x: any) => x.function.name).sort(), t.names().sort());
	for (const x of body.tools) assert.deepEqual(Object.keys(x.function.parameters.properties).sort(), t.paramNames(x.function.name), x.function.name);
	assert.equal(body.model, "m");
	const all = JSON.stringify(body);
	for (const secret of ["cause", "rootService", "neededReplicas", "badVersion", "rightFix", "hidden"]) assert.ok(!all.includes(secret), `the request must not mention "${secret}"`);
	w.close(); srv.close();
});

test("the same agent always sends the same session id (the gateway routes sticky), and the key goes only in the header", async () => {
	const srv = await fakeServer(() => ({ content: "ok" }));
	const w = open();
	const b = modelBrain({ baseUrl: srv.url, apiKey: "sekret-key", model: "m", role: "ops" });
	await b.shift(session(w, "ops-1")); await b.shift(session(w, "ops-1")); await b.shift(session(w, "ops-2"));
	const ids = srv.seen.map((r) => r.headers["x-session-id"]);
	assert.equal(ids[0], ids[1]);
	assert.notEqual(ids[0], ids[2]);
	assert.equal(srv.seen[0].headers.authorization, "Bearer sekret-key");
	assert.ok(!JSON.stringify(srv.seen[0].body).includes("sekret-key"));
	w.close(); srv.close();
});

test("a model that never stops calling tools is cut off, a server error and a hang become shift errors", async () => {
	const loop = await fakeServer(() => ({ tool_calls: [toolCall("x", "jira_search", {})] }));
	const w = open();
	let err = "";
	try { await modelBrain({ baseUrl: loop.url, apiKey: "k", model: "m", role: "ops", maxTurns: 4 }).shift(session(w)); } catch (e) { err = (e as Error).message; }
	assert.match(err, /more than 4 turns/);
	assert.equal(loop.seen.length, 4);
	loop.close();
	const bad = await fakeServer(() => ({ status: 500 }));
	await assert.rejects(modelBrain({ baseUrl: bad.url, apiKey: "k", model: "m", role: "ops" }).shift(session(w)), /500/);
	bad.close();
	const hang = await fakeServer(() => "hang");
	await assert.rejects(modelBrain({ baseUrl: hang.url, apiKey: "k", model: "m", role: "ops", timeoutMs: 150 }).shift(session(w)), /timed out|abort/i);
	hang.close(); w.close();
});

test("a model that invents a tool or sends broken arguments gets an error back, like a real agent would, and the world is unharmed", async () => {
	const srv = await fakeServer((r, turn) => turn === 0
		? { tool_calls: [toolCall("a", "repo_write", { path: "x" }), toolCall("b", "k8s_pods", {}), { id: "c", type: "function", function: { name: "k8s_pods", arguments: "{not json" } }] }
		: { content: "done" });
	const w = open();
	const before = w.hash();
	await modelBrain({ baseUrl: srv.url, apiKey: "k", model: "m", role: "ops" }).shift(session(w));
	const tm = srv.seen[1].body.messages.filter((m: any) => m.role === "tool");
	assert.match(tm[0].content, /no such tool/i);
	assert.match(tm[1].content, /namespace is required/i);
	assert.match(tm[2].content, /arguments/i);
	assert.equal(w.hash(), before);
	w.close(); srv.close();
});

test("a real model run can be recorded and then replayed with zero requests to the server", async () => {
	let turn = 0;
	const srv = await fakeServer((r) => {
		const last = r.body.messages[r.body.messages.length - 1];
		return last.role === "tool" ? { content: "looked, nothing to do" } : { tool_calls: [toolCall(`t${++turn}`, "jira_search", { status: "Open" })] };
	});
	const tape = new Tape();
	const a = open();
	await runAgents(a, { agents: [{ id: "ops-1", brain: recording(modelBrain({ baseUrl: srv.url, apiKey: "k", model: "m", role: "ops" }), tape), everyMs: HOUR }], untilDay: 2 });
	const served = srv.seen.length;
	assert.ok(served >= 40);
	const b = open();
	await runAgents(b, { agents: [{ id: "ops-1", brain: replaying(tape), everyMs: HOUR }], untilDay: 2 });
	assert.equal(srv.seen.length, served, "replay sent nothing");
	assert.equal(b.hash(), a.hash());
	a.close(); b.close(); srv.close();
});
