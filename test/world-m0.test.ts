// Milestone M0 of Crew World (docs/world/BACKLOG.md): a deterministic, resumable, time-skipping engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-world-"));
process.env.SESSION_SECRET = "test-secret";

const { World, DAY, HOUR, MIN } = await import("../src/world/engine.ts");
const { tickerSpec } = await import("../src/world/specs/ticker.ts");
const { rngDouble } = await import("./helpers/rng-double.ts");
const { announceSlice } = await import("../src/world/report.ts");
const { migrate } = await import("../src/migrate.ts");
const { MIGRATIONS } = await import("../src/migrations.ts");
const { EventBus } = await import("../src/work/events.ts");

const dir = mkdtempSync(join(tmpdir(), "crew-world-files-"));
let n = 0;
const file = () => join(dir, `w${++n}.sqlite`);
const open = (path: string, seed = "crew-1") => World.open(path, { spec: tickerSpec, seed, rng: rngDouble });

test("(a) determinism: the same seed gives the same world, event for event", () => {
	const a = open(file()), b = open(file());
	a.run({ days: 30 }); b.run({ days: 30 });
	assert.equal(a.hash(), b.hash(), "the history hash covers every event");
	assert.deepEqual(a.state(), b.state());
	assert.ok(a.status().events > 1000, `a month of the ticker world has real activity (${a.status().events} events)`);
	const c = open(file(), "another-seed"); c.run({ days: 30 });
	assert.notEqual(c.hash(), a.hash(), "a different seed gives a different history");
	a.close(); b.close(); c.close();
});

test("(b) snapshot and resume: stopping at day 10 and continuing equals one uninterrupted run", () => {
	const whole = open(file()); whole.run({ days: 30 });
	const path = file();
	const part = open(path); part.run({ days: 10 }); const at10 = part.hash(); part.close();
	const again = World.open(path, { spec: tickerSpec, seed: "crew-1", rng: rngDouble }); // a fresh process would do exactly this
	assert.equal(again.status().day, 10);
	assert.equal(again.hash(), at10, "reopening restores the same history");
	again.run({ days: 20 });
	assert.equal(again.hash(), whole.hash());
	assert.deepEqual(again.state(), whole.state());
	whole.close(); again.close();
});

test("(b2) a crash in the middle of a step loses nothing and changes nothing", () => {
	const whole = open(file()); whole.run({ days: 20 });
	const path = file();
	const w = open(path);
	let steps = 0;
	assert.throws(() => w.run({ days: 20, onStep: () => { if (++steps === 1777) throw new Error("power cut"); } }), /power cut/);
	w.close();
	const back = World.open(path, { spec: tickerSpec, seed: "crew-1", rng: rngDouble });
	assert.ok(back.status().events > 0, "committed work survived");
	back.run({ untilDay: 20 }); // absolute: "days" counts from the clock, which sits mid-day after a crash
	assert.equal(back.hash(), whole.hash(), "after the crash the world arrives at exactly the uninterrupted history");
	whole.close(); back.close();
});

test("(c) a year of virtual time costs seconds of real time", () => {
	const w = open(file());
	const t0 = Date.now();
	w.run({ days: 365 });
	const wall = Date.now() - t0;
	assert.equal(w.status().day, 365);
	assert.ok(wall < 60_000, `365 virtual days took ${wall} ms (${w.status().steps} steps, ${w.status().events} events)`);
	console.log(`# 365 virtual days: ${wall} ms wall, ${w.status().steps} steps, ${w.status().events} events`);
	w.close();
});

test("(d) events carry virtual time and a gap-free sequence per branch", () => {
	const path = file();
	const w = open(path); w.run({ days: 5 }); w.close();
	const db = new DatabaseSync(path);
	const rows = db.prepare("SELECT seq, vtime FROM world_events WHERE branch = 'main' ORDER BY seq").all() as { seq: number; vtime: number }[];
	assert.ok(rows.length > 100);
	rows.forEach((r, i) => { assert.equal(r.seq, i + 1, "no gaps"); if (i) assert.ok(r.vtime >= rows[i - 1].vtime, "virtual time never goes back"); });
	assert.ok(rows.at(-1)!.vtime <= 5 * DAY, "nothing happened after the end of the run");
	const snaps = db.prepare("SELECT COUNT(*) n FROM snapshots WHERE branch = 'main'").get() as { n: number };
	assert.ok(snaps.n >= 5, "a snapshot per virtual day");
	db.close();
});

test("(e) summary events reach the main event log as synthetic, not the raw stream", async () => {
	const db = new DatabaseSync(":memory:"); migrate(db, MIGRATIONS);
	const bus = new EventBus(db);
	const w = open(file()); const rep = w.run({ days: 3 });
	announceSlice(bus, w, rep);
	const evs = bus.list({});
	assert.equal(evs.length, 1, "one summary per slice, however many world events there were");
	assert.equal(evs[0].type, "world.slice_finished");
	assert.deepEqual([evs[0].scope, evs[0].worldId, evs[0].branchId], ["synthetic", w.status().name, "main"]);
	assert.equal(evs[0].payload.hash, w.hash());
	assert.equal(evs[0].payload.day, 3);
	w.close();
});

test("(f) time semantics: the clock jumps when nothing is runnable, and a timer fires at exactly its time", () => {
	const w = World.open(file(), { spec: tickerSpec, seed: "quiet", rng: rngDouble, quiet: true }); // no recurring actors
	w.scheduleAt({ actor: "probe", at: 5 * MIN, kind: "ping" });
	w.scheduleAt({ actor: "probe", at: 400 * DAY, kind: "ping" });
	const t0 = Date.now();
	const rep = w.run({ days: 365 });
	assert.ok(Date.now() - t0 < 1000, "a quiet year takes no real time");
	const fired = w.events().filter((e) => e.type === "probe.pinged");
	assert.deepEqual(fired.map((e) => e.vtime), [5 * MIN], "the +5 min timer fired at exactly +5 min; the day-400 timer did not fire in a 365-day run");
	assert.equal(w.status().day, 365, "the clock still arrives at the end of the slice");
	assert.equal(rep.steps, 1);
	const rep2 = w.run({ days: 40 });
	assert.deepEqual(w.events().filter((e) => e.type === "probe.pinged").map((e) => e.vtime), [5 * MIN, 400 * DAY], "continuing fires it at exactly day 400");
	assert.equal(rep2.steps, 1);
	w.close();
});

test("(g) budgets of a run: a step limit stops cleanly and the run can continue", () => {
	const w = open(file());
	const r1 = w.run({ untilDay: 30, maxSteps: 500 });
	assert.equal(r1.stopped, "max-steps");
	assert.ok(w.status().day < 30);
	const r2 = w.run({ untilDay: 30 });
	assert.equal(r2.stopped, "done");
	const whole = open(file()); whole.run({ untilDay: 30 });
	assert.equal(w.hash(), whole.hash(), "stopping on a budget and continuing changes nothing");
	w.close(); whole.close();
});

test("a world refuses to open with another seed or another spec", () => {
	const path = file();
	open(path, "seed-A").close();
	assert.throws(() => World.open(path, { spec: tickerSpec, seed: "seed-B", rng: rngDouble }), /seed/);
	assert.throws(() => World.open(path, { spec: { ...tickerSpec, name: "other" }, seed: "seed-A", rng: rngDouble }), /spec/);
	rmSync(path, { force: true });
});
