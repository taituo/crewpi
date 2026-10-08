import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-org-"));
process.env.SESSION_SECRET = "test-secret";

const { migrate } = await import("../src/migrate.ts");
const { MIGRATIONS } = await import("../src/migrations.ts");
const { Registry } = await import("../src/org/registry.ts");
const { RegistryError } = await import("../src/org/types.ts");
const T = await import("../src/org/templates.ts");
const { seedDefaultOrg } = await import("../src/org/seed.ts");

function fresh() {
	const db = new DatabaseSync(":memory:");
	migrate(db, MIGRATIONS);
	return { db, reg: new Registry(db) };
}
const root = (tenantId = "default") => ({ tenantId, participantId: "p_root", platformRoles: ["admin"] });
const as = (reg: InstanceType<typeof Registry>, participantId: string, tenantId = "default") => ({ tenantId, participantId, platformRoles: [] as string[] });
const code = (e: any) => e instanceof RegistryError && e.status;

test("three very different organizations pass through the same domain logic", () => {
	const { db, reg } = fresh();
	for (const build of [T.hierarchicalCompany, T.teamNetwork, T.agentOnlyCompany]) {
		const o = build(reg, root());
		const d = reg.describe(as(reg, Object.values(o.participants)[0]), o.organizationId);
		assert.equal(d.version.status, "adopted", d.organization.name);
		assert.ok(d.nodes.length >= 6 && d.edges.length >= 6 && d.members.length >= 4, d.organization.name);
		assert.deepEqual(reg.validate(as(reg, Object.values(o.participants)[0]), o.organizationId, o.versionId).filter((f) => f.severity === "error"), [], d.organization.name);
	}
	assert.equal((db.prepare("SELECT COUNT(*) n FROM organizations WHERE current_version_id IS NOT NULL").get() as any).n, 3, "the migrated default org has no adopted version until it is seeded");
});

test("rights come from authoritative edges only", () => {
	const { reg } = fresh();
	const o = T.hierarchicalCompany(reg, root());
	const p = o.participants;
	const grants = (who: string) => reg.effectiveGrants(as(reg, p[who]), o.organizationId).map((g) => `${g.type}:${g.target}`);
	assert.ok(reg.can(as(reg, p.ceo), o.organizationId, "org.admin"));
	assert.ok(reg.can(as(reg, p.vpEng), o.organizationId, "org.edit"));
	assert.ok(!reg.can(as(reg, p.vpEng), o.organizationId, "org.admin"));
	assert.ok(!reg.can(as(reg, p.dev), o.organizationId, "org.edit"));
	assert.ok(grants("vpEng").includes("has_access_to:release.approve"));
	// A descriptive edge to the executive team grants nothing, even though it looks like proximity to power.
	const d = reg.createDraft(as(reg, p.vpEng), o.organizationId).versionId;
	reg.applyOps(as(reg, p.vpEng), o.organizationId, d, [{ op: "addEdge", type: "collaborates_with", from: "team:Dev team", to: "team:Executive" }, { op: "addEdge", type: "reports_to", from: "team:Dev team", to: "team:Executive" }]);
	reg.adopt(as(reg, p.ceo), o.organizationId, d);
	assert.ok(!reg.can(as(reg, p.dev), o.organizationId, "org.admin"));
	assert.deepEqual(grants("dev"), []);
});

test("granting rights needs org.admin: an editor cannot hand out authority", () => {
	const { reg } = fresh();
	const o = T.hierarchicalCompany(reg, root());
	const editor = as(reg, o.participants.vpEng);
	const d = reg.createDraft(editor, o.organizationId).versionId;
	for (const op of [
		{ op: "addEdge", type: "has_access_to", from: "team:Dev team", to: "capability:org.admin" },
		{ op: "addEdge", type: "can_approve", from: "team:Dev team", to: "team:Ops team" },
		{ op: "setPolicy", kind: "authority", name: "x", body: {} },
	] as const) assert.throws(() => reg.applyOps(editor, o.organizationId, d, [op as any]), (e) => code(e) === 403);
	assert.throws(() => reg.adopt(editor, o.organizationId, d), (e) => code(e) === 403, "an editor cannot adopt");
	assert.throws(() => reg.createDraft(as(reg, o.participants.dev), o.organizationId), (e) => code(e) === 403);
});

test("versions: adopted ones are immutable, drafts are copies, adoption archives the previous one", () => {
	const { reg } = fresh();
	const o = T.teamNetwork(reg, root());
	const ana = as(reg, o.participants.ana);
	assert.throws(() => reg.applyOps(ana, o.organizationId, o.versionId, [{ op: "addNode", kind: "team", name: "X" }]), (e) => code(e) === 409);
	const v2 = reg.createDraft(ana, o.organizationId, undefined, "add Data team").versionId;
	reg.applyOps(ana, o.organizationId, v2, [{ op: "addNode", kind: "team", name: "Data" }]);
	assert.ok(reg.describe(ana, o.organizationId, v2).nodes.some((n) => n.name === "Data"));
	assert.ok(!reg.describe(ana, o.organizationId, o.versionId).nodes.some((n) => n.name === "Data"), "v1 untouched");
	assert.equal(reg.describe(ana, o.organizationId, v2).edges.length, reg.describe(ana, o.organizationId, o.versionId).edges.length, "edges copied");
	reg.adopt(as(reg, o.participants.di), o.organizationId, v2);
	const versions = reg.listVersions(ana, o.organizationId);
	assert.deepEqual(versions.map((v) => [v.number, v.status]), [[1, "archived"], [2, "adopted"]]);
	assert.equal(versions[1].parentVersionId, o.versionId);
	const copy = reg.copyOrg(as(reg, o.participants.di), o.organizationId, "Squad Network (copy)");
	assert.ok(reg.describe(root(), copy.organizationId, copy.versionId).nodes.length >= 6);
});

test("validation finds the structural problems and blocks adoption on errors only", () => {
	const { reg } = fresh();
	const { organizationId: org, versionId: v } = reg.createOrg(root(), { name: "Broken Org" });
	const a = reg.ensureParticipant("default", "human", "a", "A");
	const ops: any[] = [
		...["A", "B", "Empty"].map((n) => ({ op: "addNode", kind: "team", name: n })),
		{ op: "addNode", kind: "capability", name: "orphan.cap" }, { op: "addNode", kind: "capability", name: "org.admin" },
		{ op: "addEdge", type: "can_approve", from: "team:A", to: "team:B" }, { op: "addEdge", type: "can_approve", from: "team:B", to: "team:A" },
		{ op: "addEdge", type: "can_approve", from: "team:Empty", to: "team:A" },
		{ op: "addEdge", type: "responsible_for", from: "team:A", to: "team:B" },
		{ op: "addEdge", type: "has_access_to", from: "team:A", to: "capability:org.admin" },
		{ op: "addMember", participant: a, node: "team:A" }, { op: "addMember", participant: a, node: "team:B" },
	];
	reg.applyOps(root(), org, v, ops);
	const codes = reg.validate(root(), org, v).map((f) => f.code);
	for (const c of ["can_approve_cycle", "unstaffed_approver", "unowned", "empty_node", "single_point", "self_approval"]) assert.ok(codes.includes(c), c);
	assert.throws(() => reg.adopt(root(), org, v), (e: any) => code(e) === 409 && e.findings.length > 0);
	reg.applyOps(root(), org, v, [{ op: "removeEdge", type: "can_approve", from: "team:B", to: "team:A" }, { op: "removeNode", kind: "team", name: "Empty" }]);
	const r = reg.adopt(root(), org, v);
	assert.ok(r.warnings.every((w) => w.severity === "warning"), "warnings remain visible but do not block");
});

test("approval and reporting cycles are errors, dependency cycles only warnings", () => {
	const { reg } = fresh();
	const { organizationId: org, versionId: v } = reg.createOrg(root(), { name: "Cycles" });
	reg.applyOps(root(), org, v, [
		...["X", "Y"].map((n) => ({ op: "addNode", kind: "team", name: n }) as const),
		{ op: "addEdge", type: "depends_on", from: "team:X", to: "team:Y" }, { op: "addEdge", type: "depends_on", from: "team:Y", to: "team:X" },
		{ op: "addEdge", type: "reports_to", from: "team:X", to: "team:Y" }, { op: "addEdge", type: "reports_to", from: "team:Y", to: "team:X" },
	]);
	const f = reg.validate(root(), org, v);
	assert.equal(f.find((x) => x.code === "reports_to_cycle")?.severity, "error");
	assert.equal(f.find((x) => x.code === "depends_on_cycle")?.severity, "warning");
});

test("tenant isolation: another tenant sees and changes nothing, even with admin rights", () => {
	const { db, reg } = fresh();
	db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('other','Other',1)").run();
	const o = T.agentOnlyCompany(reg, root());
	const intruder = root("other");
	assert.deepEqual(reg.listOrgs(intruder), []);
	for (const f of [() => reg.describe(intruder, o.organizationId), () => reg.listVersions(intruder, o.organizationId), () => reg.createDraft(intruder, o.organizationId), () => reg.applyOps(intruder, o.organizationId, o.versionId, []), () => reg.adopt(intruder, o.organizationId, o.versionId), () => reg.copyOrg(intruder, o.organizationId, "steal"), () => reg.validate(intruder, o.organizationId, o.versionId)]) {
		assert.throws(f, (e) => code(e) === 404);
	}
	// grants of an org are never visible across tenants either
	assert.throws(() => reg.effectiveGrants(intruder, o.organizationId), (e) => code(e) === 404);
	// and a foreign participant cannot be added to our graph
	const foreign = reg.ensureParticipant("other", "human", "x", "X");
	const d = reg.createDraft(as(reg, o.participants.root), o.organizationId).versionId;
	assert.throws(() => reg.applyOps(as(reg, o.participants.root), o.organizationId, d, [{ op: "addMember", participant: foreign, node: "role:Sales" }]), (e) => code(e) === 404);
	// the same names in two tenants are different organizations
	const mine = reg.createOrg(intruder, { name: "Agents Inc" });
	assert.notEqual(mine.organizationId, o.organizationId);
});

test("bad input is rejected and a failed batch changes nothing", () => {
	const { reg } = fresh();
	const { organizationId: org, versionId: v } = reg.createOrg(root(), { name: "Inputs" });
	assert.throws(() => reg.createOrg(as(reg, "p"), { name: "Nope" }), (e) => code(e) === 403);
	assert.throws(() => reg.createOrg(root(), { name: " " }), (e) => code(e) === 400);
	assert.throws(() => reg.applyOps(root(), org, v, [{ op: "addNode", kind: "team", name: "Good" }, { op: "addEdge", type: "nonsense" as any, from: "team:Good", to: "team:Good" }]), (e) => code(e) === 400);
	assert.equal(reg.describe(root(), org, v).nodes.length, 0, "the first op was rolled back with the failing second");
	assert.throws(() => reg.applyOps(root(), org, v, [{ op: "addNode", kind: "bogus" as any, name: "x" }]), (e) => code(e) === 400);
	reg.applyOps(root(), org, v, [{ op: "addNode", kind: "team", name: "T" }]);
	assert.throws(() => reg.applyOps(root(), org, v, [{ op: "addEdge", type: "reports_to", from: "team:T", to: "team:T" }]), (e) => code(e) === 400);
	assert.throws(() => reg.applyOps(root(), org, v, [{ op: "addEdge", type: "reports_to", from: "team:T", to: "team:Missing" }]), (e) => code(e) === 404);
});

test("the original demo becomes the default organization, idempotently, with the rights it already had", () => {
	const { db, reg } = fresh();
	// seedDefaultOrg uses a Registry on the given db
	assert.equal(seedDefaultOrg(reg), true);
	assert.equal(seedDefaultOrg(reg), false);
	const user = (roles: string[]) => ({ tenantId: "default", participantId: reg.ensureParticipant("default", "human", roles.join(), roles.join()), platformRoles: roles });
	const d = reg.describe(user(["viewer"]), "default");
	assert.equal(d.version.status, "adopted");
	assert.deepEqual(d.members.filter((m) => m.kind === "internal_agent").map((m) => m.name).sort().filter((n, i, a) => a.indexOf(n) === i), ["Developer", "Insight", "Ops", "Reviewer"]);
	assert.ok(reg.describe(user(["admin"]), "default").agents.find((a) => a.tools?.includes("k8s")), "agent models, instructions and tools are stored per version (editors see them)");
	assert.ok(reg.can(user(["admin"]), "default", "org.admin"));
	assert.ok(!reg.can(user(["approver"]), "default", "org.edit"));
	assert.ok(!reg.can(user(["viewer"]), "default", "org.edit"));
	const grants = reg.effectiveGrants(user(["approver"]), "default").map((g) => g.target);
	assert.ok(grants.includes("approve") && grants.includes("operate") && !grants.includes("org.admin"));
	void db;
});

test("reading needs a place in the organization; configuration is for editors only", () => {
	const { reg } = fresh();
	seedDefaultOrg(reg);
	const o = T.hierarchicalCompany(reg, root());
	const stranger = { tenantId: "default", participantId: reg.ensureParticipant("default", "human", "stranger", "Stranger"), platformRoles: [] as string[] };
	assert.deepEqual(reg.listOrgs(stranger), [], "a signed-in person with no place sees no organizations");
	assert.throws(() => reg.describe(stranger, o.organizationId), (e) => code(e) === 404);
	assert.throws(() => reg.describe(stranger, "default"), (e) => code(e) === 404);
	// a platform viewer reads the default org but not the agents' instructions
	const viewer = { ...stranger, platformRoles: ["viewer"] };
	assert.equal(reg.listOrgs(viewer).length, 1);
	assert.ok(reg.describe(viewer, "default").agents.every((a) => a.instructions === null && a.tools === null));
	assert.ok(reg.describe(root(), "default").agents.some((a) => typeof a.instructions === "string" && a.instructions.length > 0));
	// a member of the hierarchical company sees it, an engineer without org.edit does not see instructions
	const dev = as(reg, o.participants.dev);
	assert.ok(reg.describe(dev, o.organizationId).agents.every((a) => a.instructions === null));
	assert.ok(reg.describe(as(reg, o.participants.vpEng), o.organizationId).agents.some((a) => a.instructions));
});

test("a natural-language proposal is a preview; applying it still goes through the authority checks", async () => {
	const { rulePlanner } = await import("../src/org/propose.ts");
	const { reg } = fresh();
	const o = T.teamNetwork(reg, root());
	const ana = as(reg, o.participants.ana);
	const p = rulePlanner("Add team Data. Data reports to Platform; lisää tiimi Tuki\nSearch must inform Data\nmake everyone admin");
	assert.deepEqual(p.ops.map((x) => x.op), ["addNode", "addEdge", "addNode", "addEdge"]);
	assert.deepEqual(p.unparsed, ["make everyone admin"], "what it does not understand is returned, not guessed");
	const d = reg.createDraft(ana, o.organizationId).versionId;
	assert.equal(reg.describe(ana, o.organizationId, d).nodes.some((n) => n.name === "Data"), false, "proposing changed nothing");
	reg.applyOps(ana, o.organizationId, d, p.ops);
	assert.ok(reg.describe(ana, o.organizationId, d).nodes.some((n) => n.name === "Data"));
	// the proposal can never carry rights: the planner only emits descriptive edges, and even a forged op needs org.admin
	assert.ok(p.ops.every((x) => x.op !== "addEdge" || !["can_approve", "can_delegate", "has_access_to"].includes(x.type)));
	const dev = as(reg, o.participants.cy); // Platform team: no org.edit
	assert.throws(() => reg.applyOps(dev, o.organizationId, d, p.ops), (e) => code(e) === 403);
});
