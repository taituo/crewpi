import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Json, Rng, RngFactory, RunReport, Wake, NewWake, WorldEvent, WorldSpec } from "./types.ts";

export const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;

/**
 * The deterministic, time-skipping core of Crew World (M0).
 *  - Virtual time jumps: the clock moves to the next scheduled wake-up; a quiet year costs no real time.
 *  - One world is one SQLite file. Every step (events + schedule + random state) is committed together in batches,
 *    so a crash loses at most the open batch and nothing is ever half done.
 *  - State is not stored per step: it is the fold of the events over the latest daily snapshot (event sourcing).
 *  - A rolling hash over all events is the determinism check: same seed + same history = same hash.
 */
export type OpenOptions<S> = { spec: WorldSpec<S>; seed: string; rng: RngFactory; name?: string; quiet?: boolean };
export type RunOptions = {
	days?: number;          // run this many virtual days from now
	untilDay?: number;      // or: run until this absolute virtual day
	maxSteps?: number;      // budget: stop cleanly after this many steps
	maxWallMs?: number;     // budget: stop cleanly after this much real time
	onStep?: () => void;    // called inside the open batch (tests use it to simulate a crash)
};

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const BATCH = 500;

export class World<S = any> {
	private db: DatabaseSync;
	private spec: WorldSpec<S>;
	private factory: RngFactory;
	private seed: string;
	private worldName: string;
	private branch = "main";
	private clock = 0;
	private seq = 0;
	private steps = 0;
	private chain = "";
	private current!: S;
	private rngs = new Map<string, Rng>();
	private dirtyRng = new Set<string>();
	private lastSnapDay = 0;
	private q: Record<string, StatementSync> = {};

	private constructor(db: DatabaseSync, o: OpenOptions<S>, name: string) {
		this.db = db;
		this.spec = o.spec;
		this.factory = o.rng;
		this.seed = o.seed;
		this.worldName = name;
	}

	static open<S>(path: string, o: OpenOptions<S>): World<S> {
		mkdirSync(dirname(path), { recursive: true });
		const db = new DatabaseSync(path);
		db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
		db.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS world_events (branch TEXT NOT NULL, seq INTEGER NOT NULL, vtime INTEGER NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (branch, seq)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS snapshots (branch TEXT NOT NULL, day INTEGER NOT NULL, vtime INTEGER NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL, chain TEXT NOT NULL, PRIMARY KEY (branch, day)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS schedule (id INTEGER PRIMARY KEY AUTOINCREMENT, due INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS schedule_due ON schedule(due, id);
CREATE TABLE IF NOT EXISTS actor_rng (actor TEXT PRIMARY KEY, state TEXT NOT NULL) WITHOUT ROWID;`);
		const meta = (k: string) => (db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value;
		const w = new World<S>(db, o, o.name ?? basename(path).replace(/\.sqlite$/, ""));
		w.prepare();
		const known = meta("seed");
		if (known === undefined) {
			const set = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
			db.exec("BEGIN");
			set.run("seed", o.seed); set.run("spec", o.spec.name); set.run("quiet", o.quiet ? "1" : "0");
			set.run("clock", "0"); set.run("seq", "0"); set.run("steps", "0"); set.run("chain", sha(`${o.spec.name}:${o.seed}`));
			if (!o.quiet) for (const wake of o.spec.start(w.factory.create(o.seed).fork("start"))) w.insertWake(wake);
			db.exec("COMMIT");
		} else {
			if (known !== o.seed) throw new Error(`this world was created with another seed (${known}); refusing to open it with "${o.seed}"`);
			if (meta("spec") !== o.spec.name) throw new Error(`this world belongs to spec "${meta("spec")}", not "${o.spec.name}"`);
		}
		w.reload();
		return w;
	}

	/** Reads which spec and seed a world file was made with, without opening it as a world. */
	static describe(path: string): { spec: string; seed: string } | undefined {
		let db: DatabaseSync | undefined;
		try {
			db = new DatabaseSync(path, { readOnly: true });
			const get = (k: string) => (db!.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value;
			const spec = get("spec"), seed = get("seed");
			return spec !== undefined && seed !== undefined ? { spec, seed } : undefined;
		} catch {
			return undefined;
		} finally {
			db?.close();
		}
	}

	private prepare() {
		const p = (sql: string) => this.db.prepare(sql);
		this.q = {
			insEvent: p("INSERT INTO world_events (branch, seq, vtime, type, actor, payload) VALUES (?,?,?,?,?,?)"),
			insWake: p("INSERT INTO schedule (due, actor, kind, data) VALUES (?,?,?,?)"),
			peek: p("SELECT id, due, actor, kind, data FROM schedule ORDER BY due, id LIMIT 1"),
			del: p("DELETE FROM schedule WHERE id = ?"),
			setRng: p("INSERT OR REPLACE INTO actor_rng (actor, state) VALUES (?, ?)"),
			setMeta: p("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"),
			insSnap: p("INSERT OR IGNORE INTO snapshots (branch, day, vtime, seq, state, chain) VALUES (?,?,?,?,?,?)"),
		};
	}

	/** Rebuilds memory from the file: latest snapshot + the events after it. Also the recovery path after a failed batch. */
	private reload() {
		const meta = (k: string) => (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string }).value;
		this.clock = Number(meta("clock")); this.seq = Number(meta("seq")); this.steps = Number(meta("steps")); this.chain = meta("chain");
		const snap = this.db.prepare("SELECT day, seq, state FROM snapshots WHERE branch = ? AND seq <= ? ORDER BY day DESC LIMIT 1").get(this.branch, this.seq) as { day: number; seq: number; state: string } | undefined;
		let state: S = snap ? JSON.parse(snap.state) : this.spec.initial();
		const rows = this.db.prepare("SELECT seq, vtime, type, actor, payload FROM world_events WHERE branch = ? AND seq > ? AND seq <= ? ORDER BY seq").all(this.branch, snap?.seq ?? 0, this.seq) as any[];
		for (const r of rows) state = this.spec.reduce(state, { branch: this.branch, seq: r.seq, vtime: r.vtime, type: r.type, actor: r.actor, payload: JSON.parse(r.payload) });
		this.current = state;
		this.lastSnapDay = (this.db.prepare("SELECT COALESCE(MAX(day), 0) d FROM snapshots WHERE branch = ?").get(this.branch) as { d: number }).d;
		this.rngs.clear(); this.dirtyRng.clear();
		for (const r of this.db.prepare("SELECT actor, state FROM actor_rng").all() as { actor: string; state: string }[]) this.rngs.set(r.actor, this.factory.restore(r.state));
	}

	private insertWake(w: Wake) {
		this.q.insWake.run(w.at, w.actor, w.kind, JSON.stringify(w.data ?? {}));
	}

	/** Schedules a wake-up from outside the actors (a test, or the operator in godmode). */
	scheduleAt(w: Wake) {
		if (w.at < this.clock) throw new Error(`cannot schedule in the past (${w.at} < ${this.clock})`);
		this.insertWake(w);
	}

	private actorRng(id: string): Rng {
		let r = this.rngs.get(id);
		if (!r) { r = this.factory.create(this.seed).fork(id); this.rngs.set(id, r); }
		return r;
	}

	private snapshot(day: number) {
		this.q.insSnap.run(this.branch, day, day * DAY, this.seq, canonical(this.current), this.chain);
		this.lastSnapDay = Math.max(this.lastSnapDay, day);
	}

	private commit() {
		for (const a of this.dirtyRng) this.q.setRng.run(a, this.rngs.get(a)!.state());
		this.dirtyRng.clear();
		for (const [k, v] of [["clock", this.clock], ["seq", this.seq], ["steps", this.steps], ["chain", this.chain]] as const) this.q.setMeta.run(k, String(v));
	}

	run(o: RunOptions = {}): RunReport {
		const t0 = Date.now(), fromDay = Math.floor(this.clock / DAY), fromSteps = this.steps, fromSeq = this.seq;
		const target = o.untilDay !== undefined ? o.untilDay * DAY : this.clock + (o.days ?? 0) * DAY;
		let stopped: RunReport["stopped"] = "done", inBatch = 0, ran = 0;
		this.db.exec("BEGIN");
		try {
			for (;;) {
				const next = this.q.peek.get() as { id: number; due: number; actor: string; kind: string; data: string } | undefined;
				if (!next || next.due > target) break;
				if (o.maxSteps !== undefined && ran >= o.maxSteps) { stopped = "max-steps"; break; }
				if (o.maxWallMs !== undefined && Date.now() - t0 >= o.maxWallMs) { stopped = "max-wall"; break; }
				// The clock leaps to the wake-up. Every day boundary crossed on the way gets a snapshot of the unchanged state.
				for (let d = this.lastSnapDay + 1; d * DAY <= next.due; d++) this.snapshot(d);
				this.q.del.run(next.id);
				this.clock = next.due;
				const actor = this.spec.actors.find((a) => a.id === next.actor);
				if (!actor) throw new Error(`a wake-up names an unknown actor "${next.actor}"`);
				const wake: Wake = { actor: next.actor, at: next.due, kind: next.kind, data: JSON.parse(next.data) };
				const res = actor.step({ now: this.clock, state: this.current as Readonly<S>, rng: this.actorRng(actor.id), wake });
				this.dirtyRng.add(actor.id);
				for (const e of res.events ?? []) {
					const ev: WorldEvent = { branch: this.branch, seq: ++this.seq, vtime: this.clock, type: e.type, actor: e.actor, payload: e.payload ?? {} };
					this.q.insEvent.run(ev.branch, ev.seq, ev.vtime, ev.type, ev.actor, JSON.stringify(ev.payload));
					this.current = this.spec.reduce(this.current, ev);
					this.chain = sha(this.chain + canonical([ev.seq, ev.vtime, ev.type, ev.actor, ev.payload]));
				}
				for (const w of res.wakes ?? []) {
					const at = "at" in w ? w.at : this.clock + w.in;
					if (!(at >= this.clock)) throw new Error(`an actor scheduled a wake-up in the past (${at} < ${this.clock})`);
					this.insertWake({ actor: w.actor, at, kind: w.kind, data: w.data });
				}
				this.steps++; ran++;
				o.onStep?.();
				if (++inBatch >= BATCH) { this.commit(); this.db.exec("COMMIT"); this.db.exec("BEGIN"); inBatch = 0; }
			}
			if (stopped === "done") {
				// Nothing more happens before the target: the clock simply arrives there.
				for (let d = this.lastSnapDay + 1; d * DAY <= target; d++) this.snapshot(d);
				this.clock = Math.max(this.clock, target);
			}
			this.commit();
			this.db.exec("COMMIT");
		} catch (e) {
			try { this.db.exec("ROLLBACK"); } catch { /* already closed */ }
			this.reload(); // memory goes back to what the file says
			throw e;
		}
		return { fromDay, toDay: Math.floor(this.clock / DAY), steps: this.steps - fromSteps, events: this.seq - fromSeq, wallMs: Date.now() - t0, stopped };
	}

	state(): S { return this.current; }
	hash(): string { return this.chain; }
	events(): WorldEvent[] {
		return (this.db.prepare("SELECT seq, vtime, type, actor, payload FROM world_events WHERE branch = ? ORDER BY seq").all(this.branch) as any[]).map((r) => ({ branch: this.branch, seq: r.seq, vtime: r.vtime, type: r.type, actor: r.actor, payload: JSON.parse(r.payload) as Record<string, Json> }));
	}
	status() {
		const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
		return { name: this.worldName, spec: this.spec.name, seed: this.seed, vtime: this.clock, day: Math.floor(this.clock / DAY), steps: this.steps, events: this.seq, snapshots: one("SELECT COUNT(*) n FROM snapshots"), pending: one("SELECT COUNT(*) n FROM schedule"), hash: this.chain };
	}
	close() { this.db.close(); }
}
