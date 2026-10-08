import { canSeeChannel } from "./channels.ts";
import { config } from "./config.ts";
import { db, store } from "./db.ts";

/**
 * Attention is the scarce thing this product spends. Every approval carries a cost in points
 * (a change to a live system costs more than a routine decision); a person's usage is the cost of what they decided
 * in the last 24 h, and the queue is the cost of what is waiting for them. The budget is a soft, visible limit.
 */
export const ATTENTION_COST = { decision: 5, liveChange: 8 } as const;

export function attentionFor(sub: string) {
	const spent = (db.prepare("SELECT COALESCE(SUM(attention_cost), 0) n FROM approvals WHERE decided_by_sub = ? AND decided_at > ?").get(sub, Date.now() - 86_400_000) as { n: number }).n;
	const waiting = store.listApprovals("pending").filter((a) => canSeeChannel(sub, a.channelId));
	const queued = waiting.reduce((n, a) => n + a.attentionCost, 0);
	const budget = config.attention.dailyBudget;
	return { spent24h: spent, queued, waiting: waiting.length, budget, over: spent + queued > budget };
}
