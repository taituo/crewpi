// M3a: some actors must be driven from outside the engine loop (a language model call is async and slow).
// The engine pauses before their wake-up; the driver does the work and hands the result back. The history must be
// exactly the one an internal actor would have written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-ext-"));
process.env.SESSION_SECRET = "test-secret";

const { World, DAY, HOUR, MIN } = await import("../src/world/engine.ts");
const { seededRng } = await import("../src/world/rng.ts");
const { tickerSpec } = await import("../src/world/specs/ticker.ts");

const dir = mkdtempSync(join(tmpdir(), "crew-ext-files-"));
let n = 0;
const open = (seed = "ext-1", quiet = false) => World.open(join(dir, `w${++n}.sqlite`), { spec: tickerSpec, seed, rng: seededRng, quiet });
const actor = (id: string) => tickerSpec.actors.find((a) => a.id === id)!;

/** Runs the world to `untilDay`, handling the wake-ups of `external` actors outside the loop, asynchronously. */
async function drive(w: InstanceType<typeof World>, untilDay: number, external: string[], onTake?: (w: any) => void) {
	let handled = 0;
	for (;;) {
		const rep = w.run({ untilDay, pauseOn: (wake) => external.includes(wake.actor) });
		if (rep.stopped !== "paused") return { ...rep, handled };
		handled++;
		const wake = w.takeNext();
		onTake?.(wake);
		await new Promise((r) => setTimeout(r, 0)); // the real work would be a network call here
		w.applyStep(wake, actor(wake.actor).step(w.contextFor(wake)));
	}
}

test("pausing leaves the wake-up in place and the history untouched", () => {
	const w = open();
	const rep = w.run({ days: 3, pauseOn: (x) => x.actor === "daily" });
	assert.equal(rep.stopped, "paused");
	const pending = w.pending()!;
	assert.deepEqual([pending.actor, pending.kind, pending.at], ["daily", "close", DAY]);
	const hash = w.hash();
	assert.equal(w.run({ days: 3, pauseOn: (x) => x.actor === "daily" }).steps, 0, "still paused, nothing runs");
	assert.equal(w.hash(), hash);
	assert.ok(w.now() < DAY, `the clock stopped before the wake-up (${w.now()})`);
	const taken = w.takeNext();
	assert.equal(taken.actor, "daily");
	assert.equal(w.now(), DAY, "taking it moves the clock to its time");
	assert.notEqual(w.pending()?.at, DAY, "it is gone from the schedule");
	w.close();
});

test("an actor driven from outside writes the same history as the same actor inside the loop", async () => {
	for (const [external, atLeast] of [[["daily"], 12], [["server"], 300], [["arrivals"], 300], [["daily", "server", "arrivals"], 1000]] as const) {
		const inside = open("same-seed"), outside = open("same-seed");
		inside.run({ untilDay: 12 });
		const rep = await drive(outside, 12, [...external]);
		assert.ok(rep.handled >= atLeast, `${external}: the work really was done outside the loop (${rep.handled} external steps)`);
		assert.equal(outside.hash(), inside.hash(), `external ${external}: same hash`);
		assert.deepEqual(outside.state(), inside.state());
		assert.equal(outside.status().events, inside.status().events);
		inside.close(); outside.close();
	}
});

test("stopping and reopening between external steps loses nothing", async () => {
	const whole = open("resume-ext"); const full = await drive(whole, 10, ["daily", "arrivals"]);
	assert.ok(full.handled > 300);
	const path = join(dir, "resume.sqlite");
	const a = World.open(path, { spec: tickerSpec, seed: "resume-ext", rng: seededRng });
	let taken = 0;
	for (;;) {
		const rep = a.run({ untilDay: 10, pauseOn: (x) => ["daily", "arrivals"].includes(x.actor) });
		if (rep.stopped !== "paused") break;
		const wake = a.takeNext();
		a.applyStep(wake, actor(wake.actor).step(a.contextFor(wake)));
		if (++taken === 150) break; // "the process dies here"
	}
	assert.equal(taken, 150, "it really stopped in the middle");
	a.close();
	const b = World.open(path, { spec: tickerSpec, seed: "resume-ext", rng: seededRng });
	await drive(b, 10, ["daily", "arrivals"]);
	assert.equal(b.hash(), whole.hash());
	whole.close(); b.close();
});

test("time cannot jump over a scheduled wake-up, and the clock lands exactly where asked", () => {
	const w = open("jump", true);
	w.scheduleAt({ actor: "probe", at: 5 * MIN, kind: "ping" });
	assert.throws(() => w.advanceTo(10 * MIN), /scheduled wake-up/, "a wake-up at +5 min is in the way");
	w.advanceTo(3 * MIN);
	assert.equal(w.now(), 3 * MIN);
	assert.throws(() => w.advanceTo(2 * MIN), /backwards|past/);
	w.advanceTo(5 * MIN - 1);
	w.run({ untilMs: 5 * MIN });
	assert.equal(w.events().filter((e) => e.type === "probe.pinged")[0].vtime, 5 * MIN);
	w.advanceTo(2 * DAY + HOUR);
	assert.equal(w.status().day, 2);
	assert.ok(w.status().snapshots >= 2, "jumping over days still writes the daily snapshots");
	w.close();
});

test("applyStep validates what an outside driver hands back", () => {
	const w = open("validate", true);
	w.scheduleAt({ actor: "probe", at: MIN, kind: "ping" });
	const rep = w.run({ days: 1, pauseOn: () => true });
	assert.equal(rep.stopped, "paused");
	const wake = w.takeNext();
	assert.throws(() => w.applyStep(wake, { wakes: [{ actor: "probe", at: 0, kind: "x" }] }), /past/);
	assert.throws(() => w.applyStep({ ...wake, actor: "nobody" }, {}), /unknown actor/);
	w.applyStep(wake, { events: [{ type: "probe.pinged", actor: "probe" }] });
	assert.equal(w.events().length, 1);
	w.close();
});

test("an external actor's random stream continues from step to step and survives a restart", async () => {
	const w = open("stream", true);
	const wake = { actor: "arrivals", at: 0, kind: "arrive" };
	const a = w.contextFor(wake).rng.next(), b = w.contextFor(wake).rng.next();
	assert.notEqual(a, b, "the second call continues the stream, it does not start a new one");
	// the same two draws, taken in a world that is closed and reopened in between, are the same two numbers
	const path = join(dir, "stream.sqlite");
	const x = World.open(path, { spec: tickerSpec, seed: "stream", rng: seededRng, quiet: true });
	const first = x.contextFor(wake).rng.next();
	x.scheduleAt({ actor: "probe", at: 1, kind: "ping" }); x.applyStep(wake, {}); // a step by this actor: its stream state is saved
	x.close();
	const y = World.open(path, { spec: tickerSpec, seed: "stream", rng: seededRng, quiet: true });
	const second = y.contextFor(wake).rng.next();
	assert.equal(first, a); assert.equal(second, b, "after the restart the stream carries on where it was");
	w.close(); y.close();
});
