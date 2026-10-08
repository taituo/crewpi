// A small stand-in for SeededRng (being built separately on branch task/world-rng) so the engine tests do not wait for it.
// It implements the same factory contract the engine needs: create(seed), restore(state), and a stream with fork().
import type { Rng, RngFactory } from "../../src/world/types.ts";

function hash32(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
	return h >>> 0;
}
class Mulberry implements Rng {
	seed: string;
	a: number;
	constructor(seed: string, a?: number) { this.seed = seed; this.a = a ?? hash32(seed); }
	next() { this.a = (this.a + 0x6d2b79f5) >>> 0; let t = this.a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
	exp(rate: number) { return -Math.log(1 - this.next()) / rate; }
	poisson(mean: number) { let l = Math.exp(-mean), k = 0, p = 1; do { k++; p *= this.next(); } while (p > l); return k - 1; }
	int(min: number, max: number) { return min + Math.floor(this.next() * (max - min + 1)); }
	chance(p: number) { return this.next() < p; }
	state() { return JSON.stringify({ s: this.seed, a: this.a }); }
	fork(label: string) { return new Mulberry(`${this.seed}/${label}`); }
}
export const rngDouble: RngFactory = {
	create: (seed) => new Mulberry(String(seed)),
	restore: (state) => { const o = JSON.parse(state); return new Mulberry(o.s, o.a); },
};
