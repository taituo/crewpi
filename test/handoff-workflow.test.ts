// Real Temporal (needs the `temporal` CLI): the handoff watchdog escalates when nobody picks a task up, when it is
// overdue, or when it was rejected/failed, stays quiet when all is well, and survives a worker crash while waiting.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";

const hasCli = spawnSync("temporal", ["--version"]).status === 0;
const PORT = 17234, ADDR = `127.0.0.1:${PORT}`;
let server: ChildProcess;
after(() => server?.kill());

const escalations: { handoffId: string; reason: string }[] = [];
const activities = { escalateHandoff: async (a: { handoffId: string; reason: string }) => { escalations.push(a); return { status: "escalated", reroutedTo: null }; } };
const worker = async (queue: string) => Worker.create({ connection: await NativeConnection.connect({ address: ADDR }), taskQueue: queue, workflowsPath: resolve("src/workflows/index.js"), activities });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("handoff watchdog", { skip: !hasCli, timeout: 180_000 }, async () => {
	server = spawn("temporal", ["server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(PORT), "--db-filename", join(mkdtempSync(join(tmpdir(), "tmp-")), "t.db"), "--log-level", "error"], { stdio: "ignore" });
	let client: Client | undefined;
	for (let i = 0; i < 80 && !client; i++) {
		try { client = new Client({ connection: await Connection.connect({ address: ADDR, connectTimeout: 1000 }) }); } catch { await sleep(250); }
	}
	assert.ok(client, "temporal dev server started");
	const w = await worker("h1"); const running = w.run();
	const start = (id: string, input: object) => client!.workflow.start("handoffWorkflow", { taskQueue: "h1", workflowId: `handoff:${id}`, args: [{ handoffId: id, ...input }] });

	// nobody acknowledges
	const noAck: any = await (await start("h-noack", { ackWithinMs: 600, dueAtMs: Date.now() + 60_000 })).result();
	assert.deepEqual([noAck.outcome, noAck.why], ["escalated", "no-ack"]);
	assert.deepEqual(escalations.map((e) => e.reason), ["not acknowledged in time"]);

	// acknowledged and finished in time: nothing happens
	escalations.length = 0;
	const ok = await start("h-ok", { ackWithinMs: 5_000, dueAtMs: Date.now() + 60_000 });
	await ok.signal("handoffState", { status: "accepted" });
	await ok.signal("handoffState", { status: "in_progress" });
	await ok.signal("handoffState", { status: "completed" });
	assert.equal(((await ok.result()) as any).outcome, "completed");
	assert.equal(escalations.length, 0, "a healthy handoff is never escalated");

	// acknowledged but never finished
	const late: any = await (await (async () => { const h = await start("h-late", { ackWithinMs: 5_000, dueAtMs: Date.now() + 900 }); await h.signal("handoffState", { status: "accepted" }); return h; })()).result();
	assert.deepEqual([late.outcome, late.why], ["escalated", "overdue"]);
	assert.deepEqual(escalations.map((e) => e.reason), ["overdue"]);

	// rejected and failed are escalated too
	escalations.length = 0;
	for (const s of ["rejected", "failed"]) {
		const h = await start(`h-${s}`, { ackWithinMs: 5_000, dueAtMs: Date.now() + 60_000 });
		await h.signal("handoffState", { status: "accepted" });
		await h.signal("handoffState", { status: s });
		assert.equal(((await h.result()) as any).why, s);
	}
	assert.deepEqual(escalations.map((e) => e.reason).sort(), ["failed", "rejected"]);

	// a duplicate start with the same id is refused by Temporal (one watchdog per handoff)
	const dup = await start("h-dup", { ackWithinMs: 30_000 });
	await assert.rejects(start("h-dup", { ackWithinMs: 30_000 }), /already/i);
	await dup.signal("handoffState", { status: "cancelled" });
	await dup.result();

	// the worker dies while the handoff waits for its acknowledgement; the timer survives and fires on a new worker
	escalations.length = 0;
	const waiting = await start("h-crash", { ackWithinMs: 2_500, dueAtMs: Date.now() + 60_000 });
	w.shutdown(); await running;
	await sleep(3_000); // the ack deadline passes while no worker exists
	const w2 = await worker("h1"); const run2 = w2.run();
	const out: any = await waiting.result();
	assert.deepEqual([out.outcome, out.why], ["escalated", "no-ack"]);
	assert.equal(escalations.filter((e) => e.handoffId === "h-crash").length, 1, "escalated exactly once");
	w2.shutdown(); await run2;
});
