import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";

export type Message = {
	id: number;
	channelId: string;
	authorKind: "human" | "agent" | "system";
	authorId: string;
	authorName: string;
	text: string;
	meta: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	tenantId: string;
	organizationId: string;
	/** Server-resolved actor (human sub, agent id, "system"); null on rows from before provenance existed. */
	actorId: string | null;
	actorType: "human" | "internal_agent" | "system" | null;
	source: "live" | "demo" | "synthetic";
};

export type Approval = {
	id: number;
	channelId: string;
	agentId: string;
	taskId: string;
	title: string;
	detail: Record<string, unknown>;
	status: "pending" | "approved" | "rejected";
	decidedBy: string | null;
	/** Stable subject of the decider; decidedBy is only the display name at the time. */
	decidedBySub: string | null;
	requestedBySub: string | null;
	/** Points this decision costs the human who makes it (see attention.ts). */
	attentionCost: number;
	note: string | null;
	createdAt: number;
	decidedAt: number | null;
};

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(join(config.dataDir, "workspace.sqlite"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
migrate(db, MIGRATIONS);

const rowToMessage = (r: any): Message => ({
	id: r.id,
	channelId: r.channel_id,
	authorKind: r.author_kind,
	authorId: r.author_id,
	authorName: r.author_name,
	text: r.text,
	meta: JSON.parse(r.meta),
	createdAt: r.created_at,
	updatedAt: r.updated_at,
	tenantId: r.tenant_id,
	organizationId: r.organization_id,
	actorId: r.actor_id ?? null,
	actorType: r.actor_type ?? null,
	source: r.source,
});

const rowToApproval = (r: any): Approval => ({
	id: r.id,
	channelId: r.channel_id,
	agentId: r.agent_id,
	taskId: r.task_id,
	title: r.title,
	detail: JSON.parse(r.detail),
	status: r.status,
	decidedBy: r.decided_by,
	decidedBySub: r.decided_by_sub ?? null,
	requestedBySub: r.requested_by_sub ?? null,
	attentionCost: r.attention_cost ?? 5,
	note: r.note,
	createdAt: r.created_at,
	decidedAt: r.decided_at,
});

const ACTOR_TYPE = { human: "human", agent: "internal_agent", system: "system" } as const;

export const store = {
	addMessage(m: Omit<Message, "id" | "createdAt" | "updatedAt" | "meta" | "tenantId" | "organizationId" | "actorId" | "actorType" | "source"> & { meta?: Record<string, unknown> }): Message {
		const now = Date.now();
		const r = db
			.prepare(
				"INSERT INTO messages (channel_id, author_kind, author_id, author_name, text, meta, created_at, updated_at, actor_id, actor_type) VALUES (?,?,?,?,?,?,?,?,?,?)",
			)
			.run(m.channelId, m.authorKind, m.authorId, m.authorName, m.text, JSON.stringify(m.meta ?? {}), now, now, m.authorId, ACTOR_TYPE[m.authorKind]);
		return this.getMessage(Number(r.lastInsertRowid))!;
	},
	updateMessage(id: number, patch: { text?: string; meta?: Record<string, unknown> }): Message | undefined {
		const cur = this.getMessage(id);
		if (!cur) return undefined;
		db.prepare("UPDATE messages SET text = ?, meta = ?, updated_at = ? WHERE id = ?").run(
			patch.text ?? cur.text,
			JSON.stringify(patch.meta ?? cur.meta),
			Date.now(),
			id,
		);
		return this.getMessage(id);
	},
	hasMessageForRequest(requestId: string): boolean {
		return !!db.prepare("SELECT 1 FROM messages WHERE meta LIKE ? LIMIT 1").get(`%"requestId":${JSON.stringify(requestId)}%`);
	},
	getMessage(id: number): Message | undefined {
		const r = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
		return r ? rowToMessage(r) : undefined;
	},
	listMessages(channelId: string, limit = 200): Message[] {
		const rows = db
			.prepare("SELECT * FROM (SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC")
			.all(channelId, limit);
		return rows.map(rowToMessage);
	},

	getConv(channelId: string, agentId: string): { conversationId: string; currentMessage: number | null } | undefined {
		const r = db.prepare("SELECT * FROM convs WHERE channel_id = ? AND agent_id = ?").get(channelId, agentId) as any;
		return r ? { conversationId: r.conversation_id, currentMessage: r.current_message } : undefined;
	},
	setConv(channelId: string, agentId: string, conversationId: string) {
		db.prepare("INSERT OR REPLACE INTO convs (channel_id, agent_id, conversation_id, current_message) VALUES (?,?,?,NULL)").run(
			channelId,
			agentId,
			conversationId,
		);
	},
	setCurrentMessage(channelId: string, agentId: string, messageId: number | null) {
		db.prepare("UPDATE convs SET current_message = ? WHERE channel_id = ? AND agent_id = ?").run(messageId, channelId, agentId);
	},
	allConvs(): { channelId: string; agentId: string; conversationId: string }[] {
		return (db.prepare("SELECT * FROM convs").all() as any[]).map((r) => ({
			channelId: r.channel_id,
			agentId: r.agent_id,
			conversationId: r.conversation_id,
		}));
	},

	/** Idempotent per tool task so a replayed tool finds the approval it already opened. */
	openApproval(a: { channelId: string; agentId: string; taskId: string; title: string; detail: Record<string, unknown>; requestedBySub?: string; attentionCost?: number }): {
		approval: Approval;
		created: boolean;
	} {
		const existing = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(a.taskId);
		if (existing) return { approval: rowToApproval(existing), created: false };
		const r = db
			.prepare("INSERT INTO approvals (channel_id, agent_id, task_id, title, detail, created_at, requested_by_sub, attention_cost) VALUES (?,?,?,?,?,?,?,?)")
			.run(a.channelId, a.agentId, a.taskId, a.title, JSON.stringify(a.detail), Date.now(), a.requestedBySub ?? null, a.attentionCost ?? 5);
		return { approval: this.getApproval(Number(r.lastInsertRowid))!, created: true };
	},
	getApproval(id: number): Approval | undefined {
		const r = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
		return r ? rowToApproval(r) : undefined;
	},
	listApprovals(status?: Approval["status"]): Approval[] {
		const rows = status
			? db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY id DESC LIMIT 100").all(status)
			: db.prepare("SELECT * FROM approvals ORDER BY id DESC LIMIT 100").all();
		return rows.map(rowToApproval);
	},
	patchApprovalDetail(id: number, patch: Record<string, unknown>) {
		const cur = this.getApproval(id);
		if (!cur) return;
		db.prepare("UPDATE approvals SET detail = ? WHERE id = ?").run(JSON.stringify({ ...cur.detail, ...patch }), id);
	},
	/** Returns undefined if already decided (first decision wins). */
	decideApproval(id: number, decision: "approved" | "rejected", by: string, note: string | null, bySub?: string): Approval | undefined {
		const r = db
			.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_by_sub = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
			.run(decision, by, bySub ?? null, note, Date.now(), id);
		if (Number(r.changes) === 0) return undefined;
		return this.getApproval(id);
	},

	addAttachment(a: { id: string; channelId: string; name: string; mime: string; size: number; owner: string }) {
		db.prepare("INSERT OR IGNORE INTO attachments (id, channel_id, name, mime, size, owner, created_at) VALUES (?,?,?,?,?,?,?)").run(a.id, a.channelId, a.name, a.mime, a.size, a.owner, Date.now());
	},
	getAttachment(id: string, channelId?: string): { id: string; channelId: string; name: string; mime: string; size: number; owner: string } | undefined {
		const r = db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as any;
		if (!r || (channelId && r.channel_id !== channelId)) return undefined;
		return { id: r.id, channelId: r.channel_id, name: r.name, mime: r.mime, size: r.size, owner: r.owner };
	},
	audit(actor: string, action: string, detail: Record<string, unknown> = {}, actorId?: string) {
		db.prepare("INSERT INTO audit (at, actor, action, detail, actor_id) VALUES (?,?,?,?,?)").run(Date.now(), actor, action, JSON.stringify(detail), actorId ?? null);
	},
	listAudit(limit = 100) {
		return (db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit) as any[]).map((r) => ({
			id: r.id,
			at: r.at,
			actor: r.actor,
			actorId: r.actor_id ?? null,
			action: r.action,
			detail: JSON.parse(r.detail),
		}));
	},
};
