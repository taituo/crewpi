// Needle in a haystack for the memory tree. Plants a few facts in a long synthetic chat, builds the tree with a real model, then asks:
//   1. is the fact still readable in the view the agent gets?
//   2. how high up the tree does it survive (a fact that dies at level 1 can never be found by zooming)?
//   3. given only the view, does the model pick a line to open that really covers the fact?
// Usage: OPENCODE_API_KEY=... NODE_USE_ENV_PROXY=1 node scripts/needle.ts [model] [messages] [viewBytes]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-needle-"));
const o = await import("../src/optchat.ts");
const { createModels } = await import("@earendil-works/pi-ai");
const { opencodeGoProvider } = await import("@earendil-works/pi-ai/providers/opencode-go");

const modelId = process.argv[2] ?? "deepseek-v4-flash";
const N = Number(process.argv[3] ?? 120);
const VIEW = Number(process.argv[4] ?? 6000);
const models = createModels();
models.setProvider(opencodeGoProvider());
const model = models.getModel("opencode-go", modelId);
if (!model) throw new Error(`model ${modelId} not available`);
const textOf = (c: any): string => (typeof c === "string" ? c : (c ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join(""));

// ---- the haystack: seeded, varied operations chatter
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const svc = ["checkout-api", "billing", "search-index", "auth-gw", "mailer", "report-batch", "cdn-edge", "queue-worker"];
const filler = [
	() => `${pick(svc)} p95 latency went from ${100 + Math.floor(rnd() * 200)}ms to ${300 + Math.floor(rnd() * 900)}ms after the ${pick(["deploy", "cache flush", "config change", "node drain"])}; checking ${pick(["pool size", "slow queries", "GC pauses", "retry storms"])}.`,
	() => `Ticket OPS-${1000 + Math.floor(rnd() * 8000)} is about ${pick(svc)} ${pick(["flapping alerts", "disk at 85%", "certificate renewal", "noisy logs", "missing runbook"])}; I will ${pick(["watch it until morning", "ask the owner", "raise the threshold", "close it as duplicate"])}.`,
	() => `PR #${100 + Math.floor(rnd() * 900)} touches ${pick(svc)}: ${pick(["renames a metric", "bumps a library", "changes a timeout", "adds a feature flag"])}. Review says ${pick(["looks fine", "needs a test", "split it up", "wait for the freeze"])}.`,
	() => `Reminder: the ${pick(["Tuesday", "Thursday", "Friday"])} change window for ${pick(svc)} is ${pick(["moved", "cancelled", "shortened"])} because of ${pick(["a holiday", "an audit", "the migration", "staffing"])}.`,
];
const needles = [
	{ at: Math.floor(N * 0.1), fact: "Decision: the nightly invoice export for customer Kallio Oy must never run before 02:40 UTC, because their ERP locks the ledger until then (ref LEDGER-7731).", key: "LEDGER-7731", question: "Why must the invoice export for Kallio Oy not run early, and what is the reference?" },
	{ at: Math.floor(N * 0.45), fact: "Root cause of INC-48213: an expired intermediate certificate on host ldap-sync-03; the fix was to reissue it with the 90 day profile.", key: "INC-48213", question: "What was the root cause of incident INC-48213?" },
	{ at: Math.floor(N * 0.7), fact: "Approved by Marja: the spare database failover may be tested only on the first Sunday of a month, with the ticket CHG-5520 open.", key: "CHG-5520", question: "When may the spare database failover be tested, and under which change ticket?" },
];

const conv = 1;
o.builder.recentVerbatim = 16;
o.builder.gapMs = 0;
o.builder.log = (m) => console.warn(`  [memtree] ${m}`);
let calls = 0;
o.builder.summarize = async (texts, level, retry, ctx) => {
	const n = ++calls, t = Date.now();
	const again = retry ? `\n\nYour previous line was ${Buffer.byteLength(retry.previous)} bytes, over the limit of ${o.NODE_BYTES}. Write the whole line again for the same chunks, cutting just enough of the least valuable items so that it ends before this cut:\n${retry.cut}| ← LIMIT` : "";
	const msg = await models.complete(model, { systemPrompt: o.SUMMARY_SYSTEM, messages: [{ role: "user", content: o.summaryPrompt(texts, level, ctx) + again, timestamp: Date.now() }] }, { sessionId: "crew-needle", signal: AbortSignal.timeout(90_000) });
	if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage ?? "summarizer error");
	const out = textOf(msg.content).trim();
	console.log(`  call ${n} level ${level}${retry ? " (retry)" : ""}: ${Date.now() - t}ms, ${Buffer.byteLength(out)} bytes`);
	return out;
};

for (let i = 0; i < N; i++) {
	const needle = needles.find((n) => n.at === i);
	const role = i % 2 ? "assistant" : "user";
	const text = needle ? needle.fact : `${filler[Math.floor(rnd() * filler.length)]()} ${filler[Math.floor(rnd() * filler.length)]()}`;
	const { idx, created } = o.addLeaf(conv, 100 + i, role, text, 1_700_000_000_000 + i * 90_000);
	if (created) o.builder.onLeaf(conv, idx);
}
const t0 = Date.now();
o.builder.backfill(conv);
await o.builder.idle();
const st = o.stats(conv);
console.log(`model ${modelId}: ${N} messages, tree ${st.nodes} nodes (${st.llmNodes} model-made), ${calls} model calls, ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const view = o.fitView(conv, N - 1, VIEW);
const viewText = o.renderView(conv, view);
console.log(`view: ${view.length} lines, ${Buffer.byteLength(viewText)} bytes (budget ${VIEW})\n`);

const rows: string[] = [];
for (const n of needles) {
	const inView = view.some((s) => s.text.includes(n.key));
	// highest level of the chain of ancestors that still contains the key
	let top = 0;
	for (let level = 1; 2 ** level <= N; level++) {
		const t = o.nodeText(conv, level, Math.floor(n.at / 2 ** level), false);
		if (t?.includes(n.key)) top = level; else break;
	}
	const maxLevel = Math.floor(Math.log2(N));
	const line = view.find((s) => s.lo <= n.at && n.at <= s.hi)!;
	const msg = await models.complete(model, {
		systemPrompt: "You are an agent with a compressed memory of a long chat. Reply with ONLY the id of the memory line (like 40+8) you would open with memory_zoom to find the answer. Nothing else.",
		messages: [{ role: "user", content: `${viewText}\n\nQuestion to answer from the old conversation: ${n.question}`, timestamp: Date.now() }],
	}, { sessionId: "crew-needle" });
	const picked = textOf(msg.content).match(/(\d+)\+(\d+)/);
	const covers = picked ? Number(picked[1]) <= n.at && n.at < Number(picked[1]) + Number(picked[2]) : false;
	rows.push(`${n.key.padEnd(12)} message ${String(n.at).padStart(3)}  in view: ${inView ? "yes" : "no "}  survives to level ${top}/${maxLevel}  line holding it: ${line.lo}+${line.hi - line.lo + 1}  model picked: ${picked?.[0] ?? "(none)"} -> ${covers ? "right line" : "WRONG line"}`);
}
console.log(rows.join("\n"));
