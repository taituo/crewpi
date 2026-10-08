import { AGENTS, SEED_CHANNELS } from "../agents.ts";
import { DEFAULT_ORG, DEFAULT_TENANT } from "../migrations.ts";
import { Registry } from "./registry.ts";
import type { Actor, Op } from "./types.ts";

/**
 * Makes the original CrewPi demo the "default organization": its four agents become participants with a role each,
 * Keycloak's platform roles become role nodes with the rights the demo already had, and its standing channels
 * become teams. Idempotent; does nothing once the default organization has an adopted version.
 * The runtime does not read this yet: it describes the demo, it does not drive it (see docs).
 */
export function seedDefaultOrg(reg = new Registry()): boolean {
	const system: Actor = { tenantId: DEFAULT_TENANT, participantId: "system", platformRoles: ["admin"] };
	const have = reg.db.prepare("SELECT current_version_id v FROM organizations WHERE id = ?").get(DEFAULT_ORG) as { v: string | null } | undefined;
	if (!have || have.v) return false;
	const draft = reg.db.prepare("SELECT id FROM org_versions WHERE organization_id = ? ORDER BY number DESC LIMIT 1").get(DEFAULT_ORG) as { id: string } | undefined;
	const vid = draft?.id ?? reg.newVersion(system, DEFAULT_ORG, null, "seeded from the demo");
	const ops: Op[] = [
		{ op: "addNode", kind: "capability", name: "org.admin" }, { op: "addNode", kind: "capability", name: "org.edit" },
		{ op: "addNode", kind: "capability", name: "approve" }, { op: "addNode", kind: "capability", name: "operate" }, { op: "addNode", kind: "capability", name: "post" },
		...["admin", "approver", "operator", "viewer"].map((r) => ({ op: "addNode", kind: "role", name: r }) as Op),
		{ op: "addEdge", type: "has_access_to", from: "role:admin", to: "capability:org.admin" }, { op: "addEdge", type: "has_access_to", from: "role:admin", to: "capability:org.edit" },
		{ op: "addEdge", type: "has_access_to", from: "role:admin", to: "capability:approve" },
		{ op: "addEdge", type: "has_access_to", from: "role:approver", to: "capability:approve" }, { op: "addEdge", type: "has_access_to", from: "role:approver", to: "capability:operate" },
		{ op: "addEdge", type: "has_access_to", from: "role:operator", to: "capability:operate" }, { op: "addEdge", type: "has_access_to", from: "role:operator", to: "capability:post" },
		...SEED_CHANNELS.map((c) => ({ op: "addNode", kind: "team", name: c.id, attrs: { topic: c.topic } }) as Op),
	];
	for (const a of AGENTS) {
		const pid = reg.ensureParticipant(DEFAULT_TENANT, "internal_agent", a.id, a.name);
		ops.push({ op: "addNode", kind: "role", name: a.title }, { op: "addMember", participant: pid, node: `role:${a.title}` },
			{ op: "setAgent", participant: pid, model: `${a.model.provider}/${a.model.modelId}`, instructions: a.instructions, tools: a.extensions });
		for (const c of SEED_CHANNELS) if (c.agents.includes(a.id)) ops.push({ op: "addMember", participant: pid, node: `team:${c.id}` });
	}
	reg.applyOps(system, DEFAULT_ORG, vid, ops);
	reg.adopt(system, DEFAULT_ORG, vid);
	return true;
}
