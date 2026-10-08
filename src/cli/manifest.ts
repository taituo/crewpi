import { parse as parseYaml, stringify as toYaml } from "yaml";
import { Registry } from "../org/registry.ts";
import type { Actor, Finding, Op, ParticipantKind } from "../org/types.ts";

/**
 * Declarative configuration: one file describes a realm, its entities and their organizations. `applyManifest` makes
 * the registry match it through the normal Registry operations (a new version, validated, adopted), and is idempotent:
 * applying the same file twice changes nothing. `exportManifest` writes a file `applyManifest` accepts.
 *
 * Participants are written as "kind:ref", e.g. "human:alice" (a login's sub or handle), "agent:ops", "external:codex".
 */
export type OrgSpec = {
	name: string;
	entity?: string;
	nodes?: { kind: string; name: string; attrs?: Record<string, unknown> }[];
	edges?: { type: string; from: string; to: string }[];
	members?: { participant: string; node: string; role?: string }[];
	agents?: { participant: string; model?: string; instructions?: string; tools?: string[] }[];
	policies?: { kind: string; name: string; body: Record<string, unknown> }[];
};
export type Manifest = {
	realm?: { id?: string; name: string };
	entities?: { id: string; name: string; kind?: string }[];
	organizations?: OrgSpec[];
};

const KINDS: Record<string, ParticipantKind> = { human: "human", agent: "internal_agent", external: "external_agent", assistant: "assistant_agent", service: "service" };
const PREFIX: Record<ParticipantKind, string> = { human: "human", internal_agent: "agent", external_agent: "external", assistant_agent: "assistant", service: "service" };

export function parseManifest(text: string, filename = ""): Manifest {
	let m: any;
	try {
		m = /\.json$/i.test(filename) ? JSON.parse(text) : parseYaml(text);
	} catch (e) {
		throw new Error(`cannot parse ${filename || "config"}: ${(e as Error).message}`);
	}
	if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("the config must be an object with realm / entities / organizations");
	for (const k of Object.keys(m)) if (!["realm", "entities", "organizations"].includes(k)) throw new Error(`unknown top-level key "${k}" (expected realm, entities, organizations)`);
	for (const o of m.organizations ?? []) {
		if (!o?.name || typeof o.name !== "string") throw new Error("every organization needs a name");
		for (const k of Object.keys(o)) if (!["name", "entity", "nodes", "edges", "members", "agents", "policies"].includes(k)) throw new Error(`organization "${o.name}": unknown key "${k}"`);
	}
	return m as Manifest;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

function participantOf(reg: Registry, tenantId: string, spec: string): string {
	const i = spec.indexOf(":");
	const kind = KINDS[spec.slice(0, i)];
	if (i < 1 || !kind || !spec.slice(i + 1)) throw new Error(`participant "${spec}" must look like human:alice, agent:ops, external:name, assistant:name or service:name`);
	const ref = spec.slice(i + 1);
	return reg.ensureParticipant(tenantId, kind, ref, ref);
}

/** The operations that build exactly this organization in an empty draft. */
export function opsOf(reg: Registry, tenantId: string, o: OrgSpec): Op[] {
	const ops: Op[] = [];
	for (const n of o.nodes ?? []) ops.push({ op: "addNode", kind: n.kind as any, name: n.name, attrs: n.attrs });
	for (const e of o.edges ?? []) ops.push({ op: "addEdge", type: e.type as any, from: e.from, to: e.to });
	for (const m of o.members ?? []) ops.push({ op: "addMember", participant: participantOf(reg, tenantId, m.participant), node: m.node, role: m.role });
	for (const a of o.agents ?? []) ops.push({ op: "setAgent", participant: participantOf(reg, tenantId, a.participant), model: a.model, instructions: a.instructions, tools: a.tools });
	for (const p of o.policies ?? []) ops.push({ op: "setPolicy", kind: p.kind, name: p.name, body: p.body });
	return ops;
}

/** Canonical, order-independent form of what an organization contains; used to tell "unchanged" from "changed". */
export function canonical(spec: OrgSpec): string {
	const sort = <T>(a: T[] | undefined, key: (x: T) => string) => [...(a ?? [])].sort((x, y) => key(x).localeCompare(key(y)));
	return JSON.stringify({
		nodes: sort(spec.nodes, (n) => `${n.kind}:${n.name}`).map((n) => [n.kind, n.name, n.attrs && Object.keys(n.attrs).length ? n.attrs : {}]),
		edges: sort(spec.edges, (e) => `${e.type}|${e.from}|${e.to}`).map((e) => [e.type, e.from, e.to]),
		members: sort(spec.members, (m) => `${m.participant}|${m.node}`).map((m) => [m.participant, m.node, m.role ?? "member"]),
		agents: sort(spec.agents, (a) => a.participant).map((a) => [a.participant, a.model ?? null, a.instructions ?? "", a.tools ?? []]),
		policies: sort(spec.policies, (p) => `${p.kind}|${p.name}`).map((p) => [p.kind, p.name, p.body]),
	});
}

export type Plan = { realm?: string; entities: string[]; organizations: { name: string; action: "create" | "update" | "unchanged"; findings: Finding[]; adopted?: boolean }[] };

export function applyManifest(reg: Registry, actor: Actor, m: Manifest, opts: { dryRun?: boolean; adopt?: boolean } = {}): Plan {
	const db = reg.db;
	const tenant = actor.tenantId;
	const plan: Plan = { entities: [], organizations: [] };
	const write = !opts.dryRun;
	if (m.realm) {
		const id = m.realm.id ?? slug(m.realm.name);
		plan.realm = id;
		if (write) db.prepare("INSERT INTO business_realms (id, tenant_id, name, created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name WHERE tenant_id = excluded.tenant_id").run(id, tenant, m.realm.name, Date.now());
	}
	const realmId = m.realm ? (m.realm.id ?? slug(m.realm.name)) : "default";
	for (const e of m.entities ?? []) {
		plan.entities.push(e.id);
		if (write) db.prepare("INSERT INTO entities (id, tenant_id, realm_id, name, kind, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name WHERE tenant_id = excluded.tenant_id").run(e.id, tenant, realmId, e.name, e.kind ?? "organization", Date.now());
	}
	for (const spec of m.organizations ?? []) {
		const existing = db.prepare("SELECT id, current_version_id FROM organizations WHERE tenant_id = ? AND name = ?").get(tenant, spec.name) as { id: string; current_version_id: string | null } | undefined;
		let unchanged = false;
		if (existing?.current_version_id) unchanged = canonical(exportOrg(reg, actor, existing.id)) === canonical(spec);
		const entry = { name: spec.name, action: (!existing ? "create" : unchanged ? "unchanged" : "update") as "create" | "update" | "unchanged", findings: [] as Finding[], adopted: undefined as boolean | undefined };
		plan.organizations.push(entry);
		if (unchanged) continue;
		if (opts.dryRun) {
			// Check the desired organization on its own, in a scratch copy of the registry, so nothing is written.
			entry.findings = scratchValidate(reg, tenant, spec);
			continue;
		}
		const orgId = existing?.id ?? reg.createOrg(actor, { name: spec.name, entityId: spec.entity }).organizationId;
		const draft = existing ? reg.createDraft(actor, orgId, undefined, "applied from config", { empty: true }).versionId : (db.prepare("SELECT id FROM org_versions WHERE organization_id = ? ORDER BY number DESC LIMIT 1").get(orgId) as { id: string }).id;
		try {
			reg.applyOps(actor, orgId, draft, opsOf(reg, tenant, spec));
			entry.findings = reg.validate(actor, orgId, draft);
			if (opts.adopt !== false) {
				reg.adopt(actor, orgId, draft);
				entry.adopted = true;
			}
		} catch (e: any) {
			if (e.findings) entry.findings = e.findings;
			throw Object.assign(new Error(`organization "${spec.name}": ${e.message}`), { findings: entry.findings });
		}
	}
	return plan;
}

function scratchValidate(reg: Registry, tenant: string, spec: OrgSpec): Finding[] {
	const scratch = new Registry(newMemoryDb());
	const actor: Actor = { tenantId: tenant, participantId: "scratch", platformRoles: [], operator: true };
	scratch.db.prepare("INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?,?,?)").run(tenant, tenant, 1);
	const { organizationId, versionId } = scratch.createOrg(actor, { name: spec.name });
	scratch.applyOps(actor, organizationId, versionId, opsOf(scratch, tenant, spec));
	return scratch.validate(actor, organizationId, versionId);
}

import { DatabaseSync } from "node:sqlite";
import { migrate } from "../migrate.ts";
import { MIGRATIONS } from "../migrations.ts";
function newMemoryDb() {
	const db = new DatabaseSync(":memory:");
	migrate(db, MIGRATIONS);
	return db;
}

/** One organization as a spec (adopted version, or the latest draft). */
export function exportOrg(reg: Registry, actor: Actor, orgId: string): OrgSpec {
	const d = reg.describe(actor, orgId);
	const ref = new Map<string, string>(); // participant id -> "kind:ref"
	const who = (pid: string) => {
		if (!ref.has(pid)) {
			const p = reg.db.prepare("SELECT kind, external_ref FROM participants WHERE id = ?").get(pid) as { kind: ParticipantKind; external_ref: string };
			ref.set(pid, `${PREFIX[p.kind]}:${p.external_ref}`);
		}
		return ref.get(pid)!;
	};
	const spec: OrgSpec = { name: d.organization.name };
	if (d.organization.entityId && d.organization.entityId !== "default") spec.entity = d.organization.entityId;
	spec.nodes = d.nodes.map((n) => ({ kind: n.kind, name: n.name, ...(Object.keys(n.attrs).length ? { attrs: n.attrs } : {}) }));
	spec.edges = d.edges.map((e) => ({ type: e.type, from: e.from, to: e.to }));
	spec.members = d.members.map((m) => ({ participant: who(m.participantId), node: m.node, ...(m.role !== "member" ? { role: m.role } : {}) }));
	spec.agents = d.agents.map((a) => ({ participant: who(a.participantId), ...(a.model ? { model: a.model } : {}), ...(a.instructions ? { instructions: a.instructions } : {}), ...(a.tools?.length ? { tools: a.tools } : {}) }));
	spec.policies = d.policies.map((p) => ({ kind: p.kind, name: p.name, body: p.body }));
	return spec;
}

export function exportManifest(reg: Registry, actor: Actor, orgIds: string[], format: "yaml" | "json" = "yaml"): string {
	const m: Manifest = { organizations: orgIds.map((id) => exportOrg(reg, actor, id)) };
	return format === "json" ? JSON.stringify(m, null, 2) + "\n" : toYaml(m);
}
