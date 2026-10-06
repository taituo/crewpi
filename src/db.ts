import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

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
	note: string | null;
	createdAt: number;
	decidedAt: number | null;
};

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(join(config.dataDir, "workspace.sqlite"));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id);
CREATE TABLE IF NOT EXISTS convs (
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  current_message INTEGER,
  PRIMARY KEY (channel_id, agent_id)
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  owner TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
`);

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
	note: r.note,
	createdAt: r.created_at,
	decidedAt: r.decided_at,
});

export const store = {
	addMessage(m: Omit<Message, "id" | "createdAt" | "updatedAt" | "meta"> & { meta?: Record<string, unknown> }): Message {
		const now = Date.now();
		const r = db
			.prepare(
				"INSERT INTO messages (channel_id, author_kind, author_id, author_name, text, meta, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
			)
			.run(m.channelId, m.authorKind, m.authorId, m.authorName, m.text, JSON.stringify(m.meta ?? {}), now, now);
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
	openApproval(a: { channelId: string; agentId: string; taskId: string; title: string; detail: Record<string, unknown> }): {
		approval: Approval;
		created: boolean;
	} {
		const existing = db.prepare("SELECT * FROM approvals WHERE task_id = ?").get(a.taskId);
		if (existing) return { approval: rowToApproval(existing), created: false };
		const r = db
			.prepare("INSERT INTO approvals (channel_id, agent_id, task_id, title, detail, created_at) VALUES (?,?,?,?,?,?)")
			.run(a.channelId, a.agentId, a.taskId, a.title, JSON.stringify(a.detail), Date.now());
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
	decideApproval(id: number, decision: "approved" | "rejected", by: string, note: string | null): Approval | undefined {
		const r = db
			.prepare("UPDATE approvals SET status = ?, decided_by = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
			.run(decision, by, note, Date.now(), id);
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
	audit(actor: string, action: string, detail: Record<string, unknown> = {}) {
		db.prepare("INSERT INTO audit (at, actor, action, detail) VALUES (?,?,?,?)").run(Date.now(), actor, action, JSON.stringify(detail));
	},
	listAudit(limit = 100) {
		return (db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit) as any[]).map((r) => ({
			id: r.id,
			at: r.at,
			actor: r.actor,
			action: r.action,
			detail: JSON.parse(r.detail),
		}));
	},
};
