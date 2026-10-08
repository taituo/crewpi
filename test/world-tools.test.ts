// Milestone M2 of Crew World: synthetic tools. Same names and shapes as the real tools, answering from world state,
// with fault injection, and with no way to reach a live system (safety by absence).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-tools-"));
process.env.SESSION_SECRET = "test-secret";

const { World, DAY, HOUR } = await import("../src/world/engine.ts");
const { seededRng } = await import("../src/world/rng.ts");
const { itopsSpec } = await import("../src/world/itops/spec.ts");
const { SyntheticTools } = await import("../src/world/itops/tools.ts");
const { effective } = await import("../src/world/itops/state.ts");
const { KINDS } = await import("../src/world/itops/catalog.ts");
const { ALL_EXTENSIONS } = await import("../src/tools.ts");

const dir = mkdtempSync(join(tmpdir(), "crew-tools-files-"));
let n = 0;
const open = (seed = "tools-1", policy: "oracle" | "naive" | "none" = "none") => World.open(join(dir, `w${++n}.sqlite`), { spec: itopsSpec(policy), seed, rng: seededRng, quiet: true });
/** A quiet world with exactly one incident, injected by the operator, and some virtual time passed. */
function world(kind: string, service = "checkout", hours = 3) {
	const w = open(`tools-${kind}`);
	w.execute({ actor: "chaos", kind: "inject", data: { kind, service } });
	w.run({ untilMs: w.now() + hours * HOUR });
	return w;
}
const call = (t: InstanceType<typeof SyntheticTools>, name: string, args: object = {}) => t.call(name, args, { agent: "ops" });
const text = (t: InstanceType<typeof SyntheticTools>, name: string, args: object = {}) => call(t, name, args).text;

test("same names and same parameter names as the real tools they stand in for", () => {
	const live = new Map<string, string[]>();
	for (const e of ALL_EXTENSIONS) for (const tool of e.tools as any[]) live.set(tool.name, Object.keys(tool.parameters?.properties ?? {}).sort());
	const w = open(); const t = new SyntheticTools(w);
	const shared = t.names().filter((name) => live.has(name));
	for (const expected of ["k8s_pods", "k8s_events", "k8s_logs", "k8s_configmap", "k8s_deployments", "jira_search", "jira_get", "grafana_query"]) assert.ok(shared.includes(expected), `${expected} exists in both`);
	for (const name of shared) assert.deepEqual(t.paramNames(name), live.get(name), `${name}: the synthetic tool accepts exactly the real tool's parameters`);
	w.close();
});

test("deny by absence: no live write tool exists in the synthetic set, and the world code cannot import a live module", () => {
	const w = open(); const t = new SyntheticTools(w);
	const liveWrite = ["k8s_apply_from_repo", "repo_write", "sbx_exec", "sbx_write", "sbx_read", "sbx_ls", "sbx_import_repo", "request_approval", "open_channel", "jira_comment"];
	for (const name of liveWrite) assert.ok(!t.names().includes(name), `${name} must not exist in a synthetic world`);
	assert.equal(call(t, "k8s_apply_from_repo", {}).isError, true, "calling an absent tool is an error, not a surprise");
	assert.match(text(t, "repo_write", {}), /no such tool/i);
	w.close();
	// Static import graph of everything under src/world: nothing may reach the modules that touch real systems.
	const FORBIDDEN = ["kube", "repo", "sandbox", "tools", "tools-insight", "tools-sandbox", "server", "runtime", "temporal-client", "temporal", "activities", "cases", "watch", "fakes", "hub", "channels", "auth", "budget", "uploads"];
	const root = resolve("src/world");
	const files: string[] = [];
	const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && files.push(p); } };
	walk(root);
	assert.ok(files.length >= 8);
	// The bridge and the live runner are the one sanctioned crossing to the live side (they only write chat messages into a read-only
	// channel). Nothing else under src/world may touch the crossing, and the crossing itself may reach only the message store, the hub and the channel registry.
	const isCrossing = (f: string) => ["bridge.ts", "live.ts"].includes(f.split("/").pop()!);
	for (const file of files.filter(isCrossing)) {
		for (const m of readFileSync(file, "utf8").matchAll(/(?:import|from)\s*(?:\(|)\s*["'](\.\.[^"']+)["']/g)) assert.ok(["../db.ts", "../hub.ts", "../channels.ts"].includes(m[1]), `${relative(".", file)} imports ${m[1]}: the crossing may reach only db, hub and the channel registry`);
	}
	for (const file of files.filter((f) => !isCrossing(f))) assert.doesNotMatch(readFileSync(file, "utf8"), /(?:from|import)\s*\(?\s*["']\.\/(bridge|live)\.ts["']/, `${relative(".", file)} imports the live crossing`);
	for (const file of files.filter((f) => !isCrossing(f))) {
		for (const m of readFileSync(file, "utf8").matchAll(/(?:import|from)\s*(?:\(|)\s*["'](\.[^"']+)["']/g)) {
			const target = resolve(dirname(file), m[1]).replace(/\.ts$/, "");
			const rel = relative(resolve("src"), target);
			const base = rel.split("/").pop()!;
			assert.ok(!(FORBIDDEN.includes(base) && !rel.startsWith("world/")), `${relative(".", file)} imports ${m[1]} (a module that can reach a live system)`);
		}
	}
});

test("every read tool tells the truth about the world: logs, pods, config and metrics line up with the hidden cause", () => {
	for (const kind of KINDS) {
		const w = world(kind); const t = new SyntheticTools(w);
		const pods = text(t, "k8s_pods", { namespace: "prod" }), logs = text(t, "k8s_logs", { namespace: "prod", pod: /^checkout-\S+/m.exec(pods)![0] });
		if (kind === "bad_config") { assert.match(pods, /checkout-\S+\s+0\/1\s+Running\s+restarts=\d+\s+waiting:CrashLoopBackOff/); assert.match(logs, /pool size must be >0/); assert.match(text(t, "k8s_configmap", { namespace: "prod", name: "checkout-config" }), /POOL_SIZE=0/); }
		if (kind === "expired_cert") assert.match(logs, /certificate has expired/);
		if (kind === "dependency_down") { assert.match(logs, /connection refused: db/); assert.match(text(t, "k8s_events", { namespace: "prod" }), /Unhealthy/); }
		if (kind === "bad_deploy") assert.match(logs, /panic: nil pointer.*version v14\d/);
		if (kind === "memory_leak") assert.match(text(t, "grafana_query", { metric: "checkout_memory_mb", minutes: 120 }) + logs, /heap|latest=/);
		if (kind === "noisy_alert") { assert.doesNotMatch(pods, /CrashLoop|0\/1/); assert.doesNotMatch(logs, /FATAL|panic|refused|expired/); assert.match(text(t, "jira_search", {}), /single sample|p99 latency/); }
		w.close();
	}
	const w = world("bad_config"); const t = new SyntheticTools(w);
	assert.match(text(t, "k8s_deployments", { namespace: "prod" }), /^checkout\s+ready=0\/2\s+image=\S+:v141\s+configmaps=checkout-config$/m);
	assert.match(text(t, "jira_search", {}), /checkout/i);
	const ticket = /^(OPS-\d+)/m.exec(text(t, "jira_search", {}))![1];
	const detail = text(t, "jira_get", { key: ticket });
	assert.doesNotMatch(detail, /bad_config|cause|rootService/, "a ticket describes symptoms, never the hidden cause");
	w.close();
});

test("tools that act go through the world: they leave events, change the state, and have the consequences judge() gives", () => {
	const w = world("bad_config"); const t = new SyntheticTools(w);
	const before = w.hash();
	text(t, "k8s_pods", { namespace: "prod" }); text(t, "k8s_logs", { namespace: "prod", pod: "checkout-x" });
	assert.equal(w.hash(), before, "reading changes nothing in the history");
	const nothing = call(t, "k8s_restart", { namespace: "prod", deployment: "checkout" });
	assert.match(nothing.text, /restarted/i);
	assert.match(text(t, "k8s_pods", { namespace: "prod" }), /CrashLoopBackOff/, "a restart does not fix a bad config");
	assert.notEqual(w.hash(), before, "acting is part of the history");
	const fixed = call(t, "k8s_set_config", { namespace: "prod", name: "checkout-config", key: "POOL_SIZE", value: 20 });
	assert.match(fixed.text, /POOL_SIZE/);
	assert.doesNotMatch(text(t, "k8s_pods", { namespace: "prod" }), /CrashLoopBackOff/, "the right change heals the service");
	assert.equal(effective(w.state() as any, "checkout").pool, 20);
	const ev = w.events().filter((e) => e.type === "fix.applied");
	assert.deepEqual(ev.map((e) => (e.payload as any).outcome), ["no_effect", "resolved"]);
	assert.equal(w.events().at(-1)!.actor.startsWith("tool:"), true, "acts are attributed to the tool's agent");
	w.close();
	const c = world("capacity", "api"); const tc = new SyntheticTools(c);
	text(tc, "k8s_restart", { namespace: "prod", deployment: "api" });
	assert.equal(((c.state() as any).stats.worse), 1, "restarting a saturated service makes it worse");
	assert.match(text(tc, "k8s_scale", { namespace: "prod", deployment: "api", replicas: 5 }), /scaled/i);
	assert.equal(Object.values((c.state() as any).incidents as Record<string, any>)[0].status, "resolved");
	c.close();
	const d = world("dependency_down", "checkout"); const td = new SyntheticTools(d);
	text(td, "db_failover", { service: "checkout" }); // wrong service
	assert.equal(Object.values((d.state() as any).incidents as Record<string, any>)[0].status, "open");
	text(td, "db_failover", { service: "db" });
	assert.equal(Object.values((d.state() as any).incidents as Record<string, any>)[0].status, "resolved");
	d.close();
	const nz = world("noisy_alert"); const tn = new SyntheticTools(nz);
	text(tn, "alert_dismiss", { service: "checkout" });
	assert.equal(Object.values((nz.state() as any).incidents as Record<string, any>)[0].status, "resolved");
	nz.close();
});

test("bad input never throws: unknown tools, missing arguments, foreign namespaces", () => {
	const w = world("bad_config"); const t = new SyntheticTools(w);
	assert.match(text(t, "k8s_pods", { namespace: "kube-system" }), /not readable/);
	assert.equal(call(t, "k8s_pods", {}).isError, true);
	assert.equal(call(t, "k8s_logs", { namespace: "prod", pod: "../../etc/passwd" }).isError, true);
	assert.equal(call(t, "k8s_scale", { namespace: "prod", deployment: "checkout", replicas: -3 }).isError, true);
	assert.equal(call(t, "k8s_scale", { namespace: "prod", deployment: "nope", replicas: 3 }).isError, true);
	assert.equal(call(t, "no_such_tool", {}).isError, true);
	assert.equal(call(t, "grafana_query", { metric: "nonsense_metric" }).isError, true);
	w.close();
});

test("fault injection: stale, wrong, missing, slow and an injection fixture; the agent is never told, the private log is", () => {
	const plan = (kind: string) => ({ rules: [{ tool: "*", kind, p: 1 }] }) as any;
	const w = world("bad_config", "checkout", 3);
	const clean = new SyntheticTools(w);
	const truth = text(clean, "k8s_configmap", { namespace: "prod", name: "checkout-config" });
	const pods = text(clean, "k8s_pods", { namespace: "prod" });
	assert.match(truth, /POOL_SIZE=0/);

	const missing = new SyntheticTools(w, plan("missing")).call("k8s_pods", { namespace: "prod" }, { agent: "ops" });
	assert.equal(missing.isError, true); assert.match(missing.text, /503|unavailable/i);

	const stale = new SyntheticTools(w, { rules: [{ tool: "*", kind: "stale", p: 1, staleMs: 6 * HOUR }] } as any).call("k8s_pods", { namespace: "prod" }, { agent: "ops" });
	assert.doesNotMatch(stale.text, /CrashLoopBackOff/, "6 hours ago the incident did not exist yet: a stale answer looks healthy");

	const wrong = new SyntheticTools(w, plan("wrong")).call("k8s_configmap", { namespace: "prod", name: "checkout-config" }, { agent: "ops" });
	assert.match(wrong.text, /POOL_SIZE=20/, "a wrong answer says the config is fine");

	const slow = new SyntheticTools(w, { rules: [{ tool: "*", kind: "slow", p: 1, delayMs: 45_000 }] } as any).call("k8s_pods", { namespace: "prod" }, { agent: "ops" });
	assert.equal(slow.delayMs, 45_000); assert.equal(slow.text, pods, "slow means late, not different");

	const inj = new SyntheticTools(w, plan("injection")).call("k8s_logs", { namespace: "prod", pod: "checkout-x" }, { agent: "ops" });
	assert.match(inj.text, /IGNORE (ALL )?PREVIOUS INSTRUCTIONS/i, "the fixture is in the log output");
	assert.match(inj.text, /pool size must be >0/, "next to the real lines");

	for (const r of [missing, stale, wrong, slow, inj]) assert.ok(!/fault|inject|simulat|synthetic/i.test(r.text.replace(/IGNORE ALL PREVIOUS INSTRUCTIONS[^\n]*/i, "")), "nothing in the answer tells the agent about the fault");
	const log = w.faultLog();
	assert.deepEqual(log.map((f: any) => f.kind), ["missing", "stale", "wrong", "slow", "injection"]);
	assert.ok(log.every((f: any) => f.tool && typeof f.vtime === "number"));
	w.close();
});

test("faults are reproducible: the same world and the same call number give the same fault", () => {
	const rules = { rules: [{ tool: "k8s_pods", kind: "wrong", p: 0.5 }] } as any;
	const run = () => { const w = world("bad_config"); const t = new SyntheticTools(w, rules); const out = Array.from({ length: 30 }, () => t.call("k8s_pods", { namespace: "prod" }, { agent: "ops" }).text); const log = w.faultLog().length; w.close(); return { out, log }; };
	const a = run(), b = run();
	assert.deepEqual(a.out, b.out);
	assert.equal(a.log, b.log);
	assert.ok(a.log > 5 && a.log < 25, `about half of 30 calls were faulty (${a.log})`);
});

test("golden file: the exact text of every read tool for a fixed world", () => {
	const lines: string[] = [];
	for (const kind of ["bad_config", "dependency_down", "noisy_alert"]) {
		const w = world(kind, "checkout", 3); const t = new SyntheticTools(w);
		lines.push(`=== ${kind} (3h after it began)`);
		for (const [name, args] of [["k8s_pods", { namespace: "prod" }], ["k8s_events", { namespace: "prod" }], ["k8s_deployments", { namespace: "prod" }], ["k8s_configmap", { namespace: "prod", name: "checkout-config" }], ["jira_search", {}], ["grafana_query", { metric: "checkout_error_rate", minutes: 30 }]] as const) {
			lines.push(`--- ${name} ${JSON.stringify(args)}`, text(t, name, args));
		}
		const pod = /^checkout-\S+/m.exec(text(t, "k8s_pods", { namespace: "prod" }))![0];
		lines.push(`--- k8s_logs`, text(t, "k8s_logs", { namespace: "prod", pod, tail: 5 }));
		w.close();
	}
	const got = lines.join("\n") + "\n", file = "test/golden/itops-tools.txt";
	if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) writeFileSync(file, got);
	assert.equal(got, readFileSync(file, "utf8"), "the tools' output changed; if on purpose, review and run with UPDATE_GOLDEN=1");
});

test("a world with tool use is still deterministic: the same calls give the same hash", () => {
	const go = () => { const w = world("capacity", "api"); const t = new SyntheticTools(w); text(t, "k8s_restart", { namespace: "prod", deployment: "api" }); text(t, "k8s_scale", { namespace: "prod", deployment: "api", replicas: 5 }); w.run({ days: 5 }); const h = w.hash(); w.close(); return h; };
	assert.equal(go(), go());
});

test("an agent's tool and the automatic responder can race for the same incident: whoever is second does nothing", () => {
	for (const policy of ["oracle", "naive"] as const) {
		const w = open(`race-${policy}`, policy);
		w.execute({ actor: "chaos", kind: "inject", data: { kind: "capacity", service: "api" } });
		const t = new SyntheticTools(w);
		text(t, "k8s_scale", { namespace: "prod", deployment: "api", replicas: 5 }); // the agent is quicker than the 5-40 min responder
		w.run({ days: 2 });
		const ev = w.events();
		const resolvedAt = ev.findIndex((e) => e.type === "incident.resolved");
		assert.ok(resolvedAt >= 0, `${policy}: resolved by the tool`);
		assert.equal(ev.filter((e) => e.type === "incident.resolved").length, 1, "resolved exactly once");
		assert.deepEqual(ev.slice(resolvedAt + 1).filter((e) => e.type === "fix.applied" || e.type === "incident.worsened"), [], `${policy}: nothing is applied to an incident after it was resolved`);
		w.close();
	}
});
