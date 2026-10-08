import type { DatabaseSync } from "node:sqlite";
import { config } from "../config.ts";
import { EventBus, newId, tx } from "./events.ts";

/**
 * CaseContext: the shared, sourced picture of a case (a case is a channel). It is a projection over rows written through
 * this service, never a copy of anyone's private memory: a private chat can neither add to it nor read it.
 * It answers: what do we know and how sure are we, what was decided, who is waiting for whom, and what is nobody's.
 * It is a separate thing from `memo_note` (one agent's own notes): facts here carry sources and are visible to the whole case.
 */
export type Confidence = "confirmed" | "reported" | "inferred" | "unverified";
export type Fact = { factId: string; caseId: string; key: string; statement: string; sourceRefs: string[]; confidence: Confidence; status: "current" | "superseded" | "retracted"; supersedes: string | null; addedBy: string; observedAt: number; createdAt: number };
export type Decision = { decisionId: string; caseId: string; key: string; statement: string; outcome: string; madeBy: string; authorityRef: string | null; approvalId: number | null; state: string; createdAt: number };

export class CaseError extends Error {
	status: 400 | 403 | 404;
	constructor(status: 400 | 403 | 404, message: string) {
		super(message);
		this.status = status;
	}
}

const CONFIDENCE: Confidence[] = ["confirmed", "reported", "inferred", "unverified"];
const KEY = /^[a-z0-9][a-z0-9._:-]{1,59}$/;

const fact = (r: any): Fact => ({ factId: r.fact_id, caseId: r.case_id, key: r.fact_key, statement: r.statement, sourceRefs: JSON.parse(r.source_refs), confidence: r.confidence, status: r.status, supersedes: r.supersedes, addedBy: r.added_by, observedAt: r.observed_at, createdAt: r.created_at });
const decision = (r: any): Decision => ({ decisionId: r.decision_id, caseId: r.case_id, key: r.decision_key, statement: r.statement, outcome: r.outcome, madeBy: r.made_by, authorityRef: r.authority_ref, approvalId: r.approval_id, state: r.state, createdAt: r.created_at });

export class CaseService {
	readonly db: DatabaseSync;
	readonly bus: EventBus;
	/** Cases that are private chats: nothing is recorded in or read from them. */
	isPrivate: (caseId: string) => boolean;

	constructor(bus: EventBus, db: DatabaseSync = bus.db) {
		this.db = db;
		this.bus = bus;
		this.isPrivate = (caseId) => {
			const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channels'").get();
			return !!has && !!db.prepare("SELECT 1 FROM channels WHERE id = ? AND kind = 'dm'").get(caseId);
		};
	}

	private guard(caseId: string) {
		if (this.isPrivate(caseId)) throw new CaseError(403, "a private chat has no shared case picture");
	}

	addFact(o: { caseId: string; key: string; statement: string; sourceRefs: string[]; confidence: Confidence; by: string; byType?: "human" | "internal_agent" | "system"; supersedes?: string; observedAt?: number; correlationId?: string }): Fact {
		this.guard(o.caseId);
		if (!KEY.test(o.key)) throw new CaseError(400, "key must be a short lowercase topic such as checkout.pool_size (letters, digits, . _ : -)");
		const statement = o.statement.trim();
		if (statement.length < 3 || statement.length > 500) throw new CaseError(400, "statement must be 3-500 characters");
		if (!CONFIDENCE.includes(o.confidence)) throw new CaseError(400, `confidence must be one of ${CONFIDENCE.join(", ")}`);
		const sources = o.sourceRefs.map((s) => s.trim()).filter(Boolean).slice(0, 8);
		if (!sources.length) throw new CaseError(400, "a fact needs at least one source (a message, a tool result, a ticket, a person)");
		return tx(this.db, () => {
			const now = Date.now(), id = newId("fact");
			if (o.supersedes) {
				const old = this.db.prepare("SELECT * FROM case_facts WHERE fact_id = ? AND case_id = ?").get(o.supersedes, o.caseId) as any;
				if (!old) throw new CaseError(404, "the fact to supersede is not in this case");
				this.db.prepare("UPDATE case_facts SET status = 'superseded' WHERE fact_id = ?").run(o.supersedes);
			}
			const ev = this.bus.emit({ type: "fact.added", actorId: o.by, actorType: o.byType ?? "internal_agent", correlationId: o.correlationId ?? newId("corr"), visibility: `channel:${o.caseId}`, channelId: o.caseId, sourceRefs: sources, payload: { factId: id, key: o.key, confidence: o.confidence, supersedes: o.supersedes ?? null } });
			this.db.prepare("INSERT INTO case_facts (fact_id, case_id, fact_key, statement, source_refs, confidence, status, supersedes, added_by, observed_at, created_at, event_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
				.run(id, o.caseId, o.key, statement, JSON.stringify(sources), o.confidence, "current", o.supersedes ?? null, o.by, o.observedAt ?? now, now, ev.eventId);
			return fact(this.db.prepare("SELECT * FROM case_facts WHERE fact_id = ?").get(id));
		});
	}

	retractFact(caseId: string, factId: string, by: string, reason: string) {
		this.guard(caseId);
		return tx(this.db, () => {
			const r = this.db.prepare("UPDATE case_facts SET status = 'retracted' WHERE fact_id = ? AND case_id = ? AND status = 'current'").run(factId, caseId);
			if (!Number(r.changes)) throw new CaseError(404, "no current fact with that id in this case");
			this.bus.emit({ type: "fact.retracted", actorId: by, actorType: "human", correlationId: newId("corr"), visibility: `channel:${caseId}`, channelId: caseId, payload: { factId, reason: reason.slice(0, 300) } });
		});
	}

	recordDecision(o: { caseId: string; key: string; statement: string; outcome: string; madeBy: string; authorityRef?: string; approvalId?: number; correlationId?: string }): Decision {
		this.guard(o.caseId);
		return tx(this.db, () => {
			const id = newId("dec");
			const ev = this.bus.emit({ type: "decision.made", actorId: o.madeBy, actorType: "human", correlationId: o.correlationId ?? newId("corr"), visibility: `channel:${o.caseId}`, channelId: o.caseId, sourceRefs: o.approvalId ? [`approval:${o.approvalId}`] : [], payload: { decisionId: id, key: o.key, outcome: o.outcome } });
			this.db.prepare("INSERT INTO decisions (decision_id, case_id, decision_key, statement, outcome, made_by, authority_ref, approval_id, event_id, state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
				.run(id, o.caseId, o.key, o.statement.slice(0, 500), o.outcome, o.madeBy, o.authorityRef ?? null, o.approvalId ?? null, ev.eventId, "decided", Date.now());
			return decision(this.db.prepare("SELECT * FROM decisions WHERE decision_id = ?").get(id));
		});
	}

	/** The picture. Pure read; the caller has already checked that the viewer may see the channel. */
	context(caseId: string, now = Date.now()) {
		this.guard(caseId);
		const ttl = config.case.staleMs;
		const facts = (this.db.prepare("SELECT * FROM case_facts WHERE case_id = ? AND status = 'current' ORDER BY observed_at DESC").all(caseId) as any[]).map(fact);
		const stale = facts.filter((f) => now - f.observedAt > ttl);
		const fresh = facts.filter((f) => now - f.observedAt <= ttl);
		const byKey = new Map<string, Fact[]>();
		for (const f of fresh) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
		const conflicts = [...byKey.entries()].filter(([, fs]) => new Set(fs.map((f) => f.statement.toLowerCase())).size > 1).map(([key, fs]) => ({ key, facts: fs }));
		const inConflict = new Set(conflicts.flatMap((c) => c.facts.map((f) => f.factId)));
		const unverified = fresh.filter((f) => (f.confidence === "inferred" || f.confidence === "unverified") && !inConflict.has(f.factId));
		const decisions = (this.db.prepare("SELECT * FROM decisions WHERE case_id = ? ORDER BY created_at DESC LIMIT 100").all(caseId) as any[]).map(decision);
		const live = decisions.filter((d) => d.state === "decided" || d.state === "executed");
		const dk = new Map<string, Decision[]>();
		for (const d of live) dk.set(d.key, [...(dk.get(d.key) ?? []), d]);
		const conflictingDecisions = [...dk.entries()].filter(([, ds]) => new Set(ds.map((d) => d.outcome)).size > 1).map(([key, ds]) => ({ key, decisions: ds }));
		const tasks = this.db.prepare("SELECT * FROM tasks WHERE channel_id = ? AND status = 'open' ORDER BY created_at").all(caseId) as any[];
		const active = this.db.prepare("SELECT * FROM handoffs WHERE channel_id = ? AND status IN ('requested','accepted','in_progress') ORDER BY created_at").all(caseId) as any[];
		const activeTasks = new Set(active.map((h) => h.task_id));
		const openTasks = tasks.map((t) => ({ taskId: t.task_id, title: t.title, owner: t.owner as string | null, dueAt: t.due_at as number | null, overdue: !!t.due_at && t.due_at < now, hasActiveHandoff: activeTasks.has(t.task_id) }));
		return {
			caseId,
			responsible: openTasks.find((t) => t.owner)?.owner ?? null,
			facts: { current: fresh, stale, unverified },
			conflicts,
			decisions: { all: decisions, conflicting: conflictingDecisions },
			openTasks,
			orphanTasks: openTasks.filter((t) => !t.owner || !t.hasActiveHandoff),
			awaiting: active.map((h) => ({ handoffId: h.handoff_id, to: h.to_actor, from: h.from_actor, status: h.status as string, acknowledged: h.status !== "requested", dueAt: h.due_at as number | null, overdue: !!h.due_at && h.due_at < now, text: String(h.text).slice(0, 140) })),
		};
	}
}
