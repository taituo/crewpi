// A team world from the terminal, and the god eye on it: `crew world new --team ops=3,dev=2`, `run`, `watch`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const data = mkdtempSync(join(tmpdir(), "crew-teamcli-"));
const env = { ...process.env, DATA_DIR: data, SESSION_SECRET: "t", CREW_USER: "tester" };
const crew = async (...args: string[]) => {
	try { const r = await run(process.execPath, ["src/cli.ts", ...args], { env }); return { code: 0, out: r.stdout, err: r.stderr }; }
	catch (x: any) { return { code: x.code as number, out: x.stdout as string, err: x.stderr as string }; }
};
const field = (out: string, key: string) => new RegExp(`^${key}:\\s+(.+)$`, "m").exec(out)?.[1]?.trim();

test("a team world: created with a roster, run for days, resumed in a new process with the same history", async () => {
	const made = await crew("world", "new", "t1", "--spec", "itops:none", "--team", "ops=3,dev=2", "--faults", "light", "--seed", "tc");
	assert.equal(made.code, 0, made.err);
	assert.match(made.out, /ops-1.*ops-3.*dev-1.*dev-2|5 agents/);
	assert.ok(existsSync(join(data, "worlds", "t1.team.json")), "the roster is remembered next to the world");
	const a = await crew("world", "run", "t1", "--days", "6", "--slice", "3");
	assert.equal(a.code, 0, a.err);
	assert.match(a.out, /shifts/);
	const h6 = field((await crew("world", "status", "t1")).out, "hash")!;
	// the same team in a second world, run in one go, arrives at the same hash
	await crew("world", "new", "t2", "--spec", "itops:none", "--team", "ops=3,dev=2", "--faults", "light", "--seed", "tc");
	await crew("world", "run", "t2", "--days", "6");
	assert.equal(field((await crew("world", "status", "t2")).out, "hash"), h6);
	// and a stopped-and-resumed one
	await crew("world", "run", "t1", "--until", "8"); await crew("world", "run", "t2", "--until", "8");
	assert.equal(field((await crew("world", "status", "t1")).out, "hash"), field((await crew("world", "status", "t2")).out, "hash"));
});

test("bad team specs are refused with a clear message", async () => {
	for (const [team, msg] of [["ops=0", /at least one/i], ["boss=2", /unknown role/i], ["ops=x", /number/i], ["ops=3,dev=99", /at most/i]] as const) {
		const r = await crew("world", "new", "bad" + Math.random().toString(36).slice(2, 6), "--spec", "itops:none", "--team", team);
		assert.notEqual(r.code, 0, team);
		assert.match(r.err, msg, team);
	}
	assert.notEqual((await crew("world", "new", "bad2", "--spec", "ticker", "--team", "ops=1")).code, 0, "a team needs the IT-ops world");
	assert.notEqual((await crew("world", "new", "bad3", "--spec", "itops:none", "--team", "ops=1", "--faults", "chaos")).code, 0, "unknown fault preset");
});

test("crew world watch serves the god eye on a local port, read-only, for a world that exists", async () => {
	await crew("world", "new", "t3", "--spec", "itops:none", "--team", "ops=2,dev=1", "--seed", "w");
	await crew("world", "run", "t3", "--days", "3");
	const port = 18150 + Math.floor(Math.random() * 50);
	const child = spawn(process.execPath, ["src/cli.ts", "world", "watch", "t3", "--port", String(port)], { env });
	try {
		const url: string = await new Promise((res, rej) => {
			let buf = ""; const t = setTimeout(() => rej(new Error("no url printed: " + buf)), 15000);
			child.stdout.on("data", (c) => { buf += c; const m = /(http:\/\/127\.0\.0\.1:\d+)/.exec(buf); if (m) { clearTimeout(t); res(m[1]); } });
			child.on("exit", () => rej(new Error("watch exited: " + buf)));
		});
		const info: any = await (await fetch(url + "/api/info")).json();
		assert.equal(info.name, "t3");
		assert.equal(info.roster.length, 3);
		assert.equal((await fetch(url + "/")).status, 200);
		assert.equal((await fetch(url + "/api/info", { method: "DELETE" })).status, 405);
	} finally { child.kill(); }
	assert.notEqual((await crew("world", "watch", "nosuchworld")).code, 0);
});
