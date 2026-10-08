import { db } from "./db.ts";

/**
 * Change feed behind resumable SSE. Each message/approval change gets a new global sequence number; an older row
 * for the same entity is replaced, so the feed stays small and a reconnecting client receives each changed entity once,
 * in its current state. Rows older than the retention window are pruned and a client behind that point is told to reload.
 */
export type FeedKind = "message" | "approval";
const KEEP = 5000;
let appends = 0;

export function recordChange(kind: FeedKind, refId: number, channelId: string): number {
	db.prepare("DELETE FROM change_feed WHERE kind = ? AND ref_id = ?").run(kind, refId);
	const r = db.prepare("INSERT INTO change_feed (kind, ref_id, channel_id, at) VALUES (?,?,?,?)").run(kind, refId, channelId, Date.now());
	const seq = Number(r.lastInsertRowid);
	if (++appends % 200 === 0) prune(seq);
	return seq;
}

export function prune(latest = latestSequence(), keep = KEEP) {
	const upto = latest - keep;
	if (upto <= 0) return;
	db.prepare("DELETE FROM change_feed WHERE sequence <= ?").run(upto);
	db.prepare("UPDATE change_feed_state SET pruned_upto = MAX(pruned_upto, ?) WHERE id = 1").run(upto);
}

export function latestSequence(): number {
	return ((db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'change_feed'").get() as { seq: number } | undefined)?.seq ?? 0) | 0;
}

/** Entities changed after `lastId`, or "reset" when the client is too far behind (or from another database). */
export function changesSince(lastId: number): { sequence: number; kind: FeedKind; refId: number; channelId: string }[] | "reset" {
	const pruned = (db.prepare("SELECT pruned_upto p FROM change_feed_state WHERE id = 1").get() as { p: number }).p;
	if (lastId < pruned || lastId > latestSequence()) return "reset";
	return (db.prepare("SELECT sequence, kind, ref_id, channel_id FROM change_feed WHERE sequence > ? ORDER BY sequence").all(lastId) as any[]).map((r) => ({
		sequence: r.sequence, kind: r.kind, refId: r.ref_id, channelId: r.channel_id,
	}));
}
