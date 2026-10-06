import { config } from "./config.ts";

/**
 * Spend guard for OpenRouter. The key itself has a hard credit limit set at OpenRouter; on top of it we keep a lower
 * soft cap and stop sending work to OpenRouter models when the key's usage reaches it. Usage comes from OpenRouter's
 * own accounting (GET /api/v1/key), refreshed at most every 20 s and before each dispatch when stale.
 */

type Snapshot = { usage: number; limit: number | null; remaining: number | null; at: number };
let snap: Snapshot | undefined;
let inflight: Promise<void> | undefined;

export const budgetEnabled = () => !!config.inference.openrouterKey;

async function refresh(): Promise<void> {
	try {
		const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${config.inference.openrouterKey}` }, signal: AbortSignal.timeout(8000) });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const d = ((await r.json()) as any).data ?? {};
		snap = { usage: Number(d.usage ?? 0), limit: d.limit == null ? null : Number(d.limit), remaining: d.limit_remaining == null ? null : Number(d.limit_remaining), at: Date.now() };
	} catch (e) {
		console.warn(`[budget] refresh failed: ${(e as Error).message}`);
	}
}

export async function ensureFresh(maxAgeMs = 20_000) {
	if (!budgetEnabled()) return;
	if (!snap || Date.now() - snap.at > maxAgeMs) {
		inflight ??= refresh().finally(() => (inflight = undefined));
		await inflight;
	}
}

export function budgetState() {
	if (!budgetEnabled()) return undefined;
	const cap = config.inference.openrouterBudget;
	const spent = snap?.usage ?? 0;
	return {
		provider: "openrouter",
		spent: Math.round(spent * 10000) / 10000,
		softCap: cap,
		hardLimit: snap?.limit ?? null,
		blocked: spent >= cap || (snap?.remaining != null && snap.remaining <= 0.25),
		known: !!snap,
	};
}

/** Throws when OpenRouter work must not start. Unknown usage (API down) does not block: the hard limit still protects. */
export async function assertBudget() {
	if (!budgetEnabled()) return;
	await ensureFresh();
	const s = budgetState()!;
	if (s.blocked) throw new Error(`OpenRouter budget reached ($${s.spent.toFixed(2)} of the $${s.softCap.toFixed(2)} cap). An admin can raise OPENROUTER_BUDGET_USD.`);
}

export function startBudgetWatch() {
	if (!budgetEnabled()) return;
	void refresh();
	setInterval(() => void refresh(), 45_000).unref();
}
