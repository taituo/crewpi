import { db } from "../db.ts";

/**
 * "Replay" here means reading what happened, in order, between two moments. It re-executes nothing and has no side
 * effects (a Temporal-style replay of a workflow, or a re-run of a synthetic world, is a different thing).
 */
export type HistoryEntry = { at: number; kind: "message" | "approval" | "decision" | "audit"; channel: string | null; actor: string; text: string; ref: string };

/** "2026-10-08T10:00", "now", "today", or relative "-90m" / "-2h" / "-3d". */
export function parseWhen(v: string | undefined, now = Date.now()): number | undefined {
	if (v === undefined || v === "") return undefined;
	if (v === "now") return now;
	if (v === "today") return new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
	const rel = /^-(\d+)([smhd])$/.exec(v);
	if (rel) return now - Number(rel[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[rel[2] as "s"];
	const t = Date.parse(v);
	if (Number.isNaN(t)) throw new Error(`cannot read "${v}" as a time (use ISO like 2026-10-08T10:00, today, now or -2h)`);
	return t;
}

export function history(o: { start?: number; end?: number; channel?: string; kinds?: string[]; includeDm?: boolean; limit?: number }): HistoryEntry[] {
	const lo = o.start ?? 0, hi = o.end ?? Number.MAX_SAFE_INTEGER;
	const out: HistoryEntry[] = [];
	const channel = o.channel?.replace(/^#/, "");
	// The channels table is created by the server on first start; on a fresh data directory there are no private chats yet.
	const hasChannels = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channels'").get();
	const dm = new Set(hasChannels ? (db.prepare("SELECT id FROM channels WHERE kind = 'dm'").all() as { id: string }[]).map((r) => r.id) : []);
	const visible = (c: string | null) => o.includeDm || !c || !dm.has(c);
	const want = (k: string) => !o.kinds?.length || o.kinds.includes(k);
	if (want("message")) {
		for (const r of db.prepare("SELECT id, channel_id c, author_kind k, author_name n, text, created_at t FROM messages WHERE created_at >= ? AND created_at <= ?" + (channel ? " AND channel_id = ?" : "") + " ORDER BY id").all(...(channel ? [lo, hi, channel] : [lo, hi])) as any[]) {
			if (visible(r.c)) out.push({ at: r.t, kind: "message", channel: r.c, actor: `${r.n} (${r.k})`, text: r.text.replace(/\s+/g, " ").slice(0, 400), ref: `message:${r.id}` });
		}
	}
	if (want("approval") || want("decision")) {
		for (const r of db.prepare("SELECT * FROM approvals WHERE (created_at >= ? AND created_at <= ?) OR (decided_at >= ? AND decided_at <= ?)").all(lo, hi, lo, hi) as any[]) {
			if (channel && r.channel_id !== channel) continue;
			if (!visible(r.channel_id)) continue;
			if (want("approval") && r.created_at >= lo && r.created_at <= hi) out.push({ at: r.created_at, kind: "approval", channel: r.channel_id, actor: `${r.agent_id} (agent)`, text: `asked: ${r.title}`, ref: `approval:${r.id}` });
			if (want("decision") && r.decided_at && r.decided_at >= lo && r.decided_at <= hi) out.push({ at: r.decided_at, kind: "decision", channel: r.channel_id, actor: r.decided_by ?? "?", text: `${r.status}: ${r.title}${r.note ? ` (${r.note})` : ""}`, ref: `approval:${r.id}` });
		}
	}
	if (want("audit") && !channel) {
		for (const r of db.prepare("SELECT id, at, actor, action, detail FROM audit WHERE at >= ? AND at <= ? ORDER BY id").all(lo, hi) as any[]) {
			const d = JSON.parse(r.detail);
			out.push({ at: r.at, kind: "audit", channel: typeof d.channel === "string" ? d.channel : null, actor: r.actor, text: `${r.action} ${Object.keys(d).length ? JSON.stringify(d).slice(0, 200) : ""}`.trim(), ref: `audit:${r.id}` });
		}
	}
	out.sort((a, b) => a.at - b.at || a.ref.localeCompare(b.ref));
	return o.limit ? out.slice(-o.limit) : out;
}

export const formatEntry = (e: HistoryEntry) => `${new Date(e.at).toISOString().replace("T", " ").slice(0, 19)}  ${(e.channel ? `#${e.channel}` : "-").padEnd(14)} ${e.kind.padEnd(8)} ${e.actor}: ${e.text}`;
