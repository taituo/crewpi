// Real Temporal: starts a dev server (needs the `temporal` CLI on PATH), runs the workflow with stub activities
// that record what the agents would be asked, and proves the process survives a worker crash.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";

const hasCli = spawnSync("temporal", ["--version"]).status === 0;
const PORT = 17233, ADDR = `127.0.0.1:${PORT}`;
let server: ChildProcess;
after(() => server?.kill());

type Call = { fn: string; agent?: string; key?: string };
const calls: Call[] = [];
const activities = {
	postNotice: async (a: any) => { calls.push({ fn: "postNotice" }); void a; },
	askAgent: async (a: any) => { calls.push({ fn: "askAgent", agent: a.agent, key: a.key }); return `answer from ${a.agent} for ${a.key}`; },
	postDecisionCard: async () => { calls.push({ fn: "postDecisionCard" }); },
	closeCase: async (a: any) => { calls.push({ fn: "closeCase", key: String(a.resolution).split("\n")[0] }); },
};

async function worker(queue: string) {
	const connection = await NativeConnection.connect({ address: ADDR });
	return Worker.create({ connection, taskQueue: queue, workflowsPath: resolve("src/workflows/index.js"), activities });
}

test("incident workflow: diagnose, plan, wait for a person, execute, monitor, verify, close", { skip: !hasCli, timeout: 180_000 }, async () => {
	server = spawn("temporal", ["server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(PORT), "--db-filename", join(mkdtempSync(join(tmpdir(), "tmp-")), "t.db"), "--log-level", "error"], { stdio: "ignore" });
	let client: Client | undefined;
	for (let i = 0; i < 80 && !client; i++) {
		try { client = new Client({ connection: await Connection.connect({ address: ADDR, connectTimeout: 1000 }) }); } catch { await new Promise((r) => setTimeout(r, 250)); }
	}
	assert.ok(client, "temporal dev server started");

	const w = await worker("q1");
	const running = w.run();
	const h = await client.workflow.start("incidentWorkflow", { taskQueue: "q1", workflowId: "incident-t1", args: [{ channelId: "c1", ticket: "OPS-1", brief: "queue grows", lead: "insight", monitorSeconds: 1 }] });
	for (let i = 0; i < 100; i++) { const s: any = await h.query("status").catch(() => undefined); if (s?.step === "await-human") break; await new Promise((r) => setTimeout(r, 200)); }
	assert.equal(((await h.query("status")) as any).step, "await-human", "stops and waits for a person");
	assert.deepEqual(calls.filter((c) => c.fn === "askAgent").map((c) => `${c.agent}:${c.key}`), ["insight:diagnose", "ops:plan"]);
	assert.equal(calls.filter((c) => c.fn === "closeCase").length, 0, "nothing is closed before the decision");

	await h.signal("decision", { decision: "continue", by: "alice", note: "go" });
	const result: any = await h.result();
	assert.equal(result.outcome, "resolved");
	assert.deepEqual(calls.filter((c) => c.fn === "askAgent").map((c) => `${c.agent}:${c.key}`), ["insight:diagnose", "ops:plan", "ops:execute", "insight:verify"]);
	assert.equal(calls.at(-1)!.fn, "closeCase");
	w.shutdown(); await running;

	// A rejected path: abort leaves the case open and changes nothing.
	calls.length = 0;
	const w2 = await worker("q2"); const run2 = w2.run();
	const h2 = await client.workflow.start("incidentWorkflow", { taskQueue: "q2", workflowId: "incident-t2", args: [{ channelId: "c2", brief: "x", monitorSeconds: 1 }] });
	for (let i = 0; i < 100 && ((await h2.query("status").catch(() => ({}))) as any).step !== "await-human"; i++) await new Promise((r) => setTimeout(r, 200));
	await h2.signal("decision", { decision: "abort", by: "bob" });
	assert.equal(((await h2.result()) as any).outcome, "aborted");
	assert.ok(!calls.some((c) => c.fn === "closeCase" || c.key === "execute"), "no execution and no close after an abort");

	// No decision in time: the workflow ends by itself and changes nothing.
	calls.length = 0;
	const h3 = await client.workflow.start("incidentWorkflow", { taskQueue: "q2", workflowId: "incident-t3", args: [{ channelId: "c3", brief: "x", decisionTimeoutMs: 1500 }] });
	assert.equal(((await h3.result()) as any).outcome, "timed-out");
	w2.shutdown(); await run2;
});

test("durable: the worker dies while the workflow waits for a person; a new worker continues without redoing finished steps", { skip: !hasCli, timeout: 180_000 }, async () => {
	const client = new Client({ connection: await Connection.connect({ address: ADDR }) });
	calls.length = 0;
	const w1 = await worker("q3"); const run1 = w1.run();
	const h = await client.workflow.start("incidentWorkflow", { taskQueue: "q3", workflowId: "incident-t4", args: [{ channelId: "c4", ticket: "OPS-4", brief: "crash test", monitorSeconds: 1 }] });
	for (let i = 0; i < 100 && ((await h.query("status").catch(() => ({}))) as any).step !== "await-human"; i++) await new Promise((r) => setTimeout(r, 200));
	assert.equal(calls.filter((c) => c.fn === "askAgent").length, 2);

	w1.shutdown(); await run1; // the process holding the workflow is gone
	await h.signal("decision", { decision: "continue", by: "alice" }); // a person decides while NO worker is running
	const w2 = await worker("q3"); const run2 = w2.run();
	const out: any = await h.result();
	assert.equal(out.outcome, "resolved");
	const asks = calls.filter((c) => c.fn === "askAgent").map((c) => c.key);
	assert.equal(asks.filter((k) => k === "diagnose").length, 1, "diagnose was not repeated after the restart");
	assert.deepEqual(asks, ["diagnose", "plan", "execute", "verify"]);
	w2.shutdown(); await run2;
});
