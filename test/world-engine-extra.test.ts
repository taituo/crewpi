// Gap-closing tests for the Crew World engine (mutation-testing follow-up).
// Each test below kills one mutation that the M0/RNG/CLI suites let through:
// boundary wake-ups, crash reuse of the same object, vtime in the history
// hash, scheduleAt's past guard, FIFO order of same-time wakes, and the
// chance()/pick() boundaries of the seeded RNG.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { World, DAY, MIN } = await import("../src/world/engine.ts");
const { tickerSpec } = await import("../src/world/specs/ticker.ts");
const { SeededRng, seededRng } = await import("../src/world/rng.ts");

const dir = mkdtempSync(join(tmpdir(), "crew-world-extra-"));
let n = 0;
const file = () => join(dir, `x${++n}.sqlite`);
const quiet = (path: string, seed = "extra") =>
	World.open(path, { spec: tickerSpec, seed, rng: seededRng, quiet: true }); // no recurring actors

test("boundary: a wake-up due exactly at the end of a slice still fires", () => {
	const w = quiet(file());
	w.scheduleAt({ actor: "probe", at: DAY, kind: "ping" });
	w.scheduleAt({ actor: "probe", at: DAY + 1, kind: "ping" });
	w.run({ days: 1 }); // target is exactly DAY
	const fired = w.events().filter((e) => e.type === "probe.pinged").map((e) => e.vtime);
	assert.deepEqual(fired, [DAY], "due == target runs in this slice; due == target + 1 waits");
	assert.equal(w.status().day, 1, "the clock still arrives at the end of the slice");
	w.close();
});

test("crash reuse: after a failed batch the same object shows only committed work and can continue", () => {
	const whole = World.open(file(), { spec: tickerSpec, seed: "crew-1", rng: seededRng });
	whole.run({ days: 30 });
	const path = file();
	const w = World.open(path, { spec: tickerSpec, seed: "crew-1", rng: seededRng });
	let steps = 0;
	assert.throws(
		() => w.run({ days: 30, onStep: () => { if (++steps === 100) throw new Error("power cut"); } }),
		/power cut/,
	);
	// The failed batch was rolled back: the same object must read like a fresh reopen.
	const back = World.open(path, { spec: tickerSpec, seed: "crew-1", rng: seededRng });
	assert.deepEqual(w.status(), back.status(), "memory went back to what the file says");
	assert.deepEqual(w.state(), back.state());
	back.close();
	// And the same object can continue to exactly the uninterrupted history.
	w.run({ untilDay: 30 });
	assert.equal(w.hash(), whole.hash(), "continuing the crashed object changes nothing");
	assert.deepEqual(w.state(), whole.state());
	whole.close(); w.close();
});

test("hash covers virtual time: the same events at different times hash differently", () => {
	const a = quiet(file(), "t");
	a.scheduleAt({ actor: "probe", at: 5 * MIN, kind: "ping" });
	a.run({ days: 1 });
	const b = quiet(file(), "t");
	b.scheduleAt({ actor: "probe", at: 6 * MIN, kind: "ping" });
	b.run({ days: 1 });
	const ea = a.events(), eb = b.events();
	assert.equal(ea.length, 1); assert.equal(eb.length, 1);
	assert.equal(ea[0].type, eb[0].type);
	assert.deepEqual(ea[0].payload, eb[0].payload);
	assert.notEqual(ea[0].vtime, eb[0].vtime);
	assert.notEqual(a.hash(), b.hash(), "timing alone changes the history hash");
	a.close(); b.close();
});

test("scheduleAt rejects the past but allows exactly now", () => {
	const w = quiet(file());
	w.run({ days: 1 });
	assert.throws(() => w.scheduleAt({ actor: "probe", at: MIN, kind: "ping" }), /past/);
	assert.doesNotThrow(() => w.scheduleAt({ actor: "probe", at: w.status().vtime, kind: "ping" }), "at == clock is not the past");
	w.close();
});

test("same-time wakes run in insertion order", () => {
	const T = 10 * MIN;
	const a = quiet(file(), "s");
	a.scheduleAt({ actor: "arrivals", at: T, kind: "arrive" });
	a.scheduleAt({ actor: "server", at: T, kind: "serve" });
	a.run({ days: 1 });
	const b = quiet(file(), "s");
	b.scheduleAt({ actor: "server", at: T, kind: "serve" });
	b.scheduleAt({ actor: "arrivals", at: T, kind: "arrive" });
	b.run({ days: 1 });
	assert.equal(a.events()[0].type, "customer.arrived", "first inserted runs first");
	assert.equal(b.events()[0].type, "customer.served", "first inserted runs first, whichever it is");
	assert.notEqual(a.hash(), b.hash(), "tie order is part of the history");
	a.close(); b.close();
});

test("chance boundary: p=0 never fires, even on the smallest possible draw", () => {
	const r = new SeededRng("boundary");
	r.next = () => 0; // the minimum next() can return
	assert.equal(r.chance(0), false, "0 <= 0 would fire; only < keeps p=0 silent");
	assert.equal(r.chance(1), true);
	assert.equal(r.chance(0.5), true, "a 0 draw is below any positive p");
});

test("pick reaches every slot, including the last", () => {
	const r = new SeededRng("pick-last");
	r.next = () => 0.999999; // the largest draws must land on the last item
	assert.equal(r.pick(["a", "b", "c"]), "c");
	const s = new SeededRng("pick-all");
	const seen = new Set<string>();
	for (let i = 0; i < 10_000; i++) seen.add(s.pick(["a", "b", "c"]));
	assert.deepEqual([...seen].sort(), ["a", "b", "c"], "10k draws reach every slot");
});
