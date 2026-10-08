import type { DatabaseSync } from "node:sqlite";

/**
 * Who stands in for whom, and who must be told, read from the adopted version of an organization (Prompt 04 graph).
 * Read-only and optional: with no organization seeded the answers are empty and callers fall back to the channel.
 *   substitutes_for  from -> to : `from` covers for `to`        (backup)
 *   must_inform      from -> to : `to` must be told about `from`'s work
 * Team nodes whose name equals a channel id are how the default organization maps nodes to rooms.
 */
type Row = Record<string, any>;

function adopted(db: DatabaseSync, orgId: string): string | undefined {
	return (db.prepare("SELECT current_version_id v FROM organizations WHERE id = ?").get(orgId) as Row | undefined)?.v ?? undefined;
}

function nodesOf(db: DatabaseSync, version: string, agentId: string, tenantId: string): string[] {
	return (db.prepare(
		`SELECT m.node_id FROM org_memberships m JOIN participants p ON p.id = m.participant_id
		 WHERE m.version_id = ? AND p.tenant_id = ? AND p.kind = 'internal_agent' AND p.external_ref = ?`,
	).all(version, tenantId, agentId) as Row[]).map((r) => r.node_id);
}

/** Another agent that holds a node which substitutes for one of this agent's nodes. */
export function backupFor(db: DatabaseSync, agentId: string, orgId = "default", tenantId = "default"): string | null {
	const v = adopted(db, orgId);
	if (!v) return null;
	for (const n of nodesOf(db, v, agentId, tenantId)) {
		const subs = db.prepare(
			`SELECT p.external_ref ref FROM org_edges e
			 JOIN org_memberships m ON m.node_id = e.from_node AND m.version_id = e.version_id
			 JOIN participants p ON p.id = m.participant_id
			 WHERE e.version_id = ? AND e.type = 'substitutes_for' AND e.to_node = ? AND p.kind = 'internal_agent' AND p.external_ref <> ?`,
		).all(v, n, agentId) as Row[];
		if (subs.length) return subs[0].ref;
	}
	return null;
}

/** Names of team nodes that must be informed about this agent's work (callers map them to channels). */
export function informTargets(db: DatabaseSync, agentId: string, orgId = "default", tenantId = "default"): string[] {
	const v = adopted(db, orgId);
	if (!v) return [];
	const out = new Set<string>();
	for (const n of nodesOf(db, v, agentId, tenantId)) {
		for (const r of db.prepare("SELECT t.name, t.kind FROM org_edges e JOIN org_nodes t ON t.id = e.to_node WHERE e.version_id = ? AND e.type = 'must_inform' AND e.from_node = ?").all(v, n) as Row[]) {
			if (r.kind === "team") out.add(r.name);
		}
	}
	return [...out];
}
