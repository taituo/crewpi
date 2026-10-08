import { test } from "node:test";
import assert from "node:assert/strict";
import { SeededRng } from "../src/world/rng.ts";

const first = (seed: string | number, n: number): number[] => {
	const r = new SeededRng(seed);
	const out: number[] = [];
	for (let i = 0; i < n; i++) out.push(r.next());
	return out;
};

test("determinism: same seed repeats, different seeds diverge, strings and numbers both seed", () => {
	assert.deepEqual(first("crew", 1000), first("crew", 1000));
	assert.notDeepEqual(first("crew", 10), first("crew-2", 10));
	assert.deepEqual(first(42, 1000), first(42, 1000));
	assert.deepEqual(first(42, 10), first("42", 10)); // one canonical text form per seed
	for (const v of first(42, 100)) assert.ok(v >= 0 && v < 1);
});

test("golden: first 5 values of seed 'crew' are pinned, so an algorithm change fails loudly", () => {
	assert.deepEqual(first("crew", 5), [
		0.15010571153834462,
		0.9108947603963315,
		0.648502737050876,
		0.004518592730164528,
		0.8804316229652613,
	]);
});

test("state round trip: restore continues the exact stream, and the state survives JSON", () => {
	const r = new SeededRng("snapshot");
	for (let i = 0; i < 500; i++) r.next();
	const s = r.state();
	assert.equal(typeof s, "string");
	const after: number[] = [];
	for (let i = 0; i < 500; i++) after.push(r.next());
	const revived = SeededRng.fromState(JSON.parse(JSON.stringify(s)));
	const again: number[] = [];
	for (let i = 0; i < 500; i++) again.push(revived.next());
	assert.deepEqual(again, after);
});

test("fromState rejects anything that is not a state string", () => {
	assert.throws(() => SeededRng.fromState("nope"), /state/);
	assert.throws(() => SeededRng.fromState("{\"v\":2}"), /state/);
});

const firstFrom = (r: SeededRng, n: number): number[] => {
	const out: number[] = [];
	for (let i = 0; i < n; i++) out.push(r.next());
	return out;
};

test("fork: children depend only on (original seed, label), parents are untouched", () => {
	const p = new SeededRng("parent");
	const c1 = p.fork("actor");
	const c2 = p.fork("actor");
	assert.deepEqual(firstFrom(c1, 100), firstFrom(c2, 100));
	assert.notDeepEqual(firstFrom(p.fork("actor"), 10), firstFrom(p.fork("other"), 10));

	// Forking consumes nothing from the parent.
	const q1 = new SeededRng("untouched");
	const q2 = new SeededRng("untouched");
	q1.fork("a");
	q1.fork("b");
	assert.deepEqual(firstFrom(q1, 10), firstFrom(q2, 10));

	// Fork timing does not matter: before or after 1000 parent draws, same child.
	const early = p.fork("late-child");
	for (let i = 0; i < 1000; i++) p.next();
	const late = p.fork("late-child");
	assert.deepEqual(firstFrom(early, 100), firstFrom(late, 100));

	// Same label on different parents gives different children.
	assert.notDeepEqual(
		firstFrom(new SeededRng("p1").fork("k"), 10),
		firstFrom(new SeededRng("p2").fork("k"), 10),
	);

	// A fork after a state restore matches a fork without one (the seed travels with the state).
	const w = new SeededRng("resumed");
	const before = w.fork("k");
	for (let i = 0; i < 50; i++) w.next();
	const afterRestore = SeededRng.fromState(w.state()).fork("k");
	assert.deepEqual(firstFrom(before, 50), firstFrom(afterRestore, 50));
});

test("ranges: next stays in [0,1), int stays in [min,max] and reaches both ends", () => {
	const r = new SeededRng("ranges");
	for (let i = 0; i < 100_000; i++) {
		const v = r.next();
		assert.ok(v >= 0 && v < 1, `next() left [0,1): ${v}`);
	}
	let lo = Infinity;
	let hi = -Infinity;
	for (let i = 0; i < 100_000; i++) {
		const v = r.int(1, 6);
		assert.ok(v >= 1 && v <= 6 && Number.isInteger(v));
		if (v < lo) lo = v;
		if (v > hi) hi = v;
	}
	assert.equal(lo, 1);
	assert.equal(hi, 6);
	for (let i = 0; i < 10_000; i++) assert.ok(r.int(-5, -1) >= -5 && r.int(3, 3) === 3);
});

test("chance: p=0 never fires, p=1 always fires", () => {
	const r = new SeededRng("chance");
	for (let i = 0; i < 1000; i++) assert.equal(r.chance(0), false);
	for (let i = 0; i < 1000; i++) assert.equal(r.chance(1), true);
});

test("distributions match their targets over 200k draws (tolerances are relative unless noted)", () => {
	const n = 200_000;

	// exp(2): mean within 3% of 0.5, i.e. +/- 0.015.
	let r = new SeededRng("exp");
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const v = r.exp(2);
		assert.ok(v >= 0);
		sum += v;
	}
	assert.ok(Math.abs(sum / n - 0.5) < 0.015, `exp mean ${sum / n}`);

	// poisson(4): mean and variance within 3% of 4, i.e. +/- 0.12.
	r = new SeededRng("poisson-small");
	sum = 0;
	let sum2 = 0;
	for (let i = 0; i < n; i++) {
		const v = r.poisson(4);
		assert.ok(Number.isInteger(v) && v >= 0);
		sum += v;
		sum2 += v * v;
	}
	const mean = sum / n;
	const variance = sum2 / n - mean * mean;
	assert.ok(Math.abs(mean - 4) < 0.12, `poisson(4) mean ${mean}`);
	assert.ok(Math.abs(variance - 4) < 0.12, `poisson(4) variance ${variance}`);

	// poisson(100): mean within 2% of 100, i.e. +/- 2, and never negative.
	r = new SeededRng("poisson-big");
	sum = 0;
	for (let i = 0; i < n; i++) {
		const v = r.poisson(100);
		assert.ok(Number.isInteger(v) && v >= 0);
		sum += v;
	}
	assert.ok(Math.abs(sum / n - 100) < 2, `poisson(100) mean ${sum / n}`);

	// normal(10,2): mean within 0.5% (+/- 0.05), sd within 2% (+/- 0.04).
	r = new SeededRng("normal");
	sum = 0;
	sum2 = 0;
	for (let i = 0; i < n; i++) {
		const v = r.normal(10, 2);
		sum += v;
		sum2 += v * v;
	}
	const nmean = sum / n;
	const nsd = Math.sqrt(sum2 / n - nmean * nmean);
	assert.ok(Math.abs(nmean - 10) < 0.05, `normal mean ${nmean}`);
	assert.ok(Math.abs(nsd - 2) < 0.04, `normal sd ${nsd}`);

	// int(1,6): each face within 2% (relative) of 1/6.
	r = new SeededRng("die");
	const faces = [0, 0, 0, 0, 0, 0];
	for (let i = 0; i < n; i++) faces[r.int(1, 6) - 1]++;
	for (const c of faces) assert.ok(Math.abs(c / n - 1 / 6) < 0.02 / 6, `die face count ${c}`);

	// weighted 1:2:7 within 2% (relative) of 0.1/0.2/0.7.
	r = new SeededRng("weighted");
	const items = [
		{ item: "a", weight: 1 },
		{ item: "b", weight: 2 },
		{ item: "c", weight: 7 },
	] as const;
	const counts = { a: 0, b: 0, c: 0 };
	for (let i = 0; i < n; i++) counts[r.weighted(items)]++;
	assert.ok(Math.abs(counts.a / n - 0.1) < 0.002, `weighted a ${counts.a}`);
	assert.ok(Math.abs(counts.b / n - 0.2) < 0.004, `weighted b ${counts.b}`);
	assert.ok(Math.abs(counts.c / n - 0.7) < 0.014, `weighted c ${counts.c}`);
});

test("errors: every documented throw fires", () => {
	const r = new SeededRng("errors");
	assert.throws(() => r.int(5, 4), /min/);
	assert.throws(() => r.int(1.5, 6), /integer/);
	assert.throws(() => r.int(1, 6.5), /integer/);
	assert.throws(() => r.int(NaN, 1), /integer/);
	assert.throws(() => r.chance(-0.1), /chance/);
	assert.throws(() => r.chance(1.1), /chance/);
	assert.throws(() => r.chance(NaN), /chance/);
	assert.throws(() => r.pick([]), /non-empty/);
	assert.throws(() => r.weighted([]), /weight/);
	assert.throws(() => r.weighted([{ item: 1, weight: 0 }]), /weight/);
	assert.throws(
		() => r.weighted([{ item: 1, weight: 1 }, { item: 2, weight: -1 }]),
		/weight/,
	);
	assert.throws(() => r.weighted([{ item: 1, weight: NaN }]), /weight/);
	assert.throws(() => r.exp(0), /rate/);
	assert.throws(() => r.exp(-2), /rate/);
	assert.throws(() => r.poisson(-1), /poisson/);
});

test("speed: 1M next() calls finish in under 500ms", () => {
	const r = new SeededRng("speed");
	const t0 = performance.now();
	for (let i = 0; i < 1_000_000; i++) r.next();
	const ms = performance.now() - t0;
	assert.ok(ms < 500, `1M next() took ${ms.toFixed(1)}ms`);
});
