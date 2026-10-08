// Agents in the world. An agent's wake-ups are driven from outside the engine loop (see World.takeNext/applyStep):
// its brain may be slow and async (a language model, Tier 2) or a plain rule set (Tier 1), and either way it sees the world
// only through the synthetic tools. This file must never import the world's hidden state (a test checks the imports).
import type { World } from "./engine.ts";
import type { WorldSpec } from "./types.ts";
import { SyntheticTools, type FaultPlan, type ToolResult } from "./itops/tools.ts";

export type Session = {
	agent: string;
	/** Virtual time now. */
	now(): number;
	call(tool: string, args: Record<string, unknown>): Promise<ToolResult>;
};
export type Brain = {
	tier: 1 | 2;
	name: string;
	/** One working session: look around with the tools, act with the tools. */
	shift(s: Session): Promise<void>;
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

export type RunAgentsReport = { shifts: number; calls: number; errors: number };

/** Runs the world to `untilDay`, doing every agent shift outside the loop. Resumable: all state is in the world file. */
export async function runAgents(world: World<any>, o: { agents: AgentSpec[]; untilDay: number; faults?: FaultPlan; maxShifts?: number }): Promise<RunAgentsReport> {
	const byId = new Map(o.agents.map((a) => [a.id, a]));
	const tools = new SyntheticTools(world as any, o.faults);
	const rep: RunAgentsReport = { shifts: 0, calls: 0, errors: 0 };
	for (;;) {
		const r = world.run({ untilDay: o.untilDay, pauseOn: (w) => byId.has(w.actor) });
		if (r.stopped !== "paused") return rep;
		if (o.maxShifts !== undefined && rep.shifts >= o.maxShifts) return rep;
		const wake = world.takeNext();
		const agent = byId.get(wake.actor)!;
		let calls = 0, error = "";
		const session: Session = {
			agent: agent.id,
			now: () => world.now(),
			call: async (tool, args) => { calls++; return tools.call(tool, args, { agent: agent.id }); },
		};
		try { await agent.brain.shift(session); } catch (e) { error = (e as Error).message; rep.errors++; }
		world.applyStep(wake, {
			events: [{ type: "agent.shift", actor: agent.id, payload: { tier: agent.brain.tier, brain: agent.brain.name, calls, ...(error ? { error } : {}) } }],
			wakes: [{ actor: agent.id, in: agent.everyMs, kind: "shift" }],
		});
		rep.shifts++; rep.calls += calls;
	}
}
