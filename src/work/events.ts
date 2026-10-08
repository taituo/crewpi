import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { db as defaultDb } from "../db.ts";

/**
 * Domain events with a transactional outbox and a durable inbox.
 *  - emit() writes the event and one outbox row per destination in the caller's transaction, so a state change and the
 *    announcement of it succeed or fail together (a crash cannot leave one without the other).
 *  - The relay delivers each (event, destination) at least once; the inbox makes a consumer's handling idempotent.
 *  - One relay per process, and one process per data directory (see the Pi storage lease): no claiming protocol needed.
 */
export type Visibility = "org" | `channel:${string}` | `owner:${string}`;
export type ActorType = "human" | "internal_agent" | "external_agent" | "system" | "workflow";

export type EventInput = {
	type: string;
	actorId: string;
	actorType: ActorType;
	correlationId: string;
	causationId?: string;
	sourceRefs?: string[];
	visibility: Visibility;
	channelId?: string;
	payload?: Record<string, unknown>;
	tenantId?: string;
	organizationId?: string;
	scope?: { mode: "live" } | { mode: "synthetic"; worldId: string; branchId: string };
	/** Consumers that must see this event. Defaults to every registered consumer that subscribes to the type. */
	destinations?: string[];
};
export type DomainEvent = Required<Pick<EventInput, "type" | "actorId" | "actorType" | "correlationId" | "visibility">> & {
	sequence: number;
	eventId: string;
	tenantId: string;
	organizationId: string;
	scope: "live" | "synthetic";
	worldId: string | null;
	branchId: string | null;
	schemaVersion: number;
	causationId: string | null;
	sourceRefs: string[];
	channelId: string | null;
	occurredAt: number;
	payload: Record<string, unknown>;
};

export const newId = (prefix: string) => `${prefix}_${randomUUID()}`;

export type Consumer = { name: string; types: (t: string) => boolean; handle: (e: DomainEvent) => Promise<void> | void };

const rowToEvent = (r: any): DomainEvent => ({
	sequence: r.sequence, eventId: r.event_id, tenantId: r.tenant_id, organizationId: r.organization_id, scope: r.scope, worldId: r.world_id, branchId: r.branch_id,
	type: r.type, schemaVersion: r.schema_version, actorId: r.actor_id, actorType: r.actor_type, correlationId: r.correlation_id, causationId: r.causation_id,
	sourceRefs: JSON.parse(r.source_refs), visibility: r.visibility, channelId: r.channel_id, occurredAt: r.occurred_at, payload: JSON.parse(r.payload),
});

/** SAVEPOINT based, so it nests: a handoff transition inside a larger transaction joins it. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
	const name = `sp_${Math.random().toString(36).slice(2)}`;
	db.exec(`SAVEPOINT ${name}`);
	try {
		const r = fn();
		db.exec(`RELEASE ${name}`);
		return r;
	} catch (e) {
		db.exec(`ROLLBACK TO ${name}`);
		db.exec(`RELEASE ${name}`);
		throw e;
	}
}

export class EventBus {
	readonly db: DatabaseSync;
	private consumers = new Map<string, Consumer>();
	private timer?: ReturnType<typeof setTimeout>;
	private running = false;
	private stopped = true;
	maxAttempts = 8;
	log: (m: string) => void = () => {};

	constructor(db: DatabaseSync = defaultDb) {
		this.db = db;
	}

	register(c: Consumer) {
		this.consumers.set(c.name, c);
	}

	/** Call inside the transaction that changes state. Returns the stored event. */
	emit(e: EventInput): DomainEvent {
		const scope = e.scope ?? { mode: "live" as const };
		const eventId = newId("evt");
		const dests = e.destinations ?? [...this.consumers.values()].filter((c) => c.types(e.type)).map((c) => c.name);
		return tx(this.db, () => {
			const r = this.db.prepare(
				`INSERT INTO events (event_id, tenant_id, organization_id, scope, world_id, branch_id, type, actor_id, actor_type, correlation_id, causation_id, source_refs, visibility, channel_id, occurred_at, payload)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			).run(eventId, e.tenantId ?? "default", e.organizationId ?? "default", scope.mode, scope.mode === "synthetic" ? scope.worldId : null, scope.mode === "synthetic" ? scope.branchId : null,
				e.type, e.actorId, e.actorType, e.correlationId, e.causationId ?? null, JSON.stringify(e.sourceRefs ?? []), e.visibility, e.channelId ?? null, Date.now(), JSON.stringify(e.payload ?? {}));
			for (const d of dests) this.db.prepare("INSERT INTO outbox (event_id, destination) VALUES (?,?)").run(eventId, d);
			return rowToEvent(this.db.prepare("SELECT * FROM events WHERE sequence = ?").get(Number(r.lastInsertRowid)));
		});
	}

	get(eventId: string): DomainEvent | undefined {
		const r = this.db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId);
		return r ? rowToEvent(r) : undefined;
	}

	/** Events in order, optionally one correlation chain. The caller applies visibility (see canSee in the API). */
	list(o: { channelId?: string; correlationId?: string; since?: number; until?: number; limit?: number } = {}): DomainEvent[] {
		const where: string[] = [], args: any[] = [];
		if (o.channelId) { where.push("channel_id = ?"); args.push(o.channelId); }
		if (o.correlationId) { where.push("correlation_id = ?"); args.push(o.correlationId); }
		if (o.since !== undefined) { where.push("occurred_at >= ?"); args.push(o.since); }
		if (o.until !== undefined) { where.push("occurred_at <= ?"); args.push(o.until); }
		const rows = this.db.prepare(`SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY sequence DESC LIMIT ?`).all(...args, o.limit ?? 500) as any[];
		return rows.reverse().map(rowToEvent);
	}

	/** Delivers what is due. Returns how many (event, destination) pairs were handled this pass. */
	async relayOnce(now = Date.now()): Promise<number> {
		if (this.running) return 0;
		this.running = true;
		let handled = 0;
		try {
			const due = this.db.prepare("SELECT event_id, destination, attempts FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY rowid LIMIT 50").all(now) as { event_id: string; destination: string; attempts: number }[];
			for (const o of due) {
				const consumer = this.consumers.get(o.destination);
				if (!consumer) continue; // not registered in this process (yet): stays pending
				const done = this.db.prepare("SELECT 1 FROM inbox WHERE consumer = ? AND event_id = ?").get(o.destination, o.event_id);
				try {
					if (!done) {
						await consumer.handle(this.get(o.event_id)!);
						this.db.prepare("INSERT OR IGNORE INTO inbox (consumer, event_id, processed_at) VALUES (?,?,?)").run(o.destination, o.event_id, Date.now());
					}
					this.db.prepare("UPDATE outbox SET status = 'done', last_error = NULL WHERE event_id = ? AND destination = ?").run(o.event_id, o.destination);
				} catch (e) {
					const attempts = o.attempts + 1, failed = attempts >= this.maxAttempts;
					const backoff = Math.min(60_000, 500 * 2 ** attempts);
					this.db.prepare("UPDATE outbox SET attempts = ?, status = ?, next_attempt_at = ?, last_error = ? WHERE event_id = ? AND destination = ?").run(attempts, failed ? "failed" : "pending", now + backoff, String((e as Error).message).slice(0, 300), o.event_id, o.destination);
					this.log(`${o.destination} failed for ${o.event_id} (attempt ${attempts}): ${(e as Error).message}`);
				}
				handled++;
			}
		} finally {
			this.running = false;
		}
		return handled;
	}

	pending(): number {
		return (this.db.prepare("SELECT COUNT(*) n FROM outbox WHERE status = 'pending'").get() as { n: number }).n;
	}

	start(intervalMs = 400) {
		this.stopped = false;
		const tick = async () => {
			if (this.stopped) return;
			await this.relayOnce().catch((e) => this.log(`relay: ${e.message}`));
			if (!this.stopped) this.timer = setTimeout(tick, intervalMs);
		};
		this.timer = setTimeout(tick, intervalMs);
		this.timer.unref?.();
	}

	stop() {
		this.stopped = true;
		clearTimeout(this.timer);
	}

	/** Test/shutdown helper: relay until nothing is due. */
	async drain(maxPasses = 50) {
		let t = Date.now() + 120_000; // a virtual clock that jumps past every back-off, so retries happen in the same call
		for (let i = 0; i < maxPasses; i++, t += 120_000) if ((await this.relayOnce(t)) === 0) return;
	}
}
