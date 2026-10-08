import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { db as defaultDb } from "../db.ts";
import { AUTHORITATIVE_EDGES, edgeClass, isKnownEdge, RegistryError, type Actor, type Capability, type Finding, type NodeKind, type Op, type ParticipantKind } from "./types.ts";

/**
 * Organization Registry: the single place that says who is who in an organization and what they may do.
 * Every function takes the server-resolved Actor, scopes by tenant, and checks authority itself, so UI routes,
 * agent tools, Temporal activities and MCP can all call it and none can bypass it.
 * Node references in operations are "kind:name", e.g. "team:Sales".
 */
type Row = Record<string, any>;
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const NODE_KINDS = ["team", "role", "capability", "system", "external_party"];

export class Registry {
	readonly db: DatabaseSync;
	constructor(db: DatabaseSync = defaultDb) {
		this.db = db;
	}

	// ------------------------------------------------------------------ tenancy and authority

	/** Looks an organization up inside the actor's tenant. A stranger gets the same 404 as for a missing one. */
	private org(actor: Actor, orgId: string, opts: { internal?: boolean } = {}): Row {
		const o = this.db.prepare("SELECT * FROM organizations WHERE id = ? AND tenant_id = ?").get(orgId, actor.tenantId) as Row | undefined;
		if (!o || (!opts.internal && !this.readable(actor, o))) throw new RegistryError(404, "no such organization"); // also for "exists in another tenant"
		return o;
	}

	private version(actor: Actor, orgId: string, versionId: string): Row {
		this.org(actor, orgId);
		const v = this.db.prepare("SELECT * FROM org_versions WHERE id = ? AND organization_id = ? AND tenant_id = ?").get(versionId, orgId, actor.tenantId) as Row | undefined;
		if (!v) throw new RegistryError(404, "no such version");
		return v;
	}

	/**
	 * Rights come from authoritative edges only, out of the nodes the actor holds (membership in the adopted version,
	 * plus role nodes named like the actor's platform roles, e.g. Keycloak "approver"). Descriptive edges are never read.
	 */
	private heldNodes(actor: Actor, o: Row, now = Date.now()): Set<string> {
		const held = new Set<string>();
		if (!o.current_version_id) return held;
		for (const m of this.db.prepare("SELECT node_id, valid_from, valid_to FROM org_memberships WHERE version_id = ? AND participant_id = ?").all(o.current_version_id, actor.participantId) as Row[]) {
			if ((m.valid_from ?? 0) <= now && (m.valid_to ?? Infinity) > now) held.add(m.node_id);
		}
		for (const r of actor.platformRoles) {
			const n = this.db.prepare("SELECT id FROM org_nodes WHERE version_id = ? AND kind = 'role' AND name = ?").get(o.current_version_id, r) as Row | undefined;
			if (n) held.add(n.id);
		}
		return held;
	}

	/** Reading needs a place in the organization (or, before its first version is adopted, the platform admin role). Else: 404. */
	private readable(actor: Actor, o: Row): boolean {
		if (actor.operator) return true;
		return o.current_version_id ? this.heldNodes(actor, o).size > 0 : actor.platformRoles.includes("admin");
	}

	effectiveGrants(actor: Actor, orgId: string, now = Date.now()): { type: string; target: string; targetKind: string }[] {
		const o = this.org(actor, orgId);
		const held = this.heldNodes(actor, o, now);
		if (!held.size) return [];
		const marks = [...held].map(() => "?").join(",");
		const rows = this.db.prepare(
			`SELECT e.type, n.name target, n.kind targetKind FROM org_edges e JOIN org_nodes n ON n.id = e.to_node
			 WHERE e.version_id = ? AND e.class = 'authoritative' AND (e.valid_to IS NULL OR e.valid_to > ?) AND e.from_node IN (${marks})`,
		).all(o.current_version_id, now, ...held) as Row[];
		return rows.map((r) => ({ type: r.type, target: r.target, targetKind: r.targetKind }));
	}

	can(actor: Actor, orgId: string, cap: Capability): boolean {
		if (actor.operator) return true;
		const g = this.effectiveGrants(actor, orgId);
		const has = (c: string) => g.some((x) => x.type === "has_access_to" && x.targetKind === "capability" && x.target === c);
		return has("org.admin") || (cap === "org.edit" && has("org.edit"));
	}

	private require(actor: Actor, orgId: string, cap: Capability) {
		if (!this.can(actor, orgId, cap)) throw new RegistryError(403, `requires ${cap}`);
	}

	// ------------------------------------------------------------------ participants

	/** Tenant-level actor. Idempotent on (kind, external ref): a Keycloak sub, an agent id, an MCP client id. */
	ensureParticipant(tenantId: string, kind: ParticipantKind, externalRef: string, name: string): string {
		const have = this.db.prepare("SELECT id FROM participants WHERE tenant_id = ? AND kind = ? AND external_ref = ?").get(tenantId, kind, externalRef) as Row | undefined;
		if (have) return have.id;
		const pid = id("p");
		this.db.prepare("INSERT INTO participants (id, tenant_id, kind, name, external_ref, created_at) VALUES (?,?,?,?,?,?)").run(pid, tenantId, kind, name, externalRef, Date.now());
		return pid;
	}

	// ------------------------------------------------------------------ organizations and versions

	/**
	 * Creates an organization with an empty first draft. Needs the tenant-level platform role "admin": there is no
	 * organization yet to hold a graph grant. The draft must be filled and adopted before it grants anything.
	 */
	createOrg(actor: Actor, o: { name: string; entityId?: string; id?: string }) {
		if (!actor.operator && !actor.platformRoles.includes("admin")) throw new RegistryError(403, "creating an organization needs the admin role");
		const name = o.name.trim();
		if (name.length < 2 || name.length > 80) throw new RegistryError(400, "name must be 2-80 characters");
		const orgId = o.id ?? id("org");
		return this.tx(() => {
			this.db.prepare("INSERT INTO organizations (id, tenant_id, name, created_at, entity_id, created_by) VALUES (?,?,?,?,?,?)").run(orgId, actor.tenantId, name, Date.now(), o.entityId ?? "default", actor.participantId);
			const v = this.newVersion(actor, orgId, null, "initial draft");
			return { organizationId: orgId, versionId: v };
		});
	}

	listOrgs(actor: Actor) {
		return (this.db.prepare("SELECT * FROM organizations WHERE tenant_id = ? ORDER BY created_at").all(actor.tenantId) as Row[]).filter((r) => this.readable(actor, r)).map((r) => ({ id: r.id, name: r.name, entityId: r.entity_id, currentVersionId: r.current_version_id }));
	}

	listVersions(actor: Actor, orgId: string) {
		this.org(actor, orgId);
		return (this.db.prepare("SELECT id, number, status, parent_version_id, note, created_at, adopted_at FROM org_versions WHERE organization_id = ? ORDER BY number").all(orgId) as Row[]).map((r) => ({ id: r.id, number: r.number, status: r.status, parentVersionId: r.parent_version_id, note: r.note, createdAt: r.created_at, adoptedAt: r.adopted_at }));
	}

	/** New draft, copied from `from` (default: the adopted version). Needs org.edit. */
	createDraft(actor: Actor, orgId: string, from?: string, note = "", opts: { empty?: boolean } = {}) {
		const o = this.org(actor, orgId);
		this.require(actor, orgId, "org.edit");
		const src = opts.empty ? null : (from ?? o.current_version_id);
		if (src) this.version(actor, orgId, src);
		return this.tx(() => ({ versionId: this.newVersion(actor, orgId, src ?? null, note) }));
	}

	/** Copy a whole organization (its adopted version, or the latest) as a new organization with a fresh draft. */
	copyOrg(actor: Actor, orgId: string, name: string) {
		const o = this.org(actor, orgId);
		this.require(actor, orgId, "org.admin");
		const src = o.current_version_id ?? (this.db.prepare("SELECT id FROM org_versions WHERE organization_id = ? ORDER BY number DESC LIMIT 1").get(orgId) as Row).id;
		return this.tx(() => {
			const copyId = id("org");
			this.db.prepare("INSERT INTO organizations (id, tenant_id, name, created_at, entity_id, created_by) VALUES (?,?,?,?,?,?)").run(copyId, actor.tenantId, name.trim(), Date.now(), o.entity_id, actor.participantId);
			// copyVersionContent reads the source by version id and writes the new draft; the draft belongs to the new org.
			const vid = this.newVersion(actor, copyId, src, `copy of ${o.name}`, true);
			return { organizationId: copyId, versionId: vid };
		});
	}

	/** Internal: creates a draft row (and copies content). Callers check authority. */
	newVersion(actor: Actor, orgId: string, from: string | null, note: string, crossOrg = false): string {
		const n = ((this.db.prepare("SELECT COALESCE(MAX(number), 0) n FROM org_versions WHERE organization_id = ?").get(orgId) as Row).n as number) + 1;
		const vid = id("ver");
		this.db.prepare("INSERT INTO org_versions (id, organization_id, tenant_id, number, status, parent_version_id, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(vid, orgId, actor.tenantId, n, "draft", crossOrg ? null : from, note, actor.participantId, Date.now());
		if (from) this.copyContent(from, vid, actor.tenantId);
		return vid;
	}

	private copyContent(from: string, to: string, tenantId: string) {
		const nodeMap = new Map<string, string>();
		for (const n of this.db.prepare("SELECT * FROM org_nodes WHERE version_id = ?").all(from) as Row[]) {
			const nid = id("n");
			nodeMap.set(n.id, nid);
			this.db.prepare("INSERT INTO org_nodes (id, version_id, tenant_id, kind, name, attrs) VALUES (?,?,?,?,?,?)").run(nid, to, tenantId, n.kind, n.name, n.attrs);
		}
		for (const e of this.db.prepare("SELECT * FROM org_edges WHERE version_id = ?").all(from) as Row[]) {
			this.db.prepare("INSERT INTO org_edges (id, version_id, tenant_id, from_node, to_node, type, class, granted_by, valid_to, policy_version_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id("e"), to, tenantId, nodeMap.get(e.from_node), nodeMap.get(e.to_node), e.type, e.class, e.granted_by, e.valid_to, e.policy_version_id, e.created_at);
		}
		for (const m of this.db.prepare("SELECT * FROM org_memberships WHERE version_id = ?").all(from) as Row[]) {
			this.db.prepare("INSERT INTO org_memberships (version_id, tenant_id, participant_id, node_id, role, valid_from, valid_to) VALUES (?,?,?,?,?,?,?)").run(to, tenantId, m.participant_id, nodeMap.get(m.node_id), m.role, m.valid_from, m.valid_to);
		}
		for (const a of this.db.prepare("SELECT * FROM org_agent_configs WHERE version_id = ?").all(from) as Row[]) {
			this.db.prepare("INSERT INTO org_agent_configs (version_id, tenant_id, participant_id, model, instructions, tools) VALUES (?,?,?,?,?,?)").run(to, tenantId, a.participant_id, a.model, a.instructions, a.tools);
		}
		for (const p of this.db.prepare("SELECT * FROM org_policies WHERE version_id = ?").all(from) as Row[]) {
			this.db.prepare("INSERT INTO org_policies (id, version_id, tenant_id, kind, name, body, hash) VALUES (?,?,?,?,?,?,?)").run(id("pol"), to, tenantId, p.kind, p.name, p.body, p.hash);
		}
	}

	// ------------------------------------------------------------------ editing (drafts only)

	/** Applies operations to a draft atomically. Descriptive edges need org.edit, authoritative ones org.admin. */
	applyOps(actor: Actor, orgId: string, versionId: string, ops: Op[]) {
		const v = this.version(actor, orgId, versionId);
		if (v.status !== "draft") throw new RegistryError(409, `version ${v.number} is ${v.status}; make a new draft to change it`);
		const bootstrap = !this.org(actor, orgId).current_version_id && (actor.operator || actor.platformRoles.includes("admin")); // the first draft of a new org
		if (!bootstrap) this.require(actor, orgId, "org.edit");
		if (ops.length > 500) throw new RegistryError(400, "at most 500 operations per call");
		this.tx(() => {
			for (const op of ops) this.applyOp(actor, orgId, versionId, op, bootstrap);
		});
		return { applied: ops.length };
	}

	private nodeByRef(versionId: string, ref: string): Row {
		const i = ref.indexOf(":");
		const kind = ref.slice(0, i), name = ref.slice(i + 1);
		if (i < 1 || !NODE_KINDS.includes(kind)) throw new RegistryError(400, `bad node reference "${ref}" (use kind:name)`);
		const n = this.db.prepare("SELECT * FROM org_nodes WHERE version_id = ? AND kind = ? AND name = ?").get(versionId, kind, name) as Row | undefined;
		if (!n) throw new RegistryError(404, `no node ${ref}`);
		return n;
	}

	private applyOp(actor: Actor, orgId: string, vid: string, op: Op, bootstrap: boolean) {
		const t = actor.tenantId;
		const admin = bootstrap || this.can(actor, orgId, "org.admin");
		switch (op.op) {
			case "addNode": {
				if (!NODE_KINDS.includes(op.kind)) throw new RegistryError(400, `bad node kind ${op.kind}`);
				const name = String(op.name ?? "").trim();
				if (!name || name.length > 80 || name.includes("\0")) throw new RegistryError(400, "node name must be 1-80 characters");
				this.db.prepare("INSERT OR IGNORE INTO org_nodes (id, version_id, tenant_id, kind, name, attrs) VALUES (?,?,?,?,?,?)").run(id("n"), vid, t, op.kind, name, JSON.stringify(op.attrs ?? {}));
				return;
			}
			case "removeNode": {
				const n = this.nodeByRef(vid, `${op.kind}:${op.name}`);
				this.db.prepare("DELETE FROM org_edges WHERE from_node = ? OR to_node = ?").run(n.id, n.id);
				this.db.prepare("DELETE FROM org_memberships WHERE node_id = ?").run(n.id);
				this.db.prepare("DELETE FROM org_nodes WHERE id = ?").run(n.id);
				return;
			}
			case "addEdge": {
				if (!isKnownEdge(op.type)) throw new RegistryError(400, `unknown edge type ${op.type}`);
				const cls = edgeClass(op.type);
				if (cls === "authoritative" && !admin) throw new RegistryError(403, `edge ${op.type} grants rights and needs org.admin`);
				const a = this.nodeByRef(vid, op.from), b = this.nodeByRef(vid, op.to);
				if (a.id === b.id) throw new RegistryError(400, "an edge cannot point to its own node");
				this.db.prepare("INSERT OR IGNORE INTO org_edges (id, version_id, tenant_id, from_node, to_node, type, class, granted_by, valid_to, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id("e"), vid, t, a.id, b.id, op.type, cls, cls === "authoritative" ? actor.participantId : null, op.validToMs ?? null, Date.now());
				return;
			}
			case "removeEdge": {
				const cls = edgeClass(op.type);
				if (cls === "authoritative" && !admin) throw new RegistryError(403, `removing ${op.type} needs org.admin`);
				const a = this.nodeByRef(vid, op.from), b = this.nodeByRef(vid, op.to);
				this.db.prepare("DELETE FROM org_edges WHERE version_id = ? AND from_node = ? AND to_node = ? AND type = ?").run(vid, a.id, b.id, op.type);
				return;
			}
			case "addMember": {
				const p = this.db.prepare("SELECT id FROM participants WHERE id = ? AND tenant_id = ?").get(op.participant, t) as Row | undefined;
				if (!p) throw new RegistryError(404, "no such participant in this tenant");
				const n = this.nodeByRef(vid, op.node);
				this.db.prepare("INSERT OR REPLACE INTO org_memberships (version_id, tenant_id, participant_id, node_id, role) VALUES (?,?,?,?,?)").run(vid, t, op.participant, n.id, op.role ?? "member");
				return;
			}
			case "removeMember": {
				const n = this.nodeByRef(vid, op.node);
				this.db.prepare("DELETE FROM org_memberships WHERE version_id = ? AND participant_id = ? AND node_id = ?").run(vid, op.participant, n.id);
				return;
			}
			case "setAgent": {
				const p = this.db.prepare("SELECT kind FROM participants WHERE id = ? AND tenant_id = ?").get(op.participant, t) as Row | undefined;
				if (!p) throw new RegistryError(404, "no such participant in this tenant");
				if (p.kind === "human") throw new RegistryError(400, "only agents have a model and instructions");
				if ((op.instructions ?? "").length > 8000) throw new RegistryError(400, "instructions too long");
				this.db.prepare("INSERT OR REPLACE INTO org_agent_configs (version_id, tenant_id, participant_id, model, instructions, tools) VALUES (?,?,?,?,?,?)").run(vid, t, op.participant, op.model ?? null, op.instructions ?? "", JSON.stringify(op.tools ?? []));
				return;
			}
			case "setPolicy": {
				if (!admin) throw new RegistryError(403, "policies need org.admin");
				const body = JSON.stringify(op.body ?? {});
				this.db.prepare("INSERT OR REPLACE INTO org_policies (id, version_id, tenant_id, kind, name, body, hash) VALUES (?,?,?,?,?,?,?)").run(id("pol"), vid, t, op.kind, op.name, body, createHash("sha256").update(body).digest("hex"));
				return;
			}
			default:
				throw new RegistryError(400, `unknown operation ${(op as any).op}`);
		}
	}

	// ------------------------------------------------------------------ reading

	describe(actor: Actor, orgId: string, versionId?: string) {
		const o = this.org(actor, orgId);
		const vid = versionId ?? o.current_version_id ?? (this.db.prepare("SELECT id FROM org_versions WHERE organization_id = ? ORDER BY number DESC LIMIT 1").get(orgId) as Row).id;
		const v = this.version(actor, orgId, vid);
		const nodes = (this.db.prepare("SELECT id, kind, name, attrs FROM org_nodes WHERE version_id = ? ORDER BY kind, name").all(vid) as Row[]).map((n) => ({ id: n.id, kind: n.kind, name: n.name, attrs: JSON.parse(n.attrs) }));
		const name = new Map(nodes.map((n) => [n.id, `${n.kind}:${n.name}`]));
		const edges = (this.db.prepare("SELECT type, class, from_node, to_node, granted_by, valid_to FROM org_edges WHERE version_id = ?").all(vid) as Row[]).map((e) => ({ type: e.type, class: e.class, from: name.get(e.from_node)!, to: name.get(e.to_node)!, grantedBy: e.granted_by, validTo: e.valid_to }));
		const members = (this.db.prepare("SELECT m.participant_id, m.node_id, m.role, p.name pname, p.kind pkind FROM org_memberships m JOIN participants p ON p.id = m.participant_id WHERE m.version_id = ?").all(vid) as Row[]).map((m) => ({ participantId: m.participant_id, name: m.pname, kind: m.pkind, node: name.get(m.node_id)!, role: m.role }));
		const editor = this.can(actor, orgId, "org.edit");
		// Instructions and tools are configuration: visible to editors only.
		const agents = (this.db.prepare("SELECT participant_id, model, instructions, tools FROM org_agent_configs WHERE version_id = ?").all(vid) as Row[]).map((a) => ({ participantId: a.participant_id, model: a.model, ...(editor ? { instructions: a.instructions, tools: JSON.parse(a.tools) } : { instructions: null, tools: null }) }));
		const policies = (this.db.prepare("SELECT kind, name, body, hash FROM org_policies WHERE version_id = ?").all(vid) as Row[]).map((p) => ({ kind: p.kind, name: p.name, body: JSON.parse(p.body), hash: p.hash }));
		return { organization: { id: o.id, name: o.name, entityId: o.entity_id, currentVersionId: o.current_version_id }, version: { id: v.id, number: v.number, status: v.status }, nodes, edges, members, agents, policies };
	}

	// ------------------------------------------------------------------ validation and adoption

	validate(actor: Actor, orgId: string, versionId: string): Finding[] {
		this.version(actor, orgId, versionId);
		return validateGraph(this.describe(actor, orgId, versionId));
	}

	/** Adopt a draft: errors block it; warnings are returned. The previous adopted version is archived. */
	adopt(actor: Actor, orgId: string, versionId: string) {
		const v = this.version(actor, orgId, versionId);
		const o = this.org(actor, orgId);
		const bootstrap = !o.current_version_id && (actor.operator || actor.platformRoles.includes("admin"));
		if (!bootstrap) this.require(actor, orgId, "org.admin");
		if (v.status !== "draft") throw new RegistryError(409, `version ${v.number} is already ${v.status}`);
		const findings = this.validate(actor, orgId, versionId);
		const errors = findings.filter((f) => f.severity === "error");
		if (errors.length) throw Object.assign(new RegistryError(409, `cannot adopt: ${errors.map((e) => e.message).join("; ")}`), { findings });
		this.tx(() => {
			if (o.current_version_id) this.db.prepare("UPDATE org_versions SET status = 'archived' WHERE id = ?").run(o.current_version_id);
			this.db.prepare("UPDATE org_versions SET status = 'adopted', adopted_at = ? WHERE id = ?").run(Date.now(), versionId);
			this.db.prepare("UPDATE organizations SET current_version_id = ? WHERE id = ?").run(versionId, orgId);
		});
		return { adopted: versionId, warnings: findings };
	}

	private tx<T>(fn: () => T): T {
		this.db.exec("SAVEPOINT reg");
		try {
			const r = fn();
			this.db.exec("RELEASE reg");
			return r;
		} catch (e) {
			this.db.exec("ROLLBACK TO reg");
			this.db.exec("RELEASE reg");
			throw e;
		}
	}
}

// ---------------------------------------------------------------------- pure graph validation (no I/O)

type Described = ReturnType<Registry["describe"]>;

function cycles(nodes: string[], edges: [string, string][]): string[][] {
	const next = new Map<string, string[]>();
	for (const [a, b] of edges) next.set(a, [...(next.get(a) ?? []), b]);
	const out: string[][] = [], state = new Map<string, 1 | 2>(), stack: string[] = [];
	const visit = (n: string) => {
		state.set(n, 1);
		stack.push(n);
		for (const m of next.get(n) ?? []) {
			if (state.get(m) === 1) out.push([...stack.slice(stack.indexOf(m)), m]);
			else if (!state.has(m)) visit(m);
		}
		stack.pop();
		state.set(n, 2);
	};
	for (const n of nodes) if (!state.has(n)) visit(n);
	return out;
}

/** Deterministic checks of Prompt 04 item 6. Same code for every organization type. */
export function validateGraph(d: Described): Finding[] {
	const out: Finding[] = [];
	const names = d.nodes.map((n) => `${n.kind}:${n.name}`);
	const of = (type: string) => d.edges.filter((e) => e.type === type);
	const staffed = new Set(d.members.map((m) => m.node));
	const cyc = (type: string, severity: "error" | "warning", what: string) => {
		for (const c of cycles(names, of(type).map((e) => [e.from, e.to]))) out.push({ severity, code: `${type}_cycle`, message: `${what} cycle: ${c.join(" -> ")}`, nodes: c });
	};
	cyc("can_approve", "error", "approval");
	cyc("can_delegate", "error", "delegation");
	cyc("reports_to", "error", "reporting");
	cyc("depends_on", "warning", "dependency");
	for (const e of of("can_approve")) {
		if (!staffed.has(e.from)) out.push({ severity: "error", code: "unstaffed_approver", message: `${e.from} can approve ${e.to} but nobody holds it`, nodes: [e.from] });
	}
	for (const e of of("must_inform")) {
		if (!staffed.has(e.to)) out.push({ severity: "warning", code: "uninformable", message: `${e.from} must inform ${e.to}, which nobody holds`, nodes: [e.to] });
	}
	const resp = new Set(of("responsible_for").map((e) => e.to));
	for (const n of d.nodes) {
		const ref = `${n.kind}:${n.name}`;
		const held = of("has_access_to").concat(of("can_approve"), of("can_delegate")).some((e) => e.to === ref) || resp.has(ref);
		if ((n.kind === "capability" || n.kind === "system") && !held) out.push({ severity: "warning", code: "unowned", message: `${ref} has no responsible or authorized holder`, nodes: [ref] });
		if ((n.kind === "team" || n.kind === "role") && !staffed.has(ref)) out.push({ severity: "warning", code: "empty_node", message: `${ref} has no members`, nodes: [ref] });
	}
	// Critical single points: a responsibility whose only holder is one participant with no substitute.
	for (const target of resp) {
		const holders = of("responsible_for").filter((e) => e.to === target).map((e) => e.from);
		const people = new Set(d.members.filter((m) => holders.includes(m.node)).map((m) => m.participantId));
		const covered = holders.some((h) => of("substitutes_for").some((s) => s.to === h || s.from === h));
		if (people.size === 1 && !covered) out.push({ severity: "warning", code: "single_point", message: `${target} depends on a single participant without a substitute`, nodes: [target] });
	}
	// Conflicting rights: whoever does the work also approves it.
	for (const a of of("can_approve")) {
		if (of("responsible_for").some((r) => r.from === a.from && r.to === a.to)) out.push({ severity: "warning", code: "self_approval", message: `${a.from} is responsible for and can approve ${a.to}`, nodes: [a.from, a.to] });
	}
	return out;
}
