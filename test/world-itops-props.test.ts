// Property tests for the IT-operations world (M1): try to BREAK the world.
// Read-only on product code: this file only opens worlds, runs them and checks
// invariants over many seeds and all three responder policies.
// Style follows test/world-itops.test.ts and test/world-m0.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-itops-props-"));
process.env.SESSION_SECRET = "test-secret";

const { World, DAY } = await import("../src/world/engine.ts");
const { seededRng } = await import("../src/world/rng.ts");
const { itopsSpec } = await import("../src/world/itops/spec.ts");
const { SERVICES, BASE_POOL, BASE_VERSION } = await import("../src/world/itops/catalog.ts");
const { symptoms } = await import("../src/world/itops/symptoms.ts");
const { effective } = await import("../src/world/itops/state.ts");

type Policy = "oracle" | "naive" | "none";
const SEEDS = Array.from({ length: 12 }, (_, i) => `props-${i}`);
const POLICIES: Policy[] = ["oracle", "naive", "none"];
const DAYS = 60;
const END = 60 * DAY;

const dir = mkdtempSync(join(tmpdir(), "crew-itops-props-files-"));
let n = 0;

// One cached 60-day run per (policy, seed); every invariant below reads from the
// same runs so the whole file stays well under the 60 s budget.
const cache = new Map<string, { events: any[]; state: any }>();
function getRun(policy: Policy, seed: string): { events: any[]; state: any } {
	const key = `${policy}:${seed}`;
	const hit = cache.get(key);
	if (hit) return hit;
	const w = World.open(join(dir, `w${++n}.sqlite`), { spec: itopsSpec(policy), seed, rng: seededRng });
	w.run({ days: DAYS });
	const run = { events: w.events(), state: JSON.parse(JSON.stringify(w.state())) };
	w.close();
	cache.set(key, run);
	return run;
}
const allRuns = () => SEEDS.flatMap((seed) => POLICIES.map((policy) => ({ seed, policy, ...getRun(policy, seed) })));

test("1. event log shape: gap-free seq, non-decreasing vtime, nothing past the end", () => {
	for (const { seed, policy, events } of allRuns()) {
		assert.ok(events.length > 0, `${policy}/${seed}: a 60-day run has events`);
		events.forEach((e, i) => {
			assert.equal(e.seq, i + 1, `${policy}/${seed}: seq has no gaps (event ${i})`);
			if (i > 0) assert.ok(e.vtime >= events[i - 1].vtime, `${policy}/${seed}: vtime never decreases`);
			assert.ok(e.vtime <= END, `${policy}/${seed}: vtime ${e.vtime} <= end of run ${END}`);
		});
	}
});

test("2. lifecycle: resolved once, by a resolving fix, and nothing happens after", () => {
	for (const { seed, policy, events } of allRuns()) {
		const byId = new Map<string, any[]>();
		for (const e of events) {
			if (!byId.has(e.payload.id)) byId.set(e.payload.id, []);
			byId.get(e.payload.id)!.push(e);
		}
		let openedAt = new Map<string, number>();
		for (const e of events) if (e.type === "incident.opened") openedAt.set(e.payload.id, e.vtime);
		for (const [id, list] of byId) {
			const resolved = list.filter((e) => e.type === "incident.resolved");
			assert.ok(resolved.length <= 1, `${policy}/${seed}/${id}: resolved at most once`);
			if (resolved.length === 1) {
				const r = resolved[0];
				const fix = list.filter((e) => e.type === "fix.applied" && e.seq < r.seq && e.payload.outcome === "resolved");
				assert.ok(fix.length >= 1, `${policy}/${seed}/${id}: a resolving fix.applied precedes incident.resolved`);
				for (const e of list) {
					if (e.seq > r.seq) assert.ok(e.type !== "fix.applied" && e.type !== "incident.worsened", `${policy}/${seed}/${id}: no ${e.type} after incident.resolved`);
				}
				assert.ok(r.vtime >= openedAt.get(id)!, `${policy}/${seed}/${id}: resolved time >= opened time`);
			}
		}
	}
});

test("3. severity: always 1..3, never decreases, state matches the fold of events", () => {
	for (const { seed, policy, events, state } of allRuns()) {
		const current = new Map<string, number>();
		for (const e of events) {
			if (e.type === "incident.opened") {
				assert.ok([1, 2, 3].includes(e.payload.severity), `${policy}/${seed}: opened severity in 1..3`);
				current.set(e.payload.id, e.payload.severity);
			} else if (e.type === "incident.worsened") {
				assert.ok([1, 2, 3].includes(e.payload.severity), `${policy}/${seed}: worsened severity in 1..3`);
				const prev = current.get(e.payload.id)!;
				assert.ok(e.payload.severity >= prev, `${policy}/${seed}/${e.payload.id}: severity never decreases`);
				current.set(e.payload.id, e.payload.severity);
			} else if (e.type === "fix.applied" && e.payload.outcome === "worse") {
				current.set(e.payload.id, Math.min(3, current.get(e.payload.id)! + 1));
			}
		}
		for (const [id, sev] of current) {
			assert.equal(state.incidents[id].severity, sev, `${policy}/${seed}/${id}: state severity equals the last severity implied by events`);
			assert.ok([1, 2, 3].includes(state.incidents[id].severity), `${policy}/${seed}/${id}: state severity in 1..3`);
		}
	}
});

test("4. counters: opened/resolved/worse, nextId and incident count match the events", () => {
	for (const { seed, policy, events, state } of allRuns()) {
		const opened = events.filter((e) => e.type === "incident.opened").length;
		const resolved = events.filter((e) => e.type === "incident.resolved").length;
		const worse = events.filter((e) => e.type === "fix.applied" && e.payload.outcome === "worse").length;
		assert.equal(state.stats.opened, opened, `${policy}/${seed}: stats.opened`);
		assert.equal(state.stats.resolved, resolved, `${policy}/${seed}: stats.resolved`);
		assert.equal(state.stats.worse, worse, `${policy}/${seed}: stats.worse`);
		assert.equal(state.nextId, opened + 1, `${policy}/${seed}: nextId == opened + 1`);
		assert.equal(Object.keys(state.incidents).length, opened, `${policy}/${seed}: every opened incident is in state`);
	}
});

test("5. state equals the fold of events from the initial state", () => {
	for (const { seed, policy, events, state } of allRuns()) {
		const spec: any = itopsSpec(policy);
		let folded: any = spec.initial();
		for (const e of events) folded = spec.reduce(folded, e);
		assert.deepEqual(JSON.parse(JSON.stringify(folded)), JSON.parse(JSON.stringify(state)), `${policy}/${seed}: fold of all events == world.state()`);
	}
});

test("6. honest state: open faults are visible, quiet services look normal", () => {
	for (const { seed, policy, state } of allRuns()) {
		const open = (Object.values(state.incidents) as any[]).filter((i) => i.status === "open");
		for (const i of open) {
			if (i.kind === "bad_config") assert.equal(effective(state, i.service).pool, 0, `${policy}/${seed}/${i.id}: open bad_config shows as pool 0`);
			if (i.kind === "bad_deploy") assert.notEqual(effective(state, i.service).version, "v141", `${policy}/${seed}/${i.id}: open bad_deploy changes the version`);
			if (i.kind === "expired_cert") assert.equal(effective(state, i.service).certValid, false, `${policy}/${seed}/${i.id}: open expired_cert shows certValid false`);
			if (i.kind === "dependency_down") assert.equal(effective(state, i.cause.rootService).up, false, `${policy}/${seed}/${i.id}: open dependency_down shows root down`);
		}
		for (const s of SERVICES as unknown as string[]) {
			const has = (kind: string, match: (i: any) => boolean) => open.some((i) => i.kind === kind && match(i));
			if (!has("bad_config", (i) => i.service === s)) assert.equal(effective(state, s as any).pool, BASE_POOL, `${policy}/${seed}: no open bad_config on ${s}, pool is normal`);
			if (!has("bad_deploy", (i) => i.service === s)) assert.equal(effective(state, s as any).version, BASE_VERSION, `${policy}/${seed}: no open bad_deploy on ${s}, version is normal`);
			if (!has("expired_cert", (i) => i.service === s)) assert.equal(effective(state, s as any).certValid, true, `${policy}/${seed}: no open expired_cert on ${s}, cert is valid`);
			if (!has("dependency_down", (i) => i.cause.rootService === s)) assert.equal(effective(state, s as any).up, true, `${policy}/${seed}: nothing depends-down on ${s}, it is up`);
		}
	}
});

test("7. slicing invariance: 40 days at once, in slices, and across a reopen give the same hash", () => {
	for (const policy of POLICIES) {
		const seed = "props-slice";
		const whole = World.open(join(dir, `s${++n}.sqlite`), { spec: itopsSpec(policy), seed, rng: seededRng });
		whole.run({ days: 40 });
		const h40 = whole.hash();
		whole.close();
		const sliced = World.open(join(dir, `s${++n}.sqlite`), { spec: itopsSpec(policy), seed, rng: seededRng });
		for (let i = 0; i < 4; i++) sliced.run({ days: 10 });
		assert.equal(sliced.hash(), h40, `${policy}: 4 x 10 days == 40 days at once`);
		sliced.close();
		const daily = World.open(join(dir, `s${++n}.sqlite`), { spec: itopsSpec(policy), seed, rng: seededRng });
		for (let i = 0; i < 40; i++) daily.run({ days: 1 });
		assert.equal(daily.hash(), h40, `${policy}: 40 x 1 day == 40 days at once`);
		daily.close();
		// close, reopen the same file, continue: 20 + 20 == 40
		const path = join(dir, `s${++n}.sqlite`);
		const part = World.open(path, { spec: itopsSpec(policy), seed, rng: seededRng });
		part.run({ days: 20 });
		part.close();
		const resumed = World.open(path, { spec: itopsSpec(policy), seed, rng: seededRng });
		resumed.run({ days: 20 });
		assert.equal(resumed.hash(), h40, `${policy}: reopen after 20 days and run 20 more == 40 days at once`);
		resumed.close();
	}
});

test("8. policy independence: the same seed opens the same incidents under every policy", () => {
	for (const seed of SEEDS) {
		const key = (policy: Policy) =>
			getRun(policy, seed).events
				.filter((e) => e.type === "incident.opened")
				.map((e) => ({ id: e.payload.id, kind: e.payload.kind, service: e.payload.service, vtime: e.vtime, severity: e.payload.severity, cause: e.payload.cause }));
		assert.deepEqual(key("naive"), key("oracle"), `${seed}: naive arrivals == oracle arrivals`);
		assert.deepEqual(key("none"), key("oracle"), `${seed}: no-responder arrivals == oracle arrivals`);
	}
});

test("9. naive vs oracle: naive never has fewer open incidents or fewer harmful fixes", () => {
	for (const seed of SEEDS) {
		const o = getRun("oracle", seed), v = getRun("naive", seed);
		const openO = (Object.values(o.state.incidents) as any[]).filter((i) => i.status === "open").length;
		const openV = (Object.values(v.state.incidents) as any[]).filter((i) => i.status === "open").length;
		assert.ok(openV >= openO, `${seed}: naive open (${openV}) >= oracle open (${openO}) at day 60`);
		const worseO = o.events.filter((e) => e.type === "fix.applied" && e.payload.outcome === "worse").length;
		const worseV = v.events.filter((e) => e.type === "fix.applied" && e.payload.outcome === "worse").length;
		assert.ok(worseV >= worseO, `${seed}: naive harmful fixes (${worseV}) >= oracle harmful fixes (${worseO})`);
	}
});

test("10. symptoms: pure, errorRate in [0,1], resolved incidents look healthy", () => {
	const HOUR = 3_600_000;
	for (const { seed, policy, state } of allRuns()) {
		for (const inc of Object.values(state.incidents) as any[]) {
			const a = symptoms(state, inc, inc.openedAt + HOUR);
			const b = symptoms(state, inc, inc.openedAt + HOUR);
			assert.deepEqual(a, b, `${policy}/${seed}/${inc.id}: symptoms() is pure`);
			if (inc.status === "open") {
				for (const t of [0, HOUR, 12 * HOUR, 7 * 24 * HOUR]) {
					const s = symptoms(state, inc, inc.openedAt + t);
					assert.ok(s.metrics.errorRate >= 0 && s.metrics.errorRate <= 1, `${policy}/${seed}/${inc.id}: errorRate in [0,1] at +${t}ms (got ${s.metrics.errorRate})`);
				}
			} else {
				assert.ok(symptoms(state, inc, inc.openedAt + HOUR).metrics.errorRate < 0.01, `${policy}/${seed}/${inc.id}: a resolved incident looks healthy`);
			}
		}
	}
});

test("11. snapshots: one row per day, and day 10 replays to the final state", () => {
	const path = join(dir, `snap${++n}.sqlite`);
	const w = World.open(path, { spec: itopsSpec("oracle"), seed: "props-snap", rng: seededRng });
	w.run({ days: 20 });
	const events = w.events();
	const finalState = JSON.parse(JSON.stringify(w.state()));
	w.close();
	const db = new DatabaseSync(path, { readOnly: true });
	const { n: rows } = db.prepare("SELECT COUNT(*) n FROM snapshots WHERE branch = 'main'").get() as { n: number };
	assert.equal(rows, 20, "a 20-day run stores exactly 20 snapshot rows");
	const snap = db.prepare("SELECT seq, state FROM snapshots WHERE branch = 'main' AND day = 10").get() as { seq: number; state: string };
	db.close();
	const spec: any = itopsSpec("oracle");
	let replayed: any = JSON.parse(snap.state);
	for (const e of events.filter((e) => e.seq > snap.seq)) replayed = spec.reduce(replayed, e);
	assert.deepEqual(JSON.parse(JSON.stringify(replayed)), finalState, "snapshot of day 10 + later events == final state of the 20-day run");
});
