// M4a: the "god eye". A read-only observer over a world file: where the world is, what it looked like at any point of its history,
// what the agents said to each other, and the daily series for charts. It must never change the world and must work while the world runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Script } from "node:vm";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-obs-"));
process.env.SESSION_SECRET = "test-secret";

const { World, HOUR, DAY } = await import("../src/world/engine.ts");
const { seededRng } = await import("../src/world/rng.ts");
const { itopsSpec } = await import("../src/world/itops/spec.ts");
const { effective } = await import("../src/world/itops/state.ts");
const { withAgents, runAgents } = await import("../src/world/agents.ts");
const { opsBrain, rulesDev } = await import("../src/world/brains.ts");
const { Observer } = await import("../src/world/observe.ts");
const { startWatch } = await import("../src/world/watch-server.ts");

const dir = mkdtempSync(join(tmpdir(), "crew-obs-files-"));
const IDS = ["ops-1", "ops-2", "dev-1"];
const ops = opsBrain({ devs: ["dev-1"] });
const FAULTS = { rules: [{ tool: "k8s_logs", kind: "wrong" as const, p: 0.8 }, { tool: "k8s_logs", kind: "missing" as const, p: 0.8 }] };
let n = 0;
/** A world with a small team that has lived through `days` days of heavy weather. Returned still open. */
async function lived(days = 10, seed = "obs-1") {
	const path = join(dir, `w${++n}.sqlite`);
	const w = World.open(path, { spec: withAgents(itopsSpec("none"), IDS, HOUR), seed, rng: seededRng });
	await runAgents(w, { agents: [{ id: "ops-1", brain: ops, everyMs: HOUR }, { id: "ops-2", brain: ops, everyMs: HOUR }, { id: "dev-1", brain: rulesDev, everyMs: HOUR }], untilDay: days, faults: FAULTS });
	return { w, path };
}
const fileHash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

test("info agrees with the world itself", async () => {
	const { w, path } = await lived();
	const o = new Observer(path);
	const i = o.info();
	const st = w.status();
	assert.deepEqual([i.name, i.spec, i.seed, i.day, i.events, i.hash], [st.name, st.spec, st.seed, st.day, st.events, st.hash]);
	assert.equal(i.roster.length, 3, "the agents are known from their shifts");
	o.close(); w.close();
});

test("the state at any point in history equals the fold of the events up to it, and observing changes nothing", async () => {
	const { w, path } = await lived();
	w.close();
	const before = fileHash(path), mtime = statSync(path).mtimeMs;
	const o = new Observer(path);
	const events = o.events({ since: 0, limit: 1e6 });
	assert.ok(events.length > 500);
	const spec = itopsSpec("none");
	for (const k of [0, 1, 7, Math.floor(events.length / 3), Math.floor(events.length / 2), events.length - 1, events.length]) {
		let s = spec.initial();
		for (const e of events.slice(0, k)) s = spec.reduce(s, { branch: "main", ...e } as any);
		assert.deepEqual(o.stateAt(k), JSON.parse(JSON.stringify(s)), `state at event ${k}`);
	}
	o.view(100); o.chat({ since: 0, limit: 50 }); o.series();
	// not merely "it did not happen to write": the connection itself refuses to
	assert.throws(() => (o as any).db.exec("INSERT INTO meta (key, value) VALUES ('x', 'y')"), /readonly|read-only|attempt to write/i);
	assert.throws(() => (o as any).db.exec("DELETE FROM world_events"), /readonly|read-only|attempt to write/i);
	o.close();
	assert.equal(fileHash(path), before, "the file is byte for byte the same");
	assert.equal(statSync(path).mtimeMs, mtime);
});

test("an observer can look while the world is still open and running", async () => {
	const { w, path } = await lived(3);
	const o = new Observer(path);
	const a = o.info().events;
	await runAgents(w, { agents: [{ id: "ops-1", brain: ops, everyMs: HOUR }, { id: "ops-2", brain: ops, everyMs: HOUR }, { id: "dev-1", brain: rulesDev, everyMs: HOUR }], untilDay: 6, faults: FAULTS });
	assert.ok(o.info().events > a, "it sees what the world did after it was opened");
	o.close(); w.close();
});

test("the view shows each service's real condition; the cause is shown only to the god eye", async () => {
	const { w, path } = await lived(1);
	w.execute({ actor: "chaos", kind: "inject", data: { kind: "dependency_down", service: "checkout" } }); // right now, without running the agents' wake-ups
	const o = new Observer(path);
	const v: any = o.view();
	assert.deepEqual(v.services.map((s: any) => s.id), ["api", "checkout", "payments", "search", "db", "queue"]);
	const live = w.state() as any;
	for (const s of v.services) {
		const e = effective(live, s.id);
		assert.equal(s.replicas, e.replicas);
		assert.equal(s.status, !e.up ? "down" : Object.values(live.incidents).some((i: any) => i.status === "open" && (i.service === s.id || i.cause.rootService === s.id)) ? "degraded" : "ok", s.id);
	}
	assert.equal(v.services.find((s: any) => s.id === "db").status, "down");
	assert.equal(v.services.find((s: any) => s.id === "checkout").status, "degraded");
	const inc = v.incidents.find((i: any) => i.kind === "dependency_down");
	assert.ok(inc);
	assert.equal(inc.cause, undefined, "an observer without god mode is told symptoms, not the secret");
	const g: any = o.view(undefined, { god: true });
	assert.equal(g.incidents.find((i: any) => i.id === inc.id).cause.rootService, "db");
	o.close(); w.close();
});

test("the chat reads like a conversation: requests, answers, fixes and the people's escalations, in order, resumable by cursor", async () => {
	const { w, path } = await lived(14, "obs-chat");
	const o = new Observer(path);
	const all = o.chat({ since: 0, limit: 5000 });
	assert.ok(all.length > 20);
	assert.deepEqual(all.map((m: any) => m.seq), [...all.map((m: any) => m.seq)].sort((a, b) => a - b));
	const kinds = new Set(all.map((m: any) => m.kind));
	for (const k of ["request", "reply", "fix"]) assert.ok(kinds.has(k), `has ${k}`);
	const req = all.find((m: any) => m.kind === "request");
	assert.deepEqual([req.from, req.to].map((x: string) => /^(ops|dev)-\d$/.test(x)), [true, true]);
	assert.match(req.text, /OPS-\d+/);
	const rep = all.find((m: any) => m.kind === "reply" && m.to === req.from);
	assert.ok(rep && rep.from.startsWith("dev-"));
	const fix = all.find((m: any) => m.kind === "fix");
	assert.match(fix.text, /(restart|scale|roll|config|cert|failover|dismiss)/i);
	// the cursor continues where the last page ended, with no overlap and no gap
	const p1 = o.chat({ since: 0, limit: 7 }), p2 = o.chat({ since: p1[p1.length - 1].seq, limit: 7 });
	assert.deepEqual([...p1, ...p2].map((m: any) => m.seq), all.slice(0, 14).map((m: any) => m.seq));
	// agent shifts are not chat
	assert.ok(!all.some((m: any) => /shift/.test(m.kind)));
	o.close(); w.close();
});

test("the series has one point per day and agrees with the daily snapshots", async () => {
	const { w, path } = await lived(12, "obs-series");
	const o = new Observer(path);
	const s: any = o.series();
	assert.equal(s.days.length, 13);
	for (const k of ["opened", "resolved", "impact", "open", "handoffs", "shifts"]) assert.equal(s[k].length, s.days.length, k);
	for (let i = 1; i < s.days.length; i++) { assert.ok(s.opened[i] >= s.opened[i - 1]); assert.ok(s.resolved[i] >= s.resolved[i - 1]); assert.ok(s.impact[i] >= s.impact[i - 1] - 1e-6); }
	const st: any = w.state();
	assert.equal(s.opened[s.opened.length - 1], st.stats.opened);
	assert.equal(s.resolved[s.resolved.length - 1], st.stats.resolved);
	assert.equal(s.handoffs[s.handoffs.length - 1], Object.keys(st.handoffs).length);
	assert.ok(s.shifts[s.shifts.length - 1] >= 12 * 24 * 3 - 10);
	// the shift counter at each day is the number of shifts before that day began
	const shifts = o.events({ type: "agent.shift", limit: 1e6 });
	for (let i = 0; i < s.days.length - 1; i++) assert.equal(s.shifts[i], shifts.filter((e: any) => e.vtime < s.days[i] * DAY).length, `shifts before day ${s.days[i]}`);
	o.close(); w.close();
});

test("the web server: JSON routes, a page, read-only, and it fails politely", async () => {
	const { w, path } = await lived(40, "obs-web");
	const srv = await startWatch({ path, port: 0, host: "127.0.0.1" });
	try {
		const get = async (p: string, init?: RequestInit) => fetch(srv.url + p, init);
		const info: any = await (await get("/api/info")).json();
		assert.equal(info.hash, w.status().hash);
		const view: any = await (await get("/api/view")).json();
		assert.equal(view.services.length, 6);
		const god: any = await (await get("/api/view?god=1&seq=" + Math.floor(info.events / 2))).json();
		assert.ok(god.seq <= info.events / 2 + 1 && god.services.length === 6);
		const chat: any = await (await get("/api/chat?since=0&limit=5")).json();
		assert.ok(Array.isArray(chat.messages) && chat.messages.length <= 5);
		const ev: any = await (await get("/api/events?since=10&limit=3&type=agent.shift")).json();
		assert.ok(ev.events.length === 3 && ev.events.every((e: any) => e.type === "agent.shift" && e.seq > 10));
		assert.equal((await get("/api/series")).status, 200);
		assert.equal((await get("/api/nope")).status, 404);
		assert.equal((await get("/api/view?seq=abc")).status, 400);
		assert.equal((await get("/api/info", { method: "POST", body: "x" })).status, 405);
		const huge: any = await (await get("/api/events?limit=999999999")).json();
		assert.ok(info.events > 2000, "the world is big enough to tell clamping from not clamping");
		assert.equal(huge.events.length, 2000, "huge limits are clamped, not honoured");
		const page = await get("/");
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-type") ?? "", /text\/html/);
		const html = await page.text();
		assert.match(html, /<title>[^<]{3,}<\/title>/);
		const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
		assert.ok(scripts.length >= 1);
		for (const sc of scripts) assert.doesNotThrow(() => new Script(sc), "the page's script parses");
	} finally { await srv.close(); } // a failing assertion must not leave the server holding the process open
	await assert.rejects(startWatch({ path: join(dir, "missing.sqlite"), port: 0, host: "127.0.0.1" }), /no such world|cannot open/i);
	w.close();
});
