// The live world inside the real server: WORLD_AUTORUN=demo makes the server run a team world and mirror it into #world-demo, which the
// existing UI shows. Real server, dev auth, temp DATA_DIR. Each negative has a positive control.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 18162;
const base = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
after(() => server?.kill());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function session(as: string) {
	const res = await fetch(`${base}/auth/login?as=${as}`, { redirect: "manual" });
	const cookie = (res.headers.getSetCookie()[0] ?? "").split(";")[0];
	assert.ok(cookie, `login as ${as}`);
	const raw = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { ...init, headers: { cookie, "content-type": "application/json", "x-requested-with": "crew", ...(init.headers ?? {}) } });
	return { raw, json: async (p: string) => (await raw(p)).json() as Promise<any> };
}

test("the world appears as a channel in the workspace, grows by itself, and cannot be talked into", { timeout: 120_000 }, async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "crew-live-"));
	server = spawn(process.execPath, ["src/server.ts"], {
		env: { ...process.env, PORT: String(PORT), PUBLIC_URL: base, AUTH_MODE: "dev", DEMO_MODE: "true", DATA_DIR: dataDir, WORLD_AUTORUN: "demo", WORLD_TICK_MS: "250", WORLD_TEAM: "ops=2,dev=1", WORLD_FAULTS: "heavy" },
		stdio: "ignore",
	});
	for (let i = 0; i < 100 && !(await fetch(`${base}/healthz`).then((r) => r.ok, () => false)); i++) await sleep(200);
	const bob = await session("bob"), carol = await session("carol");

	// it is a channel like the others
	let me = await bob.json("/api/me");
	assert.ok(me.channels.some((c: any) => c.id === "world-demo") || (await sleep(1500), (await bob.json("/api/me")).channels.some((c: any) => c.id === "world-demo")), "#world-demo is in the channel list");
	assert.ok(me.channels.some((c: any) => c.id === "general"), "positive control: the ordinary channels are still there");

	// it grows without anyone doing anything
	const count = async () => ((await bob.json("/api/channels/world-demo/messages")).messages ?? []).length;
	await sleep(2500); const a = await count();
	await sleep(3000); const b = await count();
	assert.ok(a > 5, `messages appear (${a})`);
	assert.ok(b > a, `and keep coming (${a} -> ${b})`);
	const msgs = (await bob.json("/api/channels/world-demo/messages")).messages;
	assert.ok(msgs.some((m: any) => m.authorKind === "agent" && /^(ops|dev)-\d$/.test(m.authorId)));

	// read-only: nobody can post into it, whatever their role; the control is an ordinary channel
	const post = (s: any, ch: string) => s.raw(`/api/channels/${ch}/messages`, { method: "POST", body: JSON.stringify({ text: "hello world" }) });
	const denied = await post(bob, "world-demo");
	assert.equal(denied.status, 403);
	assert.match((await denied.json()).error ?? "", /read-only|synthetic/i);
	assert.notEqual((await post(bob, "general")).status, 403, "control: bob can post in a normal channel");
	assert.equal((await carol.raw("/api/channels/world-demo/messages")).status, 200, "a viewer can watch");

	// the dashboard data for the same world, behind the same login
	assert.equal((await fetch(`${base}/api/worlds`)).status, 401, "not without logging in");
	const list = await bob.json("/api/worlds");
	assert.deepEqual(list.worlds.map((w: any) => w.name), ["demo"]);
	assert.ok(list.worlds[0].day >= 1);
	const view = await bob.json("/api/worlds/demo/view");
	assert.equal(view.services.length, 6);
	assert.ok(view.incidents.every((i: any) => i.cause === undefined), "no secrets for a normal look");
	assert.equal((await carol.raw("/api/worlds/demo/view?god=1")).status, 403, "the hidden causes are for operators");
	const god = await (await bob.raw("/api/worlds/demo/view?god=1")).json();
	assert.ok(god.incidents.length === 0 || god.incidents.every((i: any) => i.cause), "operators can see them");
	assert.ok((await bob.json("/api/worlds/demo/series")).days.length >= 2);
	assert.equal((await bob.raw("/api/worlds/demo/view?seq=abc")).status, 400);
	assert.equal((await bob.raw("/api/worlds/nope/view")).status, 404);
	assert.equal((await bob.raw("/api/worlds/..%2F..%2Fetc/view")).status, 404);
	assert.ok(existsSync(join(dataDir, "worlds", "demo.sqlite")));
});
