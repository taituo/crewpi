// Server + real Temporal + its in-process worker: a handoff that is not finished by its due time is escalated by the
// watchdog workflow through the activity, the state machine and the notify consumer - and the channel is told.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hasCli = spawnSync("temporal", ["--version"]).status === 0;
const TPORT = 17235, PORT = 18142, base = `http://127.0.0.1:${PORT}`;
const procs: ChildProcess[] = [];
after(() => procs.forEach((p) => p.kill()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("an overdue handoff is escalated by the watchdog and the channel is told", { skip: !hasCli, timeout: 240_000 }, async () => {
	procs.push(spawn("temporal", ["server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(TPORT), "--db-filename", join(mkdtempSync(join(tmpdir(), "tmp-")), "t.db"), "--log-level", "error"], { stdio: "ignore" }));
	await sleep(4000);
	procs.push(spawn(process.execPath, ["src/server.ts"], {
		env: { ...process.env, PORT: String(PORT), PUBLIC_URL: base, AUTH_MODE: "dev", DEMO_MODE: "true", DATA_DIR: mkdtempSync(join(tmpdir(), "crew-wd-")), TEMPORAL_ADDRESS: `127.0.0.1:${TPORT}`, HANDOFF_DUE_MS: "600", HANDOFF_ACK_MS: "20000" },
		stdio: "ignore",
	}));
	for (let i = 0; i < 100 && !(await fetch(`${base}/healthz`).then((r) => r.ok, () => false)); i++) await sleep(200);
	const login = await fetch(`${base}/auth/login?as=alice`, { redirect: "manual" });
	const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
	const h = { cookie, "content-type": "application/json", "x-requested-with": "crew" };
	const get = async (p: string) => (await fetch(`${base}${p}`, { headers: h })).json() as Promise<any>;

	await fetch(`${base}/api/channels/incidents/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "@ops tutki miksi checkout-api on kaatunut" }) });

	let escalated: any;
	for (let i = 0; i < 200 && !escalated; i++) {
		await sleep(500);
		const r = await get("/api/handoffs?channel=incidents");
		assert.equal(r.watchdog, "temporal", "the API says who watches the clock");
		escalated = r.handoffs.find((x: any) => x.status === "escalated");
	}
	assert.ok(escalated, "a handoff that outlived its 600 ms due time was escalated");
	assert.equal(escalated.reason, "overdue");

	let told = false;
	for (let i = 0; i < 60 && !told; i++) {
		told = (await get("/api/channels/incidents/messages")).messages.some((m: any) => m.authorId === "handoffs" && /did not handle/.test(m.text));
		if (!told) await sleep(300);
	}
	assert.ok(told, "the notify consumer posted into the channel");
	const types = (await get(`/api/domain-events?channel=incidents&correlation=${escalated.correlationId}`)).events.map((e: any) => e.type);
	assert.ok(types.includes("handoff.escalated") && types.includes("handoff.requested"));
});
