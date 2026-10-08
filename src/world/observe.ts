// The "god eye": a read-only view of a world file. It never writes, works while the world is running (SQLite WAL), and can show
// the world as it was at any point of its history by folding the events over the nearest daily snapshot.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { DAY } from "./engine.ts";
import { SPECS } from "./specs/index.ts";
import type { WorldSpec } from "./types.ts";
import { SERVICES } from "./itops/catalog.ts";
import { effective, impactMinutes, type ItOpsState } from "./itops/state.ts";

type Row = { seq: number; vtime: number; type: string; actor: string; payload: string };
export type Ev = { seq: number; vtime: number; type: string; actor: string; payload: Record<string, any> };
export type ChatMessage = { seq: number; vtime: number; kind: "alert" | "request" | "reply" | "escalation" | "fix" | "resolved"; from: string; to?: string; text: string };

const ticket = (id: string) => `OPS-${100 + Number(String(id).replace(/\D/g, ""))}`;
const CHAT_TYPES = ["incident.opened", "handoff.requested", "handoff.completed", "handoff.escalated", "action.performed", "incident.resolved"];

export class Observer {
	private db: DatabaseSync;
	private spec: WorldSpec<any>;
	readonly path: string;
	constructor(path: string) {
		if (!existsSync(path)) throw new Error(`no such world file: ${path}`);
		this.path = path;
		try { this.db = new DatabaseSync(path, { readOnly: true }); } catch (e) { throw new Error(`cannot open ${path}: ${(e as Error).message}`); }
		const specName = this.meta("spec");
		const base = specName?.split("+")[0] ?? "";
		const spec = SPECS[base];
		if (!spec) throw new Error(`cannot open ${path}: unknown world spec "${specName}"`);
		this.spec = spec;
	}
	close() { this.db.close(); }
	private meta(k: string): string | undefined { return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value; }

	info() {
		const events = Number(this.meta("seq")), vtime = Number(this.meta("clock"));
		const roster = (this.db.prepare("SELECT actor, COUNT(*) n FROM world_events WHERE type = 'agent.shift' GROUP BY actor ORDER BY actor").all() as { actor: string; n: number }[]).map((r) => {
			const last = this.db.prepare("SELECT payload FROM world_events WHERE type = 'agent.shift' AND actor = ? ORDER BY seq DESC LIMIT 1").get(r.actor) as { payload: string };
			const p = JSON.parse(last.payload);
			return { id: r.actor, shifts: r.n, brain: p.brain as string, tier: p.tier as number };
		});
		return {
			name: basename(this.path).replace(/\.sqlite$/, ""), spec: this.meta("spec")!, seed: this.meta("seed")!, vtime, day: Math.floor(vtime / DAY), steps: Number(this.meta("steps")),
			events, snapshots: (this.db.prepare("SELECT COUNT(*) n FROM snapshots").get() as { n: number }).n, hash: this.meta("chain")!, roster,
		};
	}

	events(o: { since?: number; limit?: number; type?: string; actor?: string } = {}): Ev[] {
		const limit = Math.min(Math.max(Math.floor(o.limit ?? 100), 1), 100_000);
		const rows = this.db.prepare(`SELECT seq, vtime, type, actor, payload FROM world_events WHERE seq > ? ${o.type ? "AND type = ?" : ""} ${o.actor ? "AND actor = ?" : ""} ORDER BY seq LIMIT ?`)
			.all(...[o.since ?? 0, ...(o.type ? [o.type] : []), ...(o.actor ? [o.actor] : []), limit]) as Row[];
		return rows.map((r) => ({ seq: r.seq, vtime: r.vtime, type: r.type, actor: r.actor, payload: JSON.parse(r.payload) }));
	}

	/** The state of the world after event number `seq` (0 = before anything happened). */
	stateAt(seq: number): any {
		const snap = this.db.prepare("SELECT seq, state FROM snapshots WHERE seq <= ? ORDER BY seq DESC LIMIT 1").get(seq) as { seq: number; state: string } | undefined;
		let state = snap ? JSON.parse(snap.state) : this.spec.initial();
		const rows = this.db.prepare("SELECT seq, vtime, type, actor, payload FROM world_events WHERE seq > ? AND seq <= ? ORDER BY seq").all(snap?.seq ?? 0, seq) as Row[];
		for (const r of rows) state = this.spec.reduce(state, { branch: "main", seq: r.seq, vtime: r.vtime, type: r.type, actor: r.actor, payload: JSON.parse(r.payload) });
		return JSON.parse(JSON.stringify(state));
	}

	/** The world as an operator's dashboard would show it. The hidden causes are shown only with `god`. */
	view(seq?: number, o: { god?: boolean } = {}) {
		const head = Number(this.meta("seq"));
		const at = Math.min(Math.max(seq ?? head, 0), head);
		const state = this.stateAt(at) as ItOpsState;
		const t = at === 0 ? 0 : (this.db.prepare("SELECT vtime FROM world_events WHERE seq = ?").get(at) as { vtime: number }).vtime;
		const open = Object.values(state.incidents).filter((i) => i.status === "open");
		const services = SERVICES.map((id) => {
			const e = effective(state, id);
			const touching = open.filter((i) => i.service === id || i.cause.rootService === id);
			return { id, replicas: e.replicas, version: e.version, pool: e.pool, certValid: e.certValid, status: !e.up ? "down" : touching.length ? "degraded" : "ok", incidents: touching.map((i) => i.id) };
		});
		return {
			seq: at, head, vtime: t, day: Math.floor(t / DAY), services,
			incidents: open.map((i) => ({ id: i.id, key: ticket(i.id), kind: i.kind, service: i.service, severity: i.severity, openedAt: i.openedAt, attempts: i.attempts, ...(o.god ? { cause: i.cause } : {}) })),
			stats: state.stats, impact: Math.round(impactMinutes(state, t)),
			handoffs: Object.values(state.handoffs ?? {}).filter((h: any) => h.status === "requested").length,
		};
	}

	/** The conversation: what the agents asked each other, what was done, and what the world reported. */
	chat(o: { since?: number; limit?: number } = {}): ChatMessage[] {
		const limit = Math.min(Math.max(Math.floor(o.limit ?? 100), 1), 5000);
		const rows = this.db.prepare(`SELECT seq, vtime, type, actor, payload FROM world_events WHERE seq > ? AND type IN (${CHAT_TYPES.map(() => "?").join(",")}) ORDER BY seq LIMIT ?`).all(o.since ?? 0, ...CHAT_TYPES, limit) as Row[];
		const requester = (id: string) => { const r = this.db.prepare("SELECT payload FROM world_events WHERE type = 'handoff.requested' AND json_extract(payload, '$.id') = ?").get(id) as { payload: string } | undefined; return r ? (JSON.parse(r.payload) as { from: string; to: string }) : undefined; };
		const out: ChatMessage[] = [];
		for (const r of rows) {
			const p = JSON.parse(r.payload), base = { seq: r.seq, vtime: r.vtime };
			switch (r.type) {
				case "incident.opened": out.push({ ...base, kind: "alert", from: "monitoring", text: `${ticket(p.id)} opened on ${p.service} (severity ${p.severity})` }); break;
				case "handoff.requested": out.push({ ...base, kind: "request", from: p.from, to: p.to, text: p.task }); break;
				case "handoff.completed": out.push({ ...base, kind: "reply", from: r.actor, to: requester(p.id)?.from, text: p.result }); break;
				case "handoff.escalated": { const q = requester(p.id); out.push({ ...base, kind: "escalation", from: "watchdog", to: q?.from, text: `Nobody answered ${p.id} (${q?.to ?? "?"}): ${p.reason}. Handed to people.` }); break; }
				case "action.performed": { const a = p.action; out.push({ ...base, kind: "fix", from: String(r.actor).replace(/^tool:/, ""), text: `ran ${a.type} on ${a.service}${a.replicas ? ` (${a.replicas} replicas)` : ""}${p.affected?.length ? `, touching ${p.affected.map(ticket).join(", ")}` : ""}` }); break; }
				case "incident.resolved": out.push({ ...base, kind: "resolved", from: "monitoring", text: `${ticket(p.id)} resolved by ${String(p.by).replace(/^tool:/, "")}` }); break;
			}
		}
		return out;
	}

	/** One point per day for charts: cumulative counters from the daily snapshots; the last point is the present. */
	series() {
		const info = this.info();
		const snaps = this.db.prepare("SELECT day, vtime, state FROM snapshots ORDER BY day").all() as { day: number; vtime: number; state: string }[];
		const perDay = new Map<number, number>();
		for (const r of this.db.prepare("SELECT vtime / ? d, COUNT(*) n FROM world_events WHERE type = 'agent.shift' GROUP BY d").all(DAY) as { d: number; n: number }[]) perDay.set(r.d, r.n);
		const out = { days: [] as number[], opened: [] as number[], resolved: [] as number[], impact: [] as number[], open: [] as number[], handoffs: [] as number[], shifts: [] as number[] };
		const push = (day: number, t: number, s: ItOpsState) => {
			out.days.push(day); out.opened.push(s.stats.opened); out.resolved.push(s.stats.resolved); out.impact.push(Math.round(impactMinutes(s, t)));
			out.open.push(Object.values(s.incidents).filter((i) => i.status === "open").length); out.handoffs.push(Object.keys(s.handoffs ?? {}).length);
			let c = 0; for (const [d, n] of perDay) if (d < day) c += n;
			out.shifts.push(c);
		};
		push(0, 0, this.spec.initial());
		for (const s of snaps) if (s.day > 0 && s.day < info.day) push(s.day, s.vtime, JSON.parse(s.state));
		if (info.day > 0) {
			const head = this.stateAt(info.events) as ItOpsState;
			push(info.day, info.vtime, head);
			out.shifts[out.shifts.length - 1] = [...perDay.values()].reduce((a, b) => a + b, 0);
		}
		return out;
	}
}
