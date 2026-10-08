/** Contracts of the Crew World engine (docs/world/README.md). Everything here is plain data so a world can be saved and replayed. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** The random source of a world: seeded, serializable, and able to give every actor its own independent stream. */
export interface Rng {
	next(): number;
	exp(ratePerUnit: number): number;
	poisson(mean: number): number;
	int(min: number, max: number): number;
	chance(p: number): boolean;
	pick<T>(items: readonly T[]): T;
	weighted<T>(items: readonly { item: T; weight: number }[]): T;
	state(): string;
	fork(label: string): Rng;
}
export interface RngFactory {
	create(seed: string): Rng;
	restore(state: string): Rng;
}

export type WorldEventInput = { type: string; actor: string; payload?: Record<string, Json> };
/** One fact about the world. `vtime` is virtual milliseconds since the world began; `seq` has no gaps per branch. */
export type WorldEvent = WorldEventInput & { branch: string; seq: number; vtime: number };

/** A scheduled wake-up of an actor. */
export type Wake = { actor: string; at: number; kind: string; data?: Record<string, Json> };
export type NewWake = { actor: string; kind: string; data?: Record<string, Json> } & ({ at: number } | { in: number });

export interface StepContext<S> {
	now: number;
	state: Readonly<S>;
	/** This actor's own stream: it advances only when this actor acts, so adding an actor never shifts another one's luck. */
	rng: Rng;
	wake: Wake;
}
export type StepResult = { events?: WorldEventInput[]; wakes?: NewWake[] };
export interface Actor<S> {
	id: string;
	step(ctx: StepContext<S>): StepResult;
}

/** What a world is: its first state, how events change state (pure!), who acts, and what is scheduled at the start. */
export interface WorldSpec<S> {
	name: string;
	initial(): S;
	reduce(state: S, e: WorldEvent): S;
	actors: Actor<S>[];
	start(rng: Rng): Wake[];
}

export type RunReport = { fromDay: number; toDay: number; steps: number; events: number; wallMs: number; stopped: "done" | "max-steps" | "max-wall" };
