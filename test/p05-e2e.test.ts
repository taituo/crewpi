// The whole chain on a real server with the scripted demo agents: a person asks Ops, Ops hands work to Developer,
// who hands to Reviewer, who hands back; every step is a handoff with events; an approval carries who started the chain.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 18141, base = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
after(() => server?.kill());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function session(as: string) {
	const res = await fetch(`${base}/auth/login?as=${as}`, { redirect: "manual" });
	const cookie = (res.headers.getSetCookie()[0] ?? "").split(";")[0];
	const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { cookie, "content-type": "application/json", "x-requested-with": "crew" } });
	return { get: async (p: string) => (await call(p)).json() as Promise<any>, post: (p: string, body: object = {}) => call(p, { method: "POST", body: JSON.stringify(body) }) };
}

test("a request travels as handoffs, leaves events, and separation of duties holds on the approval", { timeout: 240_000 }, async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "crew-p05-"));
	server = spawn(process.execPath, ["src/server.ts"], { env: { ...process.env, PORT: String(PORT), PUBLIC_URL: base, AUTH_MODE: "dev", DEMO_MODE: "true", DATA_DIR: dataDir }, stdio: "ignore" });
	for (let i = 0; i < 80 && !(await fetch(`${base}/healthz`).then((r) => r.ok, () => false)); i++) await sleep(200);
	const alice = await session("alice"), root = await session("root"), carol = await session("carol"), bob = await session("bob");

	const sent = await alice.post("/api/channels/incidents/messages", { text: "@ops tutki miksi checkout-api on kaatunut" });
	assert.equal(sent.status, 200);

	// the chain: ops -> developer -> reviewer -> ops, each its own handoff, all finished, all by the same person's request
	let list: any[] = [];
	for (let i = 0; i < 120; i++) {
		list = (await alice.get("/api/handoffs?channel=incidents")).handoffs;
		if (list.length >= 3 && list.every((h) => h.status === "completed")) break;
		await sleep(500);
	}
	const chain = [...list].sort((a, b) => a.depth - b.depth);
	assert.deepEqual(chain.map((h) => `${h.from}>${h.to}`), ["ops>developer", "developer>reviewer", "reviewer>ops"]);
	assert.deepEqual(chain.map((h) => h.status), ["completed", "completed", "completed"]);
	assert.deepEqual(chain.map((h) => h.depth), [1, 2, 3]);
	assert.ok(chain.every((h) => h.originSub === "dev-alice" && h.correlationId === chain[0].correlationId), "one correlation id and the starter is carried down the chain");
	assert.ok(chain.every((h) => h.ackEventId), "every step was acknowledged by an event");

	// the events say the same, in order, and are readable by a viewer of the channel
	const ev = (await carol.get(`/api/domain-events?channel=incidents&correlation=${chain[0].correlationId}`)).events as any[];
	const types = ev.map((e) => e.type);
	for (const t of ["handoff.requested", "handoff.accepted", "handoff.completed"]) assert.ok(types.includes(t), t);
	assert.ok(ev.every((e) => e.correlationId === chain[0].correlationId && e.visibility === "channel:incidents"));
	assert.equal(ev.filter((e) => e.type === "handoff.requested").length, 3);

	// the shared picture shows nobody is waiting any more, and is not readable for a channel one cannot see
	const c = await carol.get("/api/channels/incidents/case");
	assert.deepEqual(c.awaiting, []);
	assert.equal((await carol.post("/api/handoffs/does-not-exist/cancel")).status, 403, "a viewer cannot cancel handoffs");
	assert.equal((await bob.post("/api/handoffs/does-not-exist/cancel")).status, 404);

	// The scripted demo cannot reach a real approval without a Kubernetes cluster (k8s_apply_from_repo needs one before it
	// asks), so the approval row is written the way gate() writes it: requested_by_sub = who started the chain Ops is on.
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(join(dataDir, "workspace.sqlite"));
	const origin = db.prepare("SELECT origin_sub o, depth d FROM conv_origin WHERE channel_id = 'incidents' AND agent_id = 'ops'").get() as any;
	assert.equal(origin.o, "dev-alice", "Ops is working on a chain that alice started");
	db.prepare("INSERT INTO approvals (channel_id, agent_id, task_id, title, detail, created_at, requested_by_sub) VALUES (?,?,?,?,?,?,?)").run("incidents", "ops", "t-sod", "Apply demo-apps/checkout-config", JSON.stringify({ action: "apply configmap", target: "demo-apps/checkout-config" }), Date.now(), origin.o);
	db.close();
	const pending = (await alice.get("/api/approvals?status=pending")).approvals[0];
	assert.equal(pending.requestedBySub, "dev-alice");
	const own = await alice.post(`/api/approvals/${pending.id}/decide`, { decision: "approve" });
	assert.equal(own.status, 403);
	assert.match((await own.json()).error, /separation of duties/);
	assert.equal((await bob.post(`/api/approvals/${pending.id}/decide`, { decision: "approve" })).status, 403, "an operator is not an approver");
	assert.equal((await alice.get("/api/approvals?status=pending")).approvals.length, 1, "the refused attempts decided nothing");
	const decided = await root.post(`/api/approvals/${pending.id}/decide`, { decision: "approve", note: "ok" });
	assert.equal(decided.status, 200);

	// the decision is part of the case, with its authority
	const after = await carol.get("/api/channels/incidents/case");
	assert.equal(after.decisions.all.length, 1);
	assert.equal(after.decisions.all[0].outcome, "approved");
	assert.equal(after.decisions.all[0].madeBy, "dev-root");
	assert.match(after.decisions.all[0].authorityRef, /admin/);
	assert.equal(after.decisions.all[0].approvalId, pending.id);
});
