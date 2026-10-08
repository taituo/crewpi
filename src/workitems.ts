import { decide, DEFAULT_POLICY, type AutonomyPolicy, type Decision, type WorkItem } from "./policy.ts";

/** Small seeded PRNG (mulberry32) so a run is reproducible. */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Synthetic work: mostly routine, a few that must reach a person. */
export function generateWork(n: number, seed = 1): WorkItem[] {
	const r = rng(seed);
	const items: WorkItem[] = [];
	for (let i = 0; i < n; i++) {
		const p = r();
		const kind = p < 0.55 ? "customer_message" : p < 0.9 ? "invoice_check" : p < 0.98 ? "config_change" : "legal_commitment";
		items.push({
			id: `w-${seed}-${i}`,
			kind,
			risk: kind === "config_change" ? "high" : kind === "legal_commitment" ? "high" : r() < 0.9 ? "low" : "medium",
			costUsd: 0.005 + r() * 0.03,
			confidence: 1 - r() ** 3 * 0.4, // skewed high; an assumption, not a measurement
			writes: kind === "config_change",
			untrustedSource: kind === "customer_message" && r() < 0.2,
		});
	}
	return items;
}

export type RunReport = {
	total: number;
	allow: number;
	deny: number;
	escalate: number;
	humanTouchesPer100: number;
	spentUsd: number;
	reasons: Record<string, number>;
	decisions: { id: string; decision: Decision }[];
};

/** Routes every item through the policy and reports what a person would have to look at. */
export function routeAll(items: WorkItem[], policy: AutonomyPolicy = DEFAULT_POLICY): RunReport {
	const rep: RunReport = { total: items.length, allow: 0, deny: 0, escalate: 0, humanTouchesPer100: 0, spentUsd: 0, reasons: {}, decisions: [] };
	for (const item of items) {
		const d = decide(policy, item, rep.spentUsd);
		rep[d.verdict]++;
		if (d.verdict === "allow") rep.spentUsd += item.costUsd;
		if (d.verdict !== "allow") rep.reasons[d.reason] = (rep.reasons[d.reason] ?? 0) + 1;
		rep.decisions.push({ id: item.id, decision: d });
	}
	rep.humanTouchesPer100 = items.length ? Math.round((rep.escalate / items.length) * 1000) / 10 : 0;
	return rep;
}
