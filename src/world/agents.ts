// Agents in the world. An agent's wake-ups are driven from outside the engine loop (see World.takeNext/applyStep):
// its brain may be slow and async (a language model, Tier 2) or a plain rule set (Tier 1), and either way it sees the world
// only through the synthetic tools. This file must never import the world's hidden state (a test checks the imports).
import { DAY, type World } from "./engine.ts";
import { readFileSync, writeFileSync } from "node:fs";
import type { WorldSpec } from "./types.ts";
import { SyntheticTools, type FaultPlan, type ToolResult } from "./itops/tools.ts";

export type Session = {
	agent: string;
	/** Virtual time now. */
	now(): number;
	call(tool: string, args: Record<string, unknown>): Promise<ToolResult>;
	/** Units this agent has spent on the current virtual day (rebuilt from the history, so a restart does not refill it). */
	spentToday(): number;
	/** Requests other agents have made of this agent and it has not answered yet. */
	inbox(): { id: string; from: string; task: string }[];
	/** Requests this agent has made that are still unanswered. */
	pending(): { id: string; to: string; task: string }[];
	/** Every request ever made in the company, answered or not, with the virtual time it was made. */
	requests(): { id: string; from: string; to: string; task: string; at: number; open: boolean }[];
	/** Every unanswered request in the company (everybody sees the open requests, like the messages of a shared channel). */
	openRequests(): { id: string; from: string; to: string; task: string }[];
	/** Answers a request from the inbox. It becomes history when the shift ends. */
	reply(id: string, result: string): void;
};
/** What a shift reports: the cost, and which brain really did the work (a budget may swap a Tier 2 brain for a Tier 1 one). */
export type ShiftResult = { units?: number; tier?: 1 | 2; brain?: string; degraded?: boolean } | void;
export type Brain = {
	tier: 1 | 2;
	name: string;
	/** One working session: look around with the tools, act with the tools. */
	shift(s: Session): Promise<ShiftResult>;
};
export type AgentSpec = { id: string; brain: Brain; everyMs: number };

/** Adds the agents' actors to a world spec. They cannot run inside the loop: running them there would silently fake their work. */
export function withAgents<S>(spec: WorldSpec<S>, ids: string[], firstEveryMs: number): WorldSpec<S> {
	const fail = (id: string) => () => { throw new Error(`agent "${id}" must be driven from outside the engine loop (runAgents)`); };
	return {
		...spec,
		name: `${spec.name}+agents`,
		actors: [...spec.actors, ...ids.map((id) => ({ id, step: fail(id) }))],
		// one millisecond apart per agent, so two agents never wake at the same instant
		start: (rng) => [...spec.start(rng), ...ids.map((id, i) => ({ actor: id, at: firstEveryMs + i, kind: "shift" }))],
	};
}

export type RunAgentsReport = { shifts: number; calls: number; errors: number; degraded: number };

/** Runs the world to `untilDay`, doing every agent shift outside the loop. Resumable: all state is in the world file. */
export async function runAgents(world: World<any>, o: { agents: AgentSpec[]; untilDay: number; faults?: FaultPlan; maxShifts?: number }): Promise<RunAgentsReport> {
	const byId = new Map(o.agents.map((a) => [a.id, a]));
	const tools = new SyntheticTools(world as any, o.faults);
	const rep: RunAgentsReport = { shifts: 0, calls: 0, errors: 0, degraded: 0 };
	// the handoffs in flight, kept up to date from the history (so a restart finds them again)
	const open = new Map<string, { id: string; from: string; to: string; task: string }>();
	const all = new Map<string, { id: string; from: string; to: string; task: string; at: number }>();
	let cursor = 0;
	const catchUp = () => {
		for (const e of world.eventsSince(cursor)) {
			cursor = e.seq;
			const p = e.payload as any;
			if (e.type === "handoff.requested") { open.set(p.id, { id: p.id, from: p.from, to: p.to, task: p.task }); all.set(p.id, { id: p.id, from: p.from, to: p.to, task: p.task, at: e.vtime }); }
			else if (e.type === "handoff.completed") open.delete(p.id);
		}
	};
	// units spent per agent on its latest day, from the history
	const spent = new Map<string, { day: number; units: number }>();
	for (const e of world.events()) {
		if (e.type !== "agent.shift") continue;
		const day = Math.floor(e.vtime / DAY), cur = spent.get(e.actor);
		spent.set(e.actor, { day, units: (cur && cur.day === day ? cur.units : 0) + Number((e.payload as any).units ?? 0) });
	}
	for (;;) {
		const r = world.run({ untilDay: o.untilDay, pauseOn: (w) => byId.has(w.actor) });
		if (r.stopped !== "paused") return rep;
		if (o.maxShifts !== undefined && rep.shifts >= o.maxShifts) return rep;
		const wake = world.takeNext();
		const agent = byId.get(wake.actor)!;
		let calls = 0, error = "";
		catchUp();
		const replies: { id: string; result: string }[] = [];
		const session: Session = {
			inbox: () => [...open.values()].filter((h) => h.to === agent.id && !replies.some((r) => r.id === h.id)).map((h) => ({ id: h.id, from: h.from, task: h.task })),
			pending: () => [...open.values()].filter((h) => h.from === agent.id).map((h) => ({ id: h.id, to: h.to, task: h.task })),
			openRequests: () => [...open.values()],
			requests: () => [...all.values()].map((h) => ({ ...h, open: open.has(h.id) })),
			reply: (id, result) => {
				const h = open.get(id);
				if (!h || h.to !== agent.id || replies.some((r) => r.id === id)) throw new Error(`reply: ${id} is not a request waiting in ${agent.id}'s inbox`);
				replies.push({ id, result });
			},
			agent: agent.id,
			now: () => world.now(),
			call: async (tool, args) => { calls++; return tools.call(tool, args, { agent: agent.id }); },
			spentToday: () => { const c = spent.get(agent.id); return c && c.day === Math.floor(world.now() / DAY) ? c.units : 0; },
		};
		let res: ShiftResult = undefined;
		try { res = await agent.brain.shift(session); } catch (e) { error = (e as Error).message; rep.errors++; res = (e as { shift?: ShiftResult }).shift; /* a replayed failure carries the recorded brain and cost */ }
		const out = res ?? {}, units = out.units ?? 0, day = Math.floor(world.now() / DAY);
		if (units) { const c = spent.get(agent.id); spent.set(agent.id, { day, units: (c && c.day === day ? c.units : 0) + units }); }
		if (out.degraded) rep.degraded++;
		world.applyStep(wake, {
			events: [...replies.map((r) => ({ type: "handoff.completed", actor: agent.id, payload: { id: r.id, result: r.result } })), { type: "agent.shift", actor: agent.id, payload: { tier: out.tier ?? agent.brain.tier, brain: out.brain ?? agent.brain.name, calls, units, ...(out.degraded ? { degraded: true } : {}), ...(error ? { error } : {}) } }],
			wakes: [{ actor: agent.id, in: agent.everyMs, kind: "shift" }],
		});
		rep.shifts++; rep.calls += calls;
	}
}

// ---- tape: record a brain's tool calls, replay them without the brain --------------------------------------------------

type Entry = { agent: string; at: number; calls: { tool: string; args: Record<string, unknown>; text: string; isError: boolean }[]; result: ShiftResult; error?: string };

/** What a (possibly expensive) brain did, shift by shift. Replaying it makes the same tool calls and needs no brain. */
export class Tape {
	private entries = new Map<string, Entry>();
	get size() { return this.entries.size; }
	put(e: Entry) { this.entries.set(`${e.agent}@${e.at}`, e); }
	get(agent: string, at: number) { return this.entries.get(`${agent}@${at}`); }
	save(path: string) { writeFileSync(path, [...this.entries.values()].map((e) => JSON.stringify(e)).join("\n") + "\n"); }
	static load(path: string) { const t = new Tape(); for (const l of readFileSync(path, "utf8").split("\n")) if (l.trim()) t.put(JSON.parse(l)); return t; }
}

export function recording(brain: Brain, tape: Tape): Brain {
	return {
		tier: brain.tier, name: brain.name,
		async shift(s) {
			const calls: Entry["calls"] = [];
			const spy: Session = { ...s, call: async (tool, args) => { const r = await s.call(tool, args); calls.push({ tool, args, text: r.text, isError: r.isError }); return r; } };
			let result: ShiftResult = undefined, error: string | undefined;
			try { result = await brain.shift(spy); } catch (e) { error = (e as Error).message; }
			// the replay must report the same brain as the recording did, or the histories would differ
			tape.put({ agent: s.agent, at: s.now(), calls, result: { tier: brain.tier, brain: brain.name, ...(result ?? {}) }, ...(error ? { error } : {}) });
			if (error) throw new Error(error);
			return result;
		},
	};
}

export function replaying(tape: Tape): Brain {
	return {
		tier: 2, name: "replay",
		async shift(s) {
			const e = tape.get(s.agent, s.now());
			if (!e) throw new Error(`replay diverged: the tape has no shift for ${s.agent} at ${s.now()}`);
			for (const c of e.calls) {
				const r = await s.call(c.tool, c.args);
				if (r.text !== c.text || r.isError !== c.isError) throw new Error(`replay diverged at ${c.tool}: the world answered differently than when it was recorded`);
			}
			if (e.error) throw Object.assign(new Error(e.error), { shift: e.result });
			return e.result;
		},
	};
}

// ---- budget --------------------------------------------------------------------------------------------------------------

/** Tier 2 until the day's units are spent, then the fallback (Tier 1) until midnight. The degradation is reported, never silent. */
export function budgeted(primary: Brain, fallback: Brain, b: { unitsPerDay: number }): Brain {
	return {
		tier: primary.tier, name: primary.name,
		async shift(s) {
			if (s.spentToday() >= b.unitsPerDay) {
				await fallback.shift(s);
				return { tier: fallback.tier, brain: fallback.name, degraded: true, units: 0 };
			}
			const r = await primary.shift(s);
			return { ...(r ?? {}), units: r?.units ?? 1 };
		},
	};
}
