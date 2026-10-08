import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "crew-cli-"));
const env = { ...process.env, DATA_DIR: join(dir, "data"), SESSION_SECRET: "test", CREW_USER: "tester" };
const cli = async (args: string[], e: Record<string, string | undefined> = {}) => {
	try {
		const r = await run(process.execPath, ["src/cli.ts", ...args], { env: { ...env, ...e } });
		return { code: 0, out: r.stdout, err: r.stderr };
	} catch (x: any) {
		return { code: x.code as number, out: x.stdout as string, err: x.stderr as string };
	}
};

const GOOD = `
realm: {name: Test Group}
entities: [{id: test-hq, name: Test HQ}]
organizations:
  - name: Test Ops
    entity: test-hq
    nodes:
      - {kind: capability, name: org.admin}
      - {kind: team, name: Exec}
      - {kind: team, name: Ops}
    edges:
      - {type: has_access_to, from: "team:Exec", to: "capability:org.admin"}
      - {type: reports_to, from: "team:Ops", to: "team:Exec"}
    members:
      - {participant: "human:alice", node: "team:Exec"}
      - {participant: "agent:ops", node: "team:Ops"}
    agents:
      - {participant: "agent:ops", model: "local/x", instructions: "SRE", tools: [k8s]}
`;
const BAD = GOOD.replace('name: Test Ops', 'name: Bad Ops').replace('- {type: reports_to, from: "team:Ops", to: "team:Exec"}', '- {type: can_approve, from: "team:Ops", to: "team:Exec"}\n      - {type: can_approve, from: "team:Exec", to: "team:Ops"}');
const good = join(dir, "good.yaml"), bad = join(dir, "bad.yaml");
writeFileSync(good, GOOD);
writeFileSync(bad, BAD);

test("config is applied through the registry, is idempotent, and dry-run writes nothing", async () => {
	const dry = await cli(["apply", "-f", good, "--dry-run"]);
	assert.match(dry.out, /Test Ops": create \(dry run/);
	assert.doesNotMatch((await cli(["orgs"])).out, /Test Ops/, "dry run created nothing");
	assert.match((await cli(["apply", "-f", good])).out, /Test Ops": create, adopted/);
	assert.match((await cli(["apply", "-f", good])).out, /Test Ops": unchanged/);
	assert.match((await cli(["orgs"])).out, /Test Ops\tadopted/);
	// a changed file produces a new version, not a rewrite of the adopted one
	writeFileSync(good, GOOD.replace("{kind: team, name: Ops}", "{kind: team, name: Ops}\n      - {kind: team, name: Data}"));
	assert.match((await cli(["apply", "-f", good])).out, /update, adopted/);
});

test("export produces a file that apply accepts as 'unchanged' (round trip)", async () => {
	const out = join(dir, "export.yaml");
	assert.equal((await cli(["export", "Test Ops", "-o", out])).code, 0);
	assert.match((await cli(["apply", "-f", out])).out, /Test Ops": unchanged/);
	const json = await cli(["export", "Test Ops", "--format", "json"]);
	assert.equal(JSON.parse(json.out).organizations[0].name, "Test Ops");
});

test("a config with structural errors is refused, explained, and nothing is adopted", async () => {
	const r = await cli(["apply", "-f", bad]);
	assert.equal(r.code, 1);
	assert.match(r.err, /approval cycle/);
	assert.doesNotMatch((await cli(["orgs"])).out, /Bad Ops\tadopted/);
	writeFileSync(join(dir, "typo.yaml"), "organisations: []\n");
	const t = await cli(["apply", "-f", join(dir, "typo.yaml")]);
	assert.equal(t.code, 1);
	assert.match(t.err, /unknown top-level key "organisations"/);
	assert.equal((await cli(["apply", "-f", join(dir, "nope.yaml")])).code, 1);
});

test("create-realm is idempotent and recorded in the audit trail", async () => {
	assert.match((await cli(["--create-realm", "Acme Group", "--entity", "Acme HQ"])).out, /realm acme-group ready, entity acme-hq/);
	assert.equal((await cli(["create-realm", "Acme Group", "--entity", "Acme HQ"])).code, 0);
	const log = JSON.parse((await cli(["replay", "--kind", "audit", "--json"])).out);
	assert.ok(log.some((e: any) => e.text.startsWith("realm.create")), "audit has the realm creation");
	assert.ok(log.some((e: any) => e.actor === "cli:tester" && e.text.startsWith("config.apply")));
});

let server: ChildProcess;
after(() => server?.kill());

test("send goes through the server as a real login, and replay reads it back without re-running anything", async () => {
	const PORT = 18140, base = `http://127.0.0.1:${PORT}`;
	const data = join(dir, "e2e");
	server = spawn(process.execPath, ["src/server.ts"], { env: { ...process.env, PORT: String(PORT), PUBLIC_URL: base, AUTH_MODE: "dev", DEMO_MODE: "true", DATA_DIR: data }, stdio: "ignore" });
	for (let i = 0; i < 60 && !(await fetch(`${base}/healthz`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 200));
	const before = Date.now();
	const sent = await cli(["send", "general", "hello from the cli", "--as", "bob", "--url", base], { DATA_DIR: data });
	assert.equal(sent.code, 0, sent.err);
	assert.match(sent.out, /sent to #general as bob; dispatched to: nobody/);
	const withAgent = await cli(["--send", "#production", "-m", "@ops check pods please", "--as", "bob", "--url", base, "--wait", "20"], { DATA_DIR: data });
	assert.match(withAgent.out, /dispatched to: ops/);
	assert.match(withAgent.out, /Ops:/, "--wait prints the agent's answer");
	const nobody = await cli(["send", "general", "x", "--as", "mallory", "--url", base], { DATA_DIR: data });
	assert.equal(nobody.code, 1);
	assert.match(nobody.err, /login as "mallory" failed/);
	const viewer = await cli(["send", "general", "x", "--as", "carol", "--url", base], { DATA_DIR: data });
	assert.match(viewer.err, /403/, "the same permission checks as the UI: carol is a viewer");

	const log = JSON.parse((await cli(["replay", "--channel", "general", "--start", new Date(before - 1000).toISOString(), "--json"], { DATA_DIR: data })).out);
	assert.ok(log.some((e: any) => e.text === "hello from the cli" && e.actor.startsWith("Bob")));
	const none = JSON.parse((await cli(["replay", "--start", "2020-01-01", "--end", "2020-01-02", "--json"], { DATA_DIR: data })).out);
	assert.deepEqual(none, [], "a range with no events is empty");
	const again = (await cli(["replay", "--channel", "general", "--json"], { DATA_DIR: data })).out;
	assert.equal(again, (await cli(["replay", "--channel", "general", "--json"], { DATA_DIR: data })).out, "reading history twice changes nothing");
});

test("history hides private chats unless asked, and rejects times it cannot read", async () => {
	process.env.DATA_DIR = join(dir, "hist");
	process.env.SESSION_SECRET = "t";
	const { store, db } = await import("../src/db.ts");
	await import("../src/channels.ts");
	const { history, parseWhen } = await import("../src/cli/history.ts");
	db.prepare("INSERT INTO channels (id, name, topic, kind, agents, created_by, created_at, owner) VALUES ('dm-x','X','','dm','[]','t',1,'u1')").run();
	store.addMessage({ channelId: "dm-x", authorKind: "human", authorId: "u1", authorName: "U", text: "private words" });
	store.addMessage({ channelId: "general", authorKind: "human", authorId: "u1", authorName: "U", text: "public words" });
	assert.deepEqual(history({}).filter((e) => e.kind === "message").map((e) => e.text), ["public words"]);
	assert.equal(history({ includeDm: true }).filter((e) => e.kind === "message").length, 2);
	assert.ok(Math.abs(parseWhen("-2h", 10_000_000) - (10_000_000 - 7_200_000)) === 0);
	assert.throws(() => parseWhen("yesterday-ish"), /cannot read/);
});

test("handoffs, case and events can be read from the terminal (E1: nothing is UI-only)", async () => {
	const data = join(dir, "work");
	const e2 = { DATA_DIR: data };
	// write a small history through the same services the server uses
	const script = `
		const { handoffs, cases, bus } = await import("./src/work/index.ts");
		const { db } = await import("./src/db.ts");
		db.exec("CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, kind TEXT NOT NULL)");
		const h = handoffs.request({ requestId: "ask:x1", channelId: "incidents", from: "ops", to: "developer", text: "fix the pool size", correlationId: "corr-cli" }).handoff;
		handoffs.accept(h.handoffId, "runtime");
		cases.addFact({ caseId: "incidents", key: "checkout.pool_size", statement: "POOL_SIZE is 0", sourceRefs: ["tool:k8s_configmap"], confidence: "confirmed", by: "ops" });
		cases.addFact({ caseId: "incidents", key: "delivery.date", statement: "10 Oct", sourceRefs: ["message:1"], confidence: "reported", by: "sales" });
		cases.addFact({ caseId: "incidents", key: "delivery.date", statement: "14 Oct", sourceRefs: ["message:2"], confidence: "reported", by: "production" });`;
	await run(process.execPath, ["--input-type=module", "-e", script], { env: { ...env, ...e2 } });
	const hs = await cli(["handoffs", "--channel", "#incidents"], e2);
	assert.match(hs.out, /#incidents\s+ops -> developer\s+accepted\s+fix the pool size/);
	assert.equal(JSON.parse((await cli(["handoffs", "--status", "completed", "--json"], e2)).out).length, 0);
	const c = await cli(["case", "incidents"], e2);
	assert.match(c.out, /responsible: developer/);
	assert.match(c.out, /waiting: ops -> developer\s+accepted/);
	assert.match(c.out, /CONFLICT delivery.date: "10 Oct" \(sales\)\s+vs\s+"14 Oct" \(production\)/);
	assert.match(c.out, /fact \[confirmed\] checkout.pool_size: POOL_SIZE is 0\s+<- tool:k8s_configmap/);
	const ev = await cli(["events", "--correlation", "corr-cli", "--json"], e2);
	assert.deepEqual(JSON.parse(ev.out).map((e: any) => e.type), ["handoff.requested", "handoff.accepted"]);
	assert.equal((await cli(["case"], e2)).code, 1);
});
