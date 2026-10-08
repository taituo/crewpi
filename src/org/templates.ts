import type { Registry } from "./registry.ts";
import type { Actor, Op } from "./types.ts";

/**
 * Three very different organizations built through the same registry operations. They exist to prove that the
 * model is not tied to a hierarchy (Prompt 04 acceptance) and double as examples for the builder.
 */
type Built = { organizationId: string; versionId: string; participants: Record<string, string> };

const admin = (actor: Actor): Actor => ({ ...actor, platformRoles: [...new Set([...actor.platformRoles, "admin"])] });

function finish(reg: Registry, actor: Actor, name: string, people: { ref: string; kind: "human" | "internal_agent"; name: string }[], ops: (p: Record<string, string>) => Op[]): Built {
	const a = admin(actor);
	const { organizationId, versionId } = reg.createOrg(a, { name });
	const participants: Record<string, string> = {};
	for (const p of people) participants[p.ref] = reg.ensureParticipant(actor.tenantId, p.kind, `${organizationId}:${p.ref}`, p.name);
	reg.applyOps(a, organizationId, versionId, ops(participants));
	reg.adopt(a, organizationId, versionId);
	return { organizationId, versionId, participants };
}

const std = (): Op[] => [
	{ op: "addNode", kind: "capability", name: "org.admin" },
	{ op: "addNode", kind: "capability", name: "org.edit" },
];

/** A classic company: CEO -> VPs -> teams, approvals go up the line. */
export function hierarchicalCompany(reg: Registry, actor: Actor): Built {
	return finish(reg, actor, "Hierarchical Co", [
		{ ref: "ceo", kind: "human", name: "Casey CEO" }, { ref: "vpEng", kind: "human", name: "Eve VP Eng" }, { ref: "vpOps", kind: "human", name: "Omar VP Ops" },
		{ ref: "dev", kind: "internal_agent", name: "Dev agent" }, { ref: "ops", kind: "internal_agent", name: "Ops agent" }, { ref: "dev2", kind: "internal_agent", name: "Dev agent 2" }, { ref: "ops2", kind: "internal_agent", name: "Ops agent 2" },
	], (p) => [
		...std(),
		...(["Executive", "Engineering", "Operations", "Dev team", "Ops team"] as const).map((n) => ({ op: "addNode", kind: "team", name: n }) as Op),
		{ op: "addNode", kind: "capability", name: "release.approve" }, { op: "addNode", kind: "system", name: "production" },
		{ op: "addEdge", type: "reports_to", from: "team:Engineering", to: "team:Executive" }, { op: "addEdge", type: "reports_to", from: "team:Operations", to: "team:Executive" },
		{ op: "addEdge", type: "belongs_to", from: "team:Dev team", to: "team:Engineering" }, { op: "addEdge", type: "belongs_to", from: "team:Ops team", to: "team:Operations" },
		{ op: "addEdge", type: "responsible_for", from: "team:Dev team", to: "capability:release.approve" },
		{ op: "addEdge", type: "responsible_for", from: "team:Ops team", to: "system:production" },
		{ op: "addEdge", type: "can_approve", from: "team:Engineering", to: "team:Dev team" }, { op: "addEdge", type: "can_approve", from: "team:Operations", to: "team:Ops team" },
		{ op: "addEdge", type: "has_access_to", from: "team:Executive", to: "capability:org.admin" },
		{ op: "addEdge", type: "has_access_to", from: "team:Engineering", to: "capability:org.edit" },
		{ op: "addEdge", type: "has_access_to", from: "team:Executive", to: "capability:release.approve" },
		{ op: "addEdge", type: "has_access_to", from: "team:Engineering", to: "capability:release.approve" },
		{ op: "addEdge", type: "has_access_to", from: "team:Ops team", to: "system:production" },
		{ op: "addMember", participant: p.ceo, node: "team:Executive" }, { op: "addMember", participant: p.vpEng, node: "team:Engineering" }, { op: "addMember", participant: p.vpOps, node: "team:Operations" },
		{ op: "addMember", participant: p.dev, node: "team:Dev team" }, { op: "addMember", participant: p.dev2, node: "team:Dev team" },
		{ op: "addMember", participant: p.ops, node: "team:Ops team" }, { op: "addMember", participant: p.ops2, node: "team:Ops team" },
		{ op: "setAgent", participant: p.dev, model: "openai/gpt-5.6-terra", instructions: "You are a developer.", tools: ["repo", "repo-write"] },
		{ op: "setAgent", participant: p.ops, model: "openai/gpt-5.6-terra", instructions: "You are SRE.", tools: ["k8s"] },
		{ op: "setPolicy", kind: "authority", name: "release", body: { requires: "release.approve", separation_of_duties: true } },
	]);
}

/** Autonomous squads: no boss, peers collaborate and substitute for each other. */
export function teamNetwork(reg: Registry, actor: Actor): Built {
	return finish(reg, actor, "Squad Network", [
		{ ref: "ana", kind: "human", name: "Ana" }, { ref: "bo", kind: "human", name: "Bo" }, { ref: "cy", kind: "human", name: "Cy" }, { ref: "di", kind: "human", name: "Di" },
	], (p) => [
		...std(),
		...(["Payments", "Search", "Platform", "Guild"] as const).map((n) => ({ op: "addNode", kind: "team", name: n }) as Op),
		{ op: "addNode", kind: "capability", name: "payments.release" },
		{ op: "addEdge", type: "collaborates_with", from: "team:Payments", to: "team:Search" }, { op: "addEdge", type: "collaborates_with", from: "team:Search", to: "team:Platform" },
		{ op: "addEdge", type: "depends_on", from: "team:Payments", to: "team:Platform" },
		{ op: "addEdge", type: "must_inform", from: "team:Payments", to: "team:Search" },
		{ op: "addEdge", type: "responsible_for", from: "team:Payments", to: "capability:payments.release" },
		{ op: "addEdge", type: "substitutes_for", from: "team:Search", to: "team:Payments" },
		{ op: "addEdge", type: "can_approve", from: "team:Guild", to: "team:Payments" }, { op: "addEdge", type: "can_approve", from: "team:Guild", to: "team:Search" },
		{ op: "addEdge", type: "has_access_to", from: "team:Guild", to: "capability:org.admin" }, { op: "addEdge", type: "has_access_to", from: "team:Payments", to: "capability:org.edit" },
		{ op: "addEdge", type: "has_access_to", from: "team:Payments", to: "capability:payments.release" },
		{ op: "addMember", participant: p.ana, node: "team:Payments" }, { op: "addMember", participant: p.bo, node: "team:Search" },
		{ op: "addMember", participant: p.cy, node: "team:Platform" }, { op: "addMember", participant: p.di, node: "team:Guild" }, { op: "addMember", participant: p.ana, node: "team:Guild" },
	]);
}

/** Only agents: roles and rights exist, a single service participant owns the administration. */
export function agentOnlyCompany(reg: Registry, actor: Actor): Built {
	return finish(reg, actor, "Agents Inc", [
		{ ref: "root", kind: "internal_agent", name: "Steward" }, { ref: "sales", kind: "internal_agent", name: "Sales agent" }, { ref: "fin", kind: "internal_agent", name: "Finance agent" },
		{ ref: "fin2", kind: "internal_agent", name: "Finance agent 2" }, { ref: "sales2", kind: "internal_agent", name: "Sales agent 2" },
	], (p) => [
		...std(),
		...(["Steward", "Sales", "Finance"] as const).map((n) => ({ op: "addNode", kind: "role", name: n }) as Op),
		{ op: "addNode", kind: "capability", name: "invoice.approve" },
		{ op: "addEdge", type: "responsible_for", from: "role:Sales", to: "capability:invoice.approve" }, { op: "addEdge", type: "must_inform", from: "role:Sales", to: "role:Finance" },
		{ op: "addEdge", type: "can_approve", from: "role:Finance", to: "role:Sales" }, { op: "addEdge", type: "can_approve", from: "role:Steward", to: "role:Finance" },
		{ op: "addEdge", type: "has_access_to", from: "role:Steward", to: "capability:org.admin" }, { op: "addEdge", type: "has_access_to", from: "role:Finance", to: "capability:invoice.approve" },
		{ op: "addMember", participant: p.root, node: "role:Steward" }, { op: "addMember", participant: p.sales, node: "role:Sales" }, { op: "addMember", participant: p.sales2, node: "role:Sales" },
		{ op: "addMember", participant: p.fin, node: "role:Finance" }, { op: "addMember", participant: p.fin2, node: "role:Finance" },
		{ op: "setAgent", participant: p.sales, model: "local/default", instructions: "You handle sales requests.", tools: ["collab"] },
	]);
}
