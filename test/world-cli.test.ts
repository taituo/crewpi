import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const data = mkdtempSync(join(tmpdir(), "crew-worldcli-"));
const crew = async (...args: string[]) => {
	try {
		const r = await run(process.execPath, ["src/cli.ts", ...args], { env: { ...process.env, DATA_DIR: data, SESSION_SECRET: "t", CREW_USER: "tester" } });
		return { code: 0, out: r.stdout, err: r.stderr };
	} catch (x: any) {
		return { code: x.code as number, out: x.stdout as string, err: x.stderr as string };
	}
};
const field = (out: string, key: string) => new RegExp(`^${key}:\\s+(.+)$`, "m").exec(out)?.[1]?.trim();

test("crew world: create, run in slices, inspect, resume - from the terminal", async () => {
	const made = await crew("world", "new", "alpha", "--seed", "s1");
	assert.equal(made.code, 0, made.err);
	assert.ok(existsSync(join(data, "worlds", "alpha.sqlite")), "one world is one file");

	const ran = await crew("world", "run", "alpha", "--days", "20", "--slice", "10");
	assert.equal(ran.code, 0, ran.err);
	assert.equal((ran.out.match(/slice \d+: day \d+ -> \d+/g) ?? []).length, 2, "two slices of 10 days, one line each");

	const st = await crew("world", "status", "alpha");
	assert.equal(field(st.out, "day"), "20");
	const hash20 = field(st.out, "hash")!;
	assert.match(hash20, /^[0-9a-f]{64}$/);

	// a second world with the same seed arrives at the same history
	await crew("world", "new", "beta", "--seed", "s1");
	await crew("world", "run", "beta", "--days", "20");
	assert.equal(field((await crew("world", "status", "beta")).out, "hash"), hash20, "same seed, same history, however it was sliced");

	// resume: more days later, in a new process
	const more = await crew("world", "run", "alpha", "--until", "30");
	assert.equal(more.code, 0, more.err);
	assert.equal(field((await crew("world", "status", "alpha")).out, "day"), "30");
	await crew("world", "run", "beta", "--until", "30");
	assert.equal(field((await crew("world", "status", "beta")).out, "hash"), field((await crew("world", "status", "alpha")).out, "hash"));

	// each slice left one summary in the main event log, flagged synthetic; the raw world events did not
	const ev = JSON.parse((await crew("events", "--json", "--limit", "200")).out) as any[];
	const slices = ev.filter((e) => e.type === "world.slice_finished");
	assert.ok(slices.length >= 5, `summaries reached the main log (${slices.length})`);
	assert.ok(slices.every((e) => e.scope === "synthetic" && (e.worldId === "alpha" || e.worldId === "beta")));
	assert.ok(ev.length < 20, "a month of world events (thousands) did not flood the main log");
});

test("crew world: clear errors", async () => {
	assert.match((await crew("world", "status", "nope")).err, /no world "nope"/);
	assert.match((await crew("world", "new", "../x")).err, /name/);
	assert.match((await crew("world", "new", "gamma", "--spec", "bogus")).err, /unknown spec "bogus".*ticker/);
	assert.equal((await crew("world", "new", "delta", "--seed", "a")).code, 0);
	assert.match((await crew("world", "new", "delta", "--seed", "b")).err, /already exists/);
	assert.match((await crew("world", "run", "delta")).err, /--days|--until/);
});

test("crew world: the IT-operations worlds can be created from the terminal and tell their story", async () => {
	assert.equal((await crew("world", "new", "ops1", "--spec", "itops:oracle", "--seed", "x")).code, 0);
	const ran = await crew("world", "run", "ops1", "--days", "30");
	assert.equal(ran.code, 0, ran.err);
	const st = (await crew("world", "status", "ops1")).out;
	assert.match(st, /^spec: itops:oracle$/m);
	assert.ok(Number(field(st, "events")) > 40, `a month of operations has events (${field(st, "events")})`);
	assert.match((await crew("world", "new", "ops2", "--spec", "nope")).err, /itops:naive/, "the error lists the available specs");
	// a different responder policy is a different world file but the same incidents arrive
	assert.equal((await crew("world", "new", "ops3", "--spec", "itops:naive", "--seed", "x")).code, 0);
	await crew("world", "run", "ops3", "--days", "30");
	const a = (await crew("world", "status", "ops1")).out, b = (await crew("world", "status", "ops3")).out;
	assert.notEqual(field(a, "hash"), field(b, "hash"), "different responders write different histories");
});
