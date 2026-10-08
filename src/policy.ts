/**
 * Autonomy policy: decides, deterministically and without a model, whether a work item may be handled by an agent
 * alone (allow), must be refused (deny) or goes to a person (escalate). The model may propose; this decides.
 */

export type Risk = "low" | "medium" | "high";
export type WorkItem = {
	id: string;
	kind: string; // e.g. "customer_message", "invoice_check", "config_change"
	risk: Risk;
	/** Estimated cost of handling it, in USD. */
	costUsd: number;
	/** Agent's own confidence 0..1. Only ever used to escalate, never to allow. */
	confidence: number;
	/** Does handling it change a live system? */
	writes: boolean;
	/** Origin is untrusted text (email, log, upload). It cannot widen what is allowed. */
	untrustedSource?: boolean;
};

export type Rule = {
	kind: string; // "*" matches any
	maxRisk: Risk;
	/** Allow writes without a person for this kind. Off by default. */
	allowWrites?: boolean;
	maxCostUsd: number;
	minConfidence: number;
};

export type AutonomyPolicy = {
	version: string;
	rules: Rule[];
	/** Kinds that are never automated. */
	denyKinds: string[];
	/** Total spend allowed per run; beyond it everything escalates. */
	budgetUsd: number;
};

export type Decision = { verdict: "allow" | "deny" | "escalate"; reason: string; policyVersion: string };

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export function decide(policy: AutonomyPolicy, item: WorkItem, spentUsd = 0): Decision {
	const out = (verdict: Decision["verdict"], reason: string): Decision => ({ verdict, reason, policyVersion: policy.version });

	if (policy.denyKinds.includes(item.kind)) return out("deny", `kind ${item.kind} is never automated`);
	if (spentUsd + item.costUsd > policy.budgetUsd) return out("escalate", "budget exhausted");

	const rule = policy.rules.find((r) => r.kind === item.kind) ?? policy.rules.find((r) => r.kind === "*");
	if (!rule) return out("escalate", `no rule for ${item.kind}`);
	if (RANK[item.risk] > RANK[rule.maxRisk]) return out("escalate", `risk ${item.risk} above ${rule.maxRisk}`);
	if (item.writes && !rule.allowWrites) return out("escalate", "write needs a person");
	if (item.costUsd > rule.maxCostUsd) return out("escalate", "item cost above limit");
	if (item.confidence < rule.minConfidence) return out("escalate", "confidence below rule minimum");
	// Untrusted input may be handled, but never together with a write.
	if (item.untrustedSource && item.writes) return out("escalate", "untrusted source with write");
	return out("allow", "within policy");
}

export const DEFAULT_POLICY: AutonomyPolicy = {
	version: "p1",
	denyKinds: ["legal_commitment"],
	budgetUsd: 50,
	rules: [
		{ kind: "customer_message", maxRisk: "low", maxCostUsd: 0.05, minConfidence: 0.7 },
		{ kind: "invoice_check", maxRisk: "medium", maxCostUsd: 0.1, minConfidence: 0.8 },
		{ kind: "*", maxRisk: "low", maxCostUsd: 0.05, minConfidence: 0.9 },
	],
};
