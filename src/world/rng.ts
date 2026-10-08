// SeededRng: the only random-number source for the synthetic world.
// WHY a fixed algorithm (sfc32 + cyrb hash) instead of Math.random: a world run must be
// bit-for-bit reproducible and resumable (docs/world/README.md rules 4-5), so every stream
// is derived from an explicit seed and every stream can be snapshotted and restored.

import type { RngFactory } from "./types.ts";

export type RngState = string; // JSON-safe, opaque to callers

// 64-bit cyrb-style mixer over a string; seed picks an independent lane.
// WHY two lanes: sfc32 needs 128 bits of state, one cyrb pass yields 64.
function hash64(str: string, seed: number): [number, number] {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return [h1 >>> 0, h2 >>> 0];
}

export class SeededRng {
	private a: number;
	private b: number;
	private c: number;
	private d: number;
	private orig: string; // original seed text; fork() derives only from this, never from live state

	constructor(seed: string | number) {
		// WHY String(seed): one canonical text form, so seed 42 and seed "42" name the same stream.
		this.orig = String(seed);
		const [w0, w1] = hash64(this.orig, 0x9e3779b9);
		const [w2, w3] = hash64(this.orig, 0x85ebca6b);
		this.a = w0;
		this.b = w1;
		this.c = w2;
		this.d = w3;
	}

	// sfc32: 128-bit state, fast and good enough for Tier-0 arrival processes.
	next(): number {
		let a = this.a;
		let b = this.b;
		let c = this.c;
		let d = this.d;
		const t = ((a + b) | 0) + d | 0;
		d = (d + 1) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		c = (c + t) | 0;
		this.a = a;
		this.b = b;
		this.c = c;
		this.d = d;
		return (t >>> 0) / 4294967296;
	}

	int(min: number, max: number): number {
		if (!Number.isInteger(min) || !Number.isInteger(max)) throw new Error(`int bounds must be integers, got ${min}, ${max}`);
		if (min > max) throw new Error(`int min ${min} is above max ${max}`);
		return min + Math.floor(this.next() * (max - min + 1));
	}

	chance(p: number): boolean {
		if (!(p >= 0 && p <= 1)) throw new Error(`chance needs p in [0, 1], got ${p}`);
		return this.next() < p;
	}

	pick<T>(items: readonly T[]): T {
		if (items.length === 0) throw new Error("pick needs a non-empty array");
		return items[Math.floor(this.next() * items.length)];
	}

	weighted<T>(items: readonly { item: T; weight: number }[]): T {
		let total = 0;
		for (const e of items) {
			// WHY !(w >= 0): one check rejects negatives and NaN together.
			if (!(e.weight >= 0)) throw new Error(`weighted needs non-negative weights, got ${e.weight}`);
			total += e.weight;
		}
		// WHY !(total > 0): also catches empty input and a NaN total, both unusable.
		if (!(total > 0)) throw new Error("weighted needs a positive total weight");
		let r = this.next() * total;
		for (let i = 0; i < items.length - 1; i++) {
			r -= items[i].weight;
			if (r < 0) return items[i].item;
		}
		return items[items.length - 1].item; // last slot absorbs float rounding
	}

	exp(ratePerUnit: number): number {
		if (!(ratePerUnit > 0)) throw new Error(`exp needs a positive rate, got ${ratePerUnit}`);
		// WHY 1 - u: next() can return 0, and -ln(0) is Infinity; 1 - u stays in (0, 1].
		return -Math.log(1 - this.next()) / ratePerUnit;
	}

	poisson(mean: number): number {
		if (!(mean >= 0)) throw new Error(`poisson needs a non-negative mean, got ${mean}`);
		if (mean === 0) return 0;
		if (mean < 30) {
			// WHY Knuth here: exact for small means; its cost grows with the mean, hence the cutoff.
			const l = Math.exp(-mean);
			let k = 0;
			let p = 1;
			do {
				k++;
				p *= this.next();
			} while (p > l);
			return k - 1;
		}
		// WHY a normal approximation above the cutoff: Knuth would burn ~mean uniforms per draw.
		return Math.max(0, Math.round(mean + Math.sqrt(mean) * this.normal()));
	}

	normal(mean = 0, sd = 1): number {
		// WHY no cached spare: a spare would be hidden generator state that state() must carry;
		// burning one uniform per call keeps the snapshot to four words.
		const u1 = 1 - this.next(); // in (0, 1], so ln(u1) is finite
		const u2 = this.next();
		const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
		return mean + sd * z;
	}

	// Snapshot carries the original seed too, so fork() after a restore matches fork() without one.
	state(): RngState {
		return JSON.stringify({ v: 1, s: [this.a, this.b, this.c, this.d], seed: this.orig });
	}

	static fromState(s: RngState): SeededRng {
		let o: unknown;
		try {
			o = JSON.parse(s);
		} catch {
			throw new Error("fromState needs a state string from state()");
		}
		const r = o as { v?: unknown; s?: unknown; seed?: unknown };
		if (r === null || typeof r !== "object" || r.v !== 1 || !Array.isArray(r.s) || r.s.length !== 4 || typeof r.seed !== "string") {
			throw new Error("fromState needs a state string from state()");
		}
		const words = r.s as unknown[];
		for (const w of words) {
			// WHY the wide range: sfc32 words are signed 32-bit (| 0), so negatives are live state.
			if (!Number.isInteger(w) || (w as number) < -0x80000000 || (w as number) > 0xffffffff) {
				throw new Error("fromState needs a state string from state()");
			}
		}
		const rng = new SeededRng(r.seed);
		rng.a = words[0] as number;
		rng.b = words[1] as number;
		rng.c = words[2] as number;
		rng.d = words[3] as number;
		return rng;
	}

	// WHY derive from the original seed, not live state: actors are forked at spawn time but the
	// parent keeps running, so the child stream must not depend on when the fork happens.
	fork(label: string): SeededRng {
		// WHY stringify the pair: keeps ("a", "b:c") and ("a:b", "c") distinct.
		const pair = JSON.stringify([this.orig, label]);
		// WHY a fixed-size token and not the pair itself: nesting the pair in the next pair doubles the escaping at every
		// level (a fork of a fork of ... overflowed a JS string at about depth 25). 128 bits of hash keep the child's
		// seed, and so its saved state, the same size at any depth; a collision between labels is not a practical concern.
		const [w0, w1] = hash64(pair, 0x2545f491);
		const [w2, w3] = hash64(pair, 0x7f4a7c15);
		const hex = (n: number) => n.toString(16).padStart(8, "0");
		return new SeededRng(`fork:${hex(w0)}${hex(w1)}${hex(w2)}${hex(w3)}`);
	}
}

/** What the engine needs: make a stream from a seed, and bring one back from its saved state. */
export const seededRng: RngFactory = {
	create: (seed) => new SeededRng(seed),
	restore: (state) => SeededRng.fromState(state),
};
