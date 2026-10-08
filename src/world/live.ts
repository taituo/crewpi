// A world that runs by itself inside the server: one virtual day per tick, then its conversation is mirrored into the workspace channel.
// The server process is the world's only writer (do not run `crew world run` on the same world at the same time).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAY, World } from "./engine.ts";
import { seededRng } from "./rng.ts";
import { SPECS } from "./specs/index.ts";
import { runAgents, Tape } from "./agents.ts";
import { FAULT_PRESETS, parseTeam, teamAgents, teamSpec, type TeamFile } from "./team.ts";
import { syncWorldChannel } from "./bridge.ts";

/** brain: leave out for rule-based operators; give a model to have a language model think for them (pager, budget, tape). */
export type LiveBrain = { kind: "model"; baseUrl: string; apiKey: string; model: string; budget?: number };

export function startLiveWorld(o: { dir: string; name: string; tickMs: number; team: string; faults: string; seed?: string; brain?: LiveBrain; log?: (m: string) => void }): { stop(): void } {
	const log = o.log ?? ((m) => console.log(`[world ${o.name}] ${m}`));
	const path = join(o.dir, `${o.name}.sqlite`), teamPath = join(o.dir, `${o.name}.team.json`);
	mkdirSync(o.dir, { recursive: true });
	if (!existsSync(teamPath)) writeFileSync(teamPath, JSON.stringify(parseTeam(o.team, o.faults)));
	const team: TeamFile = JSON.parse(readFileSync(teamPath, "utf8"));
	if (o.brain) { team.brain = "model"; team.model = o.brain.model; team.budget = o.brain.budget; }
	const tapePath = join(o.dir, `${o.name}.tape.jsonl`);
	const tape = existsSync(tapePath) ? Tape.load(tapePath) : new Tape();
	const base = SPECS["itops:none"];
	let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
	const tick = async () => {
		let next = o.tickMs;
		try {
			const w = World.open(path, { spec: teamSpec(base, team), seed: o.seed ?? o.name, rng: seededRng, name: o.name });
			try {
				const day = Math.floor(w.status().vtime / DAY);
				await runAgents(w, { agents: teamAgents(team, { baseUrl: o.brain?.baseUrl, apiKey: o.brain?.apiKey, tape }), untilDay: day + 1, faults: FAULT_PRESETS[team.faults] });
				if (o.brain) tape.save(tapePath);
			} finally { w.close(); }
			syncWorldChannel(path, o.name);
		} catch (e) {
			log(`tick failed: ${(e as Error).message}`);
			next = Math.max(o.tickMs, 5000); // back off, then try again
		}
		if (!stopped) timer = setTimeout(tick, next);
	};
	log(`running: ${team.ops} ops + ${team.dev} dev, tools ${team.faults}, operators ${o.brain ? `model ${o.brain.model}${o.brain.budget !== undefined ? ` (${o.brain.budget} units/day)` : ""}` : "rules"}, one virtual day every ${o.tickMs} ms`);
	timer = setTimeout(tick, 0);
	return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
