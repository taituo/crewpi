// Temporal's time-skipping test environment: when every workflow is waiting, the clock jumps to the next timer.
// So the watchdog's real defaults (5 minutes to acknowledge, 1 hour to finish) are tested in milliseconds,
// with no sleeping, on the exact workflow code that runs in production. (The real-server test in
// handoff-workflow.test.ts covers worker crashes; this one covers the long clocks.)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";

let env: TestWorkflowEnvironment | undefined;
let why = "";
try {
	env = await TestWorkflowEnvironment.createTimeSkipping();
} catch (e) {
	why = `the time-skipping test server could not start (it is downloaded on first use): ${(e as Error).message}`;
}
after(async () => { await env?.teardown(); });

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const escalations: { handoffId: string; reason: string; atVirtualMs: number }[] = [];
let q = 0;

async function withWorker<T>(fn: (queue: string) => Promise<T>): Promise<T> {
	const queue = `ts${++q}`;
	const w = await Worker.create({
		connection: env!.nativeConnection, taskQueue: queue, workflowsPath: resolve("src/workflows/index.js"),
		activities: { escalateHandoff: async (a: { handoffId: string; reason: string }) => { escalations.push({ ...a, atVirtualMs: await env!.currentTimeMs() }); return {}; } },
	});
	return w.runUntil(fn(queue));
}
const start = (queue: string, id: string, ackWithinMs: number | undefined, dueInMs: number | undefined, now: number) =>
	env!.client.workflow.start("handoffWorkflow", { taskQueue: queue, workflowId: id, args: [{ handoffId: id, ackWithinMs, dueAtMs: dueInMs ? now + dueInMs : undefined }] });

test("nobody acknowledges: escalated exactly 5 virtual minutes later", { skip: !env && why }, async () => {
	await withWorker(async (queue) => {
		const t0 = await env!.currentTimeMs(), wall = Date.now();
		const out: any = await (await start(queue, "t-noack", 5 * MIN, HOUR, t0)).result();
		assert.deepEqual([out.outcome, out.why], ["escalated", "no-ack"]);
		const e = escalations.find((x) => x.handoffId === "t-noack")!;
		assert.equal(e.reason, "not acknowledged in time");
		assert.equal(Math.round((e.atVirtualMs - t0) / MIN), 5);
		assert.ok(Date.now() - wall < 5000, "five virtual minutes did not take five real ones");
	});
});

test("acknowledged but not finished: escalated at the due time, not before", { skip: !env && why }, async () => {
	await withWorker(async (queue) => {
		const t0 = await env!.currentTimeMs();
		const h = await start(queue, "t-late", 5 * MIN, HOUR, t0);
		await h.signal("handoffState", { status: "accepted" });
		const out: any = await h.result();
		assert.deepEqual([out.outcome, out.why], ["escalated", "overdue"]);
		assert.equal(Math.round((escalations.find((x) => x.handoffId === "t-late")!.atVirtualMs - t0) / MIN), 60);
	});
});

test("a handoff finished in time is never escalated, however long the clock then runs", { skip: !env && why }, async () => {
	await withWorker(async (queue) => {
		const before = escalations.length, t0 = await env!.currentTimeMs();
		const h = await start(queue, "t-ok", 5 * MIN, HOUR, t0);
		await h.signal("handoffState", { status: "accepted" });
		await h.signal("handoffState", { status: "completed" });
		assert.equal(((await h.result()) as any).outcome, "completed");
		await env!.sleep(30 * DAY); // a month passes
		assert.equal(escalations.length, before, "no escalation appeared later");
	});
});

test("rejected and failed work is escalated at once, not at the deadline", { skip: !env && why }, async () => {
	await withWorker(async (queue) => {
		for (const s of ["rejected", "failed"]) {
			const t0 = await env!.currentTimeMs();
			const h = await start(queue, `t-${s}`, 5 * MIN, DAY, t0);
			await h.signal("handoffState", { status: "accepted" });
			await h.signal("handoffState", { status: s });
			await h.result();
			const e = escalations.find((x) => x.handoffId === `t-${s}`)!;
			assert.equal(e.reason, s);
			assert.ok(e.atVirtualMs - t0 < MIN, `${s} was escalated within a virtual minute, not after the day-long deadline`);
		}
	});
});

test("a year of daily wake-ups costs seconds: the clock leaps between timers", { skip: !env && why }, async () => {
	const w = await Worker.create({ connection: env!.nativeConnection, taskQueue: "year", workflowsPath: resolve("test/workflows/year.js"), activities: {} });
	await w.runUntil(async () => {
		const v0 = await env!.currentTimeMs(), wall = Date.now();
		const wakes = await env!.client.workflow.execute("yearOfDays", { taskQueue: "year", workflowId: "year-1", args: [365] });
		assert.equal(wakes, 365);
		// at least a year: the time-skipping server keeps leaping to the next timer whenever the client is slow to ask (a loaded machine
		// once measured 3650 days), so the elapsed virtual time is a lower bound, while the 365 wake-ups above are exact
		assert.ok(Math.round((await env!.currentTimeMs() - v0) / DAY) >= 365);
		assert.ok(Date.now() - wall < 30_000, `365 virtual days took ${Date.now() - wall} ms of real time`);
	});
});
