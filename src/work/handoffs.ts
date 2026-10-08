import type { DatabaseSync } from "node:sqlite";
import { db as defaultDb } from "../db.ts";
import { config } from "../config.ts";
import { EventBus, newId, tx, type DomainEvent } from "./events.ts";

/**
 * Task + Handoff. A handoff is one party asking another to take a task, and the record of what became of it.
 * "Sent" is not "received" is not "understood" is not "done": each is a separate transition with its own event.
 *
 *   requested -> accepted | rejected -> in_progress -> completed | failed | escalated   (cancelled by a person)
 *
 * The row is the business status. Where the process is right now (timers, retries) is Temporal's (handoffWorkflow);
 * what the agent is thinking is Pi's. Neither owns this status.
 */
export type HandoffStatus = "requested" | "accepted" | "rejected" | "in_progress" | "completed" | "failed" | "escalated" | "cancelled";
export type Handoff = {
	handoffId: string; requestId: string; channelId: string; taskId: string;
	from: string; to: string; backup: string | null; text: string; status: HandoffStatus;
	depth: number; parentHandoffId: string | null; originSub: string | null; correlationId: string; causationId: string | null;
	ackByAt: number | null; dueAt: number | null; requestedEventId: string | null; ackEventId: string | null; resultRef: string | null; reason: string | null;
	createdAt: number; updatedAt: number;
};

const ALLOWED: Record<HandoffStatus, HandoffStatus[]> = {
	requested: ["accepted", "rejected", "failed", "escalated", "cancelled", "in_progress", "completed"],
	accepted: ["in_progress", "completed", "failed", "escalated", "rejected", "cancelled"],
	in_progress: ["completed", "failed", "escalated", "cancelled"],
	rejected: ["escalated", "cancelled"],
	failed: ["escalated", "cancelled"],
	completed: [],
	escalated: [],
	cancelled: [],
};
export const ACTIVE: HandoffStatus[] = ["requested", "accepted", "in_progress"];
export const isActive = (s: HandoffStatus) => ACTIVE.includes(s);

export class HandoffError extends Error {
	status: 400 | 404 | 409 | 429;
	constructor(status: 400 | 404 | 409 | 429, message: string) {
		super(message);
		this.status = status;
	}
}

const row = (r: any): Handoff => ({
	handoffId: r.handoff_id, requestId: r.request_id, channelId: r.channel_id, taskId: r.task_id, from: r.from_actor, to: r.to_actor, backup: r.backup_actor, text: r.text,
	status: r.status, depth: r.depth, parentHandoffId: r.parent_handoff_id, originSub: r.origin_sub, correlationId: r.correlation_id, causationId: r.causation_id,
	ackByAt: r.ack_by_at, dueAt: r.due_at, requestedEventId: r.requested_event_id, ackEventId: r.ack_event_id, resultRef: r.result_ref, reason: r.reason,
	createdAt: r.created_at, updatedAt: r.updated_at,
});

export type RequestInput = {
	requestId: string;
	channelId: string;
	from: string;
	to: string;
	backup?: string | null;
	text: string;
	correlationId: string;
	causationId?: string;
	originSub?: string | null;
	/** Depth of the requester's own chain (0 = started by a person). The new handoff is one deeper. */
	requesterDepth?: number;
	parentHandoffId?: string | null;
	ackWithinMs?: number;
	dueInMs?: number;
	fromType?: "human" | "internal_agent" | "workflow" | "system";
	visibility?: `channel:${string}` | `owner:${string}`;
};

export class HandoffService {
	readonly db: DatabaseSync;
	readonly bus: EventBus;
	constructor(bus: EventBus, db: DatabaseSync = bus.db) {
		this.db = db;
		this.bus = bus;
	}

	get(id: string): Handoff | undefined {
		const r = this.db.prepare("SELECT * FROM handoffs WHERE handoff_id = ?").get(id);
		return r ? row(r) : undefined;
	}
	byRequest(requestId: string): Handoff | undefined {
		const r = this.db.prepare("SELECT * FROM handoffs WHERE request_id = ?").get(requestId);
		return r ? row(r) : undefined;
	}
	list(o: { channelId?: string; statuses?: HandoffStatus[]; limit?: number } = {}): Handoff[] {
		const where: string[] = [], args: any[] = [];
		if (o.channelId) { where.push("channel_id = ?"); args.push(o.channelId); }
		if (o.statuses?.length) { where.push(`status IN (${o.statuses.map(() => "?").join(",")})`); args.push(...o.statuses); }
		return (this.db.prepare(`SELECT * FROM handoffs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, o.limit ?? 200) as any[]).map(row);
	}
	/** Active handoffs a recipient has in a channel, oldest first. */
	activeFor(channelId: string, agent: string): Handoff[] {
		return (this.db.prepare(`SELECT * FROM handoffs WHERE channel_id = ? AND to_actor = ? AND status IN ('requested','accepted','in_progress') ORDER BY created_at, rowid`).all(channelId, agent) as any[]).map(row);
	}

	private checkLimits(o: RequestInput, now: number) {
		const l = config.limits;
		const depth = o.requesterDepth ?? 0;
		if (depth >= l.maxDelegationDepth) {
			throw new HandoffError(429, `delegation depth limit (${l.maxDelegationDepth}) reached. Do not ask other agents again: summarize what you found and what is blocked, and let a human decide.`);
		}
		const recent = (this.db.prepare("SELECT to_actor, text, status FROM handoffs WHERE channel_id = ? AND created_at > ?").all(o.channelId, now - 600_000) as any[]);
		const norm = (t: string) => t.trim().toLowerCase().slice(0, 160);
		if (recent.some((r) => r.to_actor === o.to && norm(r.text) === norm(o.text) && !["rejected", "failed", "cancelled"].includes(r.status))) {
			throw new HandoffError(409, `you (or someone) already asked @${o.to} the same thing recently; wait for the answer instead of repeating it.`);
		}
		if (recent.length >= l.delegationsPer10Min) throw new HandoffError(429, "delegation limit reached in this channel; ask a human to continue");
	}

	/** Idempotent on requestId: the same request twice is one handoff and one execution. */
	request(o: RequestInput, now = Date.now()): { handoff: Handoff; created: boolean } {
		const have = this.byRequest(o.requestId);
		if (have) return { handoff: have, created: false };
		this.checkLimits(o, now);
		return tx(this.db, () => {
			const taskId = newId("task"), handoffId = newId("hand");
			const dueAt = o.dueInMs ? now + o.dueInMs : null;
			const ackByAt = o.ackWithinMs ? now + o.ackWithinMs : null;
			this.db.prepare("INSERT INTO tasks (task_id, channel_id, title, owner, status, due_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(taskId, o.channelId, o.text.replace(/\s+/g, " ").slice(0, 120), o.to, "open", dueAt, o.from, now, now);
			this.db.prepare(
				`INSERT INTO handoffs (handoff_id, request_id, channel_id, task_id, from_actor, to_actor, backup_actor, text, status, depth, parent_handoff_id, origin_sub, correlation_id, causation_id, ack_by_at, due_at, created_at, updated_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			).run(handoffId, o.requestId, o.channelId, taskId, o.from, o.to, o.backup ?? null, o.text, "requested", (o.requesterDepth ?? 0) + 1, o.parentHandoffId ?? null, o.originSub ?? null, o.correlationId, o.causationId ?? null, ackByAt, dueAt, now, now);
			const ev = this.bus.emit({
				type: "handoff.requested", actorId: o.from, actorType: o.fromType ?? "internal_agent", correlationId: o.correlationId, causationId: o.causationId,
				visibility: o.visibility ?? `channel:${o.channelId}`, channelId: o.channelId, sourceRefs: [`task:${taskId}`],
				payload: { handoffId, taskId, to: o.to, backup: o.backup ?? null, ackByAt, dueAt, text: o.text.slice(0, 500) },
			});
			this.db.prepare("UPDATE handoffs SET requested_event_id = ? WHERE handoff_id = ?").run(ev.eventId, handoffId);
			return { handoff: this.get(handoffId)!, created: true };
		});
	}

	/**
	 * Moves a handoff to `to` if the state machine allows it, emitting `handoff.<to>`. A repeated or out-of-date signal
	 * (the run lifecycle can report the same thing twice) is a no-op and returns changed=false; `strict` turns an
	 * illegal move into an error for explicit actions by people.
	 */
	transition(id: string, to: HandoffStatus, o: { by: string; byType?: "human" | "internal_agent" | "system" | "workflow"; reason?: string; resultRef?: string; strict?: boolean; payload?: Record<string, unknown> }): { handoff: Handoff; changed: boolean } {
		return tx(this.db, () => {
			const h = this.get(id);
			if (!h) throw new HandoffError(404, "no such handoff");
			if (h.status === to) return { handoff: h, changed: false };
			if (!ALLOWED[h.status].includes(to)) {
				if (o.strict) throw new HandoffError(409, `a handoff that is ${h.status} cannot become ${to}`);
				return { handoff: h, changed: false };
			}
			const now = Date.now();
			const ev = this.bus.emit({
				type: `handoff.${to}`, actorId: o.by, actorType: o.byType ?? "system", correlationId: h.correlationId, causationId: h.requestedEventId ?? undefined,
				visibility: `channel:${h.channelId}`, channelId: h.channelId, sourceRefs: [`handoff:${h.handoffId}`, `task:${h.taskId}`],
				payload: { handoffId: h.handoffId, from: h.status, to, reason: o.reason ?? null, ...(o.payload ?? {}) },
			});
			this.db.prepare("UPDATE handoffs SET status = ?, reason = COALESCE(?, reason), result_ref = COALESCE(?, result_ref), ack_event_id = CASE WHEN ? = 'accepted' THEN ? ELSE ack_event_id END, updated_at = ? WHERE handoff_id = ?")
				.run(to, o.reason ?? null, o.resultRef ?? null, to, ev.eventId, now, id);
			if (to === "completed") this.db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE task_id = ?").run(now, h.taskId);
			if (to === "cancelled") this.db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE task_id = ?").run(now, h.taskId);
			return { handoff: this.get(id)!, changed: true };
		});
	}

	accept = (id: string, by: string) => this.transition(id, "accepted", { by, byType: "system" });
	start = (id: string, by: string) => this.transition(id, "in_progress", { by, byType: "system" });
	complete = (id: string, by: string, resultRef?: string) => this.transition(id, "completed", { by, byType: "system", resultRef });
	fail = (id: string, by: string, reason: string) => this.transition(id, "failed", { by, byType: "system", reason });
	reject = (id: string, by: string, reason: string, byType: "human" | "internal_agent" = "internal_agent") => this.transition(id, "rejected", { by, byType, reason, strict: true });
	cancel = (id: string, by: string, reason = "cancelled by a person") => this.transition(id, "cancelled", { by, byType: "human", reason, strict: true });

	/** Handoffs whose timer should have fired, for recovery and reports (Temporal is the timer; this is the ledger view). */
	overdue(now = Date.now()): Handoff[] {
		return (this.db.prepare("SELECT * FROM handoffs WHERE status IN ('requested','accepted','in_progress') AND ((status = 'requested' AND ack_by_at IS NOT NULL AND ack_by_at < ?) OR (due_at IS NOT NULL AND due_at < ?))").all(now, now) as any[]).map(row);
	}
}

// ---- who started the chain, kept in rows (replaces the in-memory depth map) --------------------------------------

export type Origin = { channelId: string; agentId: string; originSub: string | null; correlationId: string; depth: number; handoffId: string | null; updatedAt: number };

export function setOrigin(db: DatabaseSync, o: Omit<Origin, "updatedAt">) {
	db.prepare("INSERT OR REPLACE INTO conv_origin (channel_id, agent_id, origin_sub, correlation_id, depth, handoff_id, updated_at) VALUES (?,?,?,?,?,?,?)")
		.run(o.channelId, o.agentId, o.originSub, o.correlationId, o.depth, o.handoffId, Date.now());
}
export function getOrigin(db: DatabaseSync, channelId: string, agentId: string): Origin | undefined {
	const r = db.prepare("SELECT * FROM conv_origin WHERE channel_id = ? AND agent_id = ?").get(channelId, agentId) as any;
	return r ? { channelId: r.channel_id, agentId: r.agent_id, originSub: r.origin_sub, correlationId: r.correlation_id, depth: r.depth, handoffId: r.handoff_id, updatedAt: r.updated_at } : undefined;
}
export type { DomainEvent };
