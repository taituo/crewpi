// A team of agents for a world: who they are, which brains they use, how the tools misbehave. Remembered next to the world file,
// so `crew world run` in a new process builds exactly the same team.
import { HOUR } from "./engine.ts";
import { withAgents, budgeted, recording, replaying, type AgentSpec, type Tape } from "./agents.ts";
import { modelBrain } from "./model-brain.ts";
import { opsBrain, rulesDev } from "./brains.ts";
import type { FaultPlan } from "./itops/tools.ts";
import type { WorldSpec } from "./types.ts";

/** brain: who thinks for the operators. The key of a model endpoint is never stored here; it comes from the environment at run time. */
export type TeamFile = { ops: number; dev: number; faults: string; brain?: "rules" | "model" | "replay"; model?: string; budget?: number; tape?: string };

export const FAULT_PRESETS: Record<string, FaultPlan> = {
	none: { rules: [] },
	light: { rules: [{ tool: "k8s_logs", kind: "wrong", p: 0.1 }, { tool: "k8s_logs", kind: "missing", p: 0.05 }] },
	heavy: { rules: [{ tool: "k8s_logs", kind: "wrong", p: 0.9 }, { tool: "k8s_logs", kind: "missing", p: 0.9 }] },
};
const MAX = 32;

/** "ops=3,dev=2" -> counts. Throws a message fit for a terminal. */
export function parseTeam(text: string, faults = "none"): TeamFile {
	if (!FAULT_PRESETS[faults]) throw new Error(`unknown fault preset "${faults}" (${Object.keys(FAULT_PRESETS).join(", ")})`);
	const t: TeamFile = { ops: 0, dev: 0, faults };
	for (const part of text.split(",")) {
		const [role, n] = part.split("=");
		if (role !== "ops" && role !== "dev") throw new Error(`unknown role "${role}" (ops, dev)`);
		if (!/^\d+$/.test(n ?? "")) throw new Error(`the number of ${role} must be a number, got "${n}"`);
		if (Number(n) > MAX) throw new Error(`at most ${MAX} agents per role`);
		t[role] = Number(n);
	}
	if (t.ops < 1) throw new Error("a team needs at least one ops agent");
	return t;
}

export const teamIds = (t: TeamFile) => [...Array.from({ length: t.ops }, (_, i) => `ops-${i + 1}`), ...Array.from({ length: t.dev }, (_, i) => `dev-${i + 1}`)];
export const teamSpec = <S>(base: WorldSpec<S>, t: TeamFile) => withAgents(base, teamIds(t), HOUR);
/** The agents of a team. Operators think with rules, a model (optionally on a daily budget, recorded on `tape`), or a replay of a tape; developers always use rules. */
export function teamAgents(t: TeamFile, ctx: { baseUrl?: string; apiKey?: string; tape?: Tape } = {}): AgentSpec[] {
	const devs = teamIds(t).filter((id) => id.startsWith("dev-")), rules = opsBrain({ devs });
	let ops = rules;
	if (t.brain === "model") {
		if (!ctx.baseUrl || !t.model || !ctx.tape) throw new Error("a model team needs an endpoint (LOCAL_LLM_BASE_URL), a model name and a tape");
		const m = modelBrain({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey ?? "", model: t.model, role: "ops" });
		ops = recording(t.budget !== undefined ? budgeted(m, rules, { unitsPerDay: t.budget }) : m, ctx.tape);
	} else if (t.brain === "replay") {
		if (!ctx.tape) throw new Error("a replay team needs a tape");
		ops = replaying(ctx.tape);
	}
	return teamIds(t).map((id) => ({ id, brain: id.startsWith("ops-") ? ops : rulesDev, everyMs: HOUR }));
}
