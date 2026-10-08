import type { Op } from "./types.ts";

/**
 * Turns a sentence about the organization into proposed operations. A proposal changes nothing: the caller shows it,
 * a person confirms, and the operations go through Registry.applyOps with its normal authority checks. A language
 * model can replace `rulePlanner` (same signature); whatever it returns is only ever a list of operations to validate.
 */
export type Planner = (text: string) => { ops: Op[]; unparsed: string[] };

const NAME = String.raw`([^,.;]+?)`;
const KIND = String.raw`(team|tiimi|role|rooli|system|järjestelmä)`;
const kind = (k: string): "team" | "role" | "system" => (/^(team|tiimi)$/i.test(k) ? "team" : /^(role|rooli)$/i.test(k) ? "role" : "system");
const ref = (n: string) => `team:${n.trim()}`;

const RULES: [RegExp, (m: RegExpExecArray) => Op[]][] = [
	[new RegExp(String.raw`^(?:add|create|lisää|luo)\s+(?:a\s+|an\s+)?${KIND}\s+${NAME}$`, "i"), (m) => [{ op: "addNode", kind: kind(m[1]), name: m[2].trim() }]],
	[new RegExp(String.raw`^(?:remove|delete|poista)\s+${KIND}\s+${NAME}$`, "i"), (m) => [{ op: "removeNode", kind: kind(m[1]), name: m[2].trim() }]],
	[new RegExp(String.raw`^${NAME}\s+(?:reports to|raportoi)\s+${NAME}$`, "i"), (m) => [{ op: "addEdge", type: "reports_to", from: ref(m[1]), to: ref(m[2]) }]],
	[new RegExp(String.raw`^${NAME}\s+(?:depends on|riippuu)\s+${NAME}$`, "i"), (m) => [{ op: "addEdge", type: "depends_on", from: ref(m[1]), to: ref(m[2]) }]],
	[new RegExp(String.raw`^${NAME}\s+(?:must inform|täytyy informoida)\s+${NAME}$`, "i"), (m) => [{ op: "addEdge", type: "must_inform", from: ref(m[1]), to: ref(m[2]) }]],
	[new RegExp(String.raw`^${NAME}\s+(?:collaborates with|tekee yhteistyötä)\s+${NAME}$`, "i"), (m) => [{ op: "addEdge", type: "collaborates_with", from: ref(m[1]), to: ref(m[2]) }]],
];

/** Deliberately small: one clause per line or sentence. Anything it does not understand is returned, not guessed. */
export const rulePlanner: Planner = (text) => {
	const ops: Op[] = [], unparsed: string[] = [];
	for (const clause of text.split(/[\n.;]+/).map((c) => c.trim()).filter(Boolean)) {
		const hit = RULES.map(([re, f]) => ({ m: re.exec(clause), f })).find((x) => x.m);
		if (hit?.m) ops.push(...hit.f(hit.m));
		else unparsed.push(clause);
	}
	return { ops, unparsed };
};
