import { db } from "./db.ts";
import { AGENTS, SEED_CHANNELS, agentById, type AgentDef } from "./agents.ts";
import { createHash } from "node:crypto";
import { hub } from "./hub.ts";

export type Channel = {
	id: string;
	name: string;
	topic: string;
	/** standing = permanent room; issue = a case (ticket / incident) with an end. */
	kind: "standing" | "issue" | "dm";
	ticket: string | null;
	status: "open" | "archived";
	agents: string[];
	createdBy: string;
	createdAt: number;
	/** For private chats: the one user (sub) who can see it. */
	owner: string | null;
};

db.exec(`CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'standing',
  ticket TEXT, status TEXT NOT NULL DEFAULT 'open', agents TEXT NOT NULL DEFAULT '[]', created_by TEXT NOT NULL, created_at INTEGER NOT NULL)`);

try { db.exec("ALTER TABLE channels ADD COLUMN owner TEXT"); } catch { /* already there */ }

for (const c of SEED_CHANNELS) {
	db.prepare("INSERT OR IGNORE INTO channels (id, name, topic, kind, agents, created_by, created_at) VALUES (?,?,?,?,?,?,?)").run(
		c.id, c.name, c.topic, "standing", JSON.stringify(c.agents), "system", Date.now(),
	);
}

const row = (r: any): Channel => ({
	id: r.id, name: r.name, topic: r.topic, kind: r.kind, ticket: r.ticket, status: r.status,
	agents: JSON.parse(r.agents), createdBy: r.created_by, createdAt: r.created_at, owner: r.owner ?? null,
});

/** Visibility rule. Private chats belong to exactly one user; nobody else, admins included, sees them. */
export const canSeeChannel = (sub: string, channelId: string): boolean => {
	const c = channelById(channelId);
	return !!c && (c.kind !== "dm" || c.owner === sub);
};
hub.setVisibility(canSeeChannel, (sub) => listChannels(true, sub));

export const channelById = (id: string): Channel | undefined => {
	const r = db.prepare("SELECT * FROM channels WHERE id = ?").get(id);
	return r ? row(r) : undefined;
};

export function listChannels(includeArchived = false, forSub?: string): Channel[] {
	const rows = db.prepare("SELECT * FROM channels ORDER BY created_at ASC").all();
	return rows.map(row).filter((c) => (includeArchived || c.status === "open") && (forSub === undefined ? c.kind !== "dm" : c.kind !== "dm" || c.owner === forSub)).sort((a, b) => (a.kind === b.kind ? a.createdAt - b.createdAt : a.kind === "standing" ? -1 : 1));
}

export function agentsInChannel(channelId: string): AgentDef[] {
	const ch = channelById(channelId);
	return ch ? ch.agents.map(agentById).filter((a): a is AgentDef => !!a) : [];
}

/** @mentions in a message that name agents present in the channel. */
export function parseMentions(channelId: string, text: string): string[] {
	const present = new Set(agentsInChannel(channelId).map((a) => a.id));
	const found = new Set<string>();
	for (const m of text.matchAll(/@([a-zA-Z][\w-]*)/g)) {
		const id = m[1].toLowerCase();
		if (present.has(id)) found.add(id);
	}
	return [...found];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** Creates a channel, or returns the existing one with the same id (idempotent). */
export function createChannel(o: { name: string; topic: string; kind: Channel["kind"]; ticket?: string | null; agents?: string[]; createdBy: string }): { channel: Channel; created: boolean } {
	const id = slug(o.ticket ?? o.name);
	if (id.length < 2) throw new Error("channel name must have at least 2 letters or digits");
	const existing = channelById(id);
	if (existing) return { channel: existing, created: false };
	const agents = (o.agents?.length ? o.agents : AGENTS.map((a) => a.id)).filter((a) => !!agentById(a));
	db.prepare("INSERT INTO channels (id, name, topic, kind, ticket, agents, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)").run(
		id, id, o.topic.slice(0, 200), o.kind, o.ticket ?? null, JSON.stringify(agents), o.createdBy, Date.now(),
	);
	const channel = channelById(id)!;
	hub.publish({ type: "channels" });
	return { channel, created: true };
}

/** One private chat per (user, agent). Idempotent. */
export function createDm(o: { sub: string; userName: string; agentId: string }): { channel: Channel; created: boolean } {
	const agent = agentById(o.agentId);
	if (!agent) throw new Error(`no agent ${o.agentId}`);
	const id = `dm-${agent.id}-${createHash("sha1").update(o.sub).digest("hex").slice(0, 8)}`;
	const existing = channelById(id);
	if (existing) return { channel: existing, created: false };
	db.prepare("INSERT INTO channels (id, name, topic, kind, ticket, agents, created_by, created_at, owner) VALUES (?,?,?,?,?,?,?,?,?)").run(
		id, agent.name, `Private chat with ${agent.name}`, "dm", null, JSON.stringify([agent.id]), o.userName, Date.now(), o.sub,
	);
	const channel = channelById(id)!;
	hub.publish({ type: "channels" });
	return { channel, created: true };
}

export function setChannelStatus(id: string, status: Channel["status"]): Channel | undefined {
	if (channelById(id)?.kind !== "issue") return undefined; // standing rooms are permanent
	db.prepare("UPDATE channels SET status = ? WHERE id = ?").run(status, id);
	hub.publish({ type: "channels" });
	return channelById(id);
}
