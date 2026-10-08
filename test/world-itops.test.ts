// Milestone M1 of Crew World: the IT-operations domain. A world is only worth watching if its problems are causal:
// every problem has a hidden cause, visible symptoms, a right fix, and wrong fixes that do not help or make it worse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-itops-"));
process.env.SESSION_SECRET = "test-secret";

const { World, DAY } = await import("../src/world/engine.ts");
const { seededRng } = await import("../src/world/rng.ts");
const { itopsSpec } = await import("../src/world/itops/spec.ts");
const { KINDS, SERVICES, rightFix, judge } = await import("../src/world/itops/catalog.ts");
const { symptoms } = await import("../src/world/itops/symptoms.ts");
const { effective, impactMinutes } = await import("../src/world/itops/state.ts");

const dir = mkdtempSync(join(tmpdir(), "crew-itops-files-"));
let n = 0;
const make = (policy: "oracle" | "naive" | "none", seed = "ops-1") => World.open(join(dir, `w${++n}.sqlite`), { spec: itopsSpec(policy), seed, rng: seededRng });
const ACTIONS = ["restart", "scale", "rollback", "set_config", "rotate_cert", "failover", "dismiss"] as const;
const cause = (kind: string, service = "checkout") => ({ kind, service, rootService: kind === "dependency_down" ? "db" : undefined, neededReplicas: 4, badVersion: "v142", goodVersion: "v141", defaultPool: 20, leakMbPerHour: 40 }) as any;

test("every kind has one right fix, and only the right fix resolves it", () => {
	assert.equal(KINDS.length, 7);
	for (const kind of KINDS) {
		const c = cause(kind);
		const right = rightFix(c);
		assert.equal(judge(c, right).outcome, "resolved", `${kind}: the right fix resolves`);
		// every other generic action on the same service is not a resolution
		for (const type of ACTIONS) {
			if (type === right.type) continue;
			const wrong = judge(c, { type, service: c.service, replicas: 6, key: "pool", value: 20 } as any);
			assert.notEqual(wrong.outcome, "resolved", `${kind} must not be resolved by ${type}`);
		}
	}
});

test("wrong fixes have consequences: some do nothing, some help a little, some make it worse", () => {
	const o = (kind: string, type: string, extra: object = {}) => judge(cause(kind), { type, service: cause(kind).service, ...extra } as any).outcome;
	assert.equal(o("memory_leak", "restart"), "partial", "a restart only buys time against a leak");
	assert.equal(o("capacity", "scale", { replicas: 2 }), "partial", "too little scaling helps a little");
	assert.equal(o("capacity", "scale", { replicas: 4 }), "resolved");
	assert.equal(o("capacity", "restart"), "worse", "restarting a saturated service drops its warm connections");
	assert.equal(o("bad_config", "restart"), "no_effect", "it crashes again for the same reason");
	assert.equal(judge(cause("dependency_down"), { type: "scale", service: "checkout", replicas: 8 }).outcome, "worse", "more clients make a failing database worse");
	assert.equal(judge(cause("dependency_down"), { type: "failover", service: "checkout" }).outcome, "no_effect", "failing over the wrong service");
	assert.equal(judge(cause("dependency_down"), { type: "failover", service: "db" }).outcome, "resolved");
	for (const type of ["restart", "scale", "rollback", "rotate_cert"]) assert.equal(o("noisy_alert", type), "worse", `acting on a false alarm (${type}) causes the outage it feared`);
	assert.equal(o("noisy_alert", "dismiss"), "resolved");
});

test("symptoms tell the kinds apart, and a false alarm looks healthy", () => {
	const state: any = { services: Object.fromEntries(SERVICES.map((s) => [s, { version: "v141", replicas: 2, baseReplicas: 2, pool: 20, certValid: true, up: true }])), incidents: {}, nextId: 1, stats: {} };
	const sig = new Map<string, string>();
	for (const kind of KINDS) {
		const inc = { id: `inc-${kind}`, kind, service: "checkout", severity: 2, openedAt: 0, status: "open", cause: cause(kind), attempts: 0, worse: 0 };
		const s = symptoms(state, inc as any, 3 * 3600_000);
		sig.set(kind, s.logs.join("|"));
		assert.ok(s.metrics.latencyMs >= 0 && s.metrics.errorRate >= 0 && s.metrics.errorRate <= 1);
		if (kind === "noisy_alert") { assert.ok(s.metrics.errorRate < 0.01 && s.metrics.cpu < 0.7 && s.alerts.length > 0, "an alert with healthy metrics"); }
		else assert.ok(s.metrics.errorRate > 0.03 || s.metrics.cpu > 0.9 || s.metrics.restarts > 3 || s.metrics.memMb > 900, `${kind} shows at least one bad number`);
	}
	assert.equal(new Set([...sig.values()].filter(Boolean)).size, KINDS.length - 1, "each real problem has its own log signature");
	assert.match(sig.get("bad_config")!, /pool size must be >0/);
	assert.match(sig.get("expired_cert")!, /certificate has expired/);
	assert.match(sig.get("dependency_down")!, /connection refused.*db/);
});

test("the oracle responder resolves every kind of problem, and the world ends healthy", () => {
	const w = make("oracle"); w.run({ days: 365 });
	const s = w.state() as any;
	const all = Object.values(s.incidents) as any[];
	assert.ok(all.length > 150, `a year produces many incidents (${all.length})`);
	const closed = all.filter((i) => i.openedAt < 364 * DAY);
	assert.ok(closed.every((i) => i.status === "resolved"), "everything but the last day's incidents is resolved");
	for (const kind of KINDS) assert.ok(all.some((i) => i.kind === kind && i.status === "resolved"), `${kind} was met and resolved`);
	// the world does not lie: with nothing open, every service is in its normal state
	if (!all.some((i) => i.status === "open")) {
		for (const id of SERVICES) { const e = effective(s, id); assert.deepEqual([e.pool, e.certValid, e.up, e.version], [20, true, true, "v141"], `${id}: with nothing open the service is normal`); }
	}
	// and while something is open, the state shows it (the world cannot lie in either direction)
	const w2 = make("none"); w2.run({ days: 20 });
	const s2 = w2.state() as any;
	for (const i of Object.values(s2.incidents) as any[]) {
		const e = effective(s2, i.service);
		if (i.kind === "bad_config") assert.equal(e.pool, 0, "an open bad_config shows as pool 0");
		if (i.kind === "expired_cert") assert.equal(e.certValid, false);
		if (i.kind === "bad_deploy") assert.notEqual(e.version, "v141");
		if (i.kind === "dependency_down") assert.equal(effective(s2, i.cause.rootService).up, false);
	}
	w2.close();
	assert.equal(s.stats.worse, 0, "the oracle never makes anything worse");
	w.close();
});

test("a naive responder (restart, then scale, then roll back) makes things worse on the same world", () => {
	const o = make("oracle"), v = make("naive");
	o.run({ days: 120 }); v.run({ days: 120 });
	const so = o.state() as any, sv = v.state() as any;
	const worseKinds = new Set((Object.values(sv.incidents) as any[]).filter((i) => i.worse > 0).map((i) => i.kind));
	assert.ok(worseKinds.size >= 2, `at least two kinds get worse under blind restarts: ${[...worseKinds]}`);
	const end = 120 * DAY, io = impactMinutes(so, end), iv = impactMinutes(sv, end);
	assert.ok(iv > 2 * io, `customer impact (severity-weighted minutes): naive ${Math.round(iv)} vs oracle ${Math.round(io)}`);
	assert.ok((Object.values(sv.incidents) as any[]).filter((i) => i.status === "open").length > (Object.values(so.incidents) as any[]).filter((i) => i.status === "open").length, "the naive responder leaves more problems open");
	// the same incidents arrive for both: the responder cannot change the weather
	const key = (s: any) => (Object.values(s.incidents) as any[]).filter((i) => i.openedAt < 100 * DAY).map((i) => `${i.id}:${i.kind}:${i.service}:${i.openedAt}`).slice(0, 40).join(",");
	assert.equal(key(so), key(sv), "same seed, same incidents arriving at the same moments, whoever responds");
	o.close(); v.close();
});

test("nobody responding: problems escalate by themselves and customer impact piles up", () => {
	const w = make("none"); w.run({ days: 30 });
	const s = w.state() as any;
	const all = Object.values(s.incidents) as any[];
	assert.ok(all.length > 10 && all.every((i) => i.status === "open"));
	assert.ok(all.filter((i) => i.openedAt < 25 * DAY && i.kind !== "noisy_alert").every((i) => i.severity === 3), "old real problems have escalated to the top severity");
	w.close();
});

test("determinism and mix: same seed, same incidents; a plausible spread of kinds over 90 days, for many seeds", () => {
	const list = (seed: string) => { const w = make("none", seed); w.run({ days: 90 }); const s = w.state() as any; w.close(); return Object.values(s.incidents) as any[]; };
	const a = list("seed-a"), b = list("seed-a"), c = list("seed-b");
	assert.deepEqual(a.map((i) => [i.id, i.kind, i.service, i.openedAt]), b.map((i) => [i.id, i.kind, i.service, i.openedAt]));
	assert.notDeepEqual(a.map((i) => i.openedAt), c.map((i) => i.openedAt));
	for (let k = 0; k < 10; k++) {
		const inc = list(`mix-${k}`);
		assert.ok(inc.length >= 35 && inc.length <= 100, `incidents in 90 days: ${inc.length}`);
		const counts = new Map<string, number>();
		for (const i of inc) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
		assert.ok(counts.size >= 5, `at least 5 kinds appear (${counts.size})`);
		assert.ok(Math.max(...counts.values()) / inc.length < 0.4, "no kind dominates");
		const weekday = inc.filter((i) => { const d = Math.floor(i.openedAt / DAY) % 7; const h = (i.openedAt % DAY) / 3600_000; return d < 5 && h >= 8 && h < 18; }).length / inc.length;
		assert.ok(weekday > 0.35, `incidents cluster in business hours (${(weekday * 100).toFixed(0)}% of them, where only 30% of the time is business hours)`);
	}
});

test("a year of an active world with a responder is still cheap", () => {
	const w = make("oracle"); const t0 = Date.now();
	w.run({ days: 365 });
	const wall = Date.now() - t0;
	console.log(`# itops 365 days with oracle: ${wall} ms, ${w.status().steps} steps, ${w.status().events} events`);
	assert.ok(wall < 20_000, `took ${wall} ms`);
	w.close();
});
