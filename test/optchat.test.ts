import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-optchat-"));
const o = await import("../src/optchat.ts");

const fill = (conv: number, n: number, size = 400, start = 0) => {
	for (let i = start; i < start + n; i++) {
		const { idx, created } = o.addLeaf(conv, 1000 + i, i % 3 === 2 ? "tool" : i % 2 ? "assistant" : "user", `message ${i} ` + "lorem ipsum ".repeat(Math.ceil(size / 12)), 1_700_000_000_000 + i * 60_000);
		if (created) o.builder.onLeaf(conv, idx);
	}
};

test("leaves are idempotent per entry and tool output is described, not copied", () => {
	const a = o.addLeaf(1, 5, "tool", "x".repeat(3000));
	assert.deepEqual(a, { idx: 0, created: true });
	assert.deepEqual(o.addLeaf(1, 5, "tool", "again"), { idx: 0, created: false });
	assert.equal(o.leafCount(1), 1);
	const view = o.fitView(1, 0, 10_000);
	assert.ok(view[0].text.length < 260 && view[0].text.startsWith("tool result:"));
	assert.ok(o.zoom(1, "#0.0").length > 2500, "zoom still returns the original text");
});

test("builder cascades summaries up the tree with an LLM-style summariser", async () => {
	o.builder.summarize = async (texts, level) => `L${level}(${texts.length}) ` + texts.map((t) => t.slice(0, 12)).join("|");
	o.builder.gapMs = 0;
	o.builder.recentVerbatim = 0;
	fill(2, 16);
	await o.builder.idle();
	const s = o.stats(2);
	assert.equal(s.leaves, 16);
	assert.equal(s.nodes, 8 + 4 + 2 + 1, "every block of a perfect tree got a node");
	// Level-1 lines are model-written (two 400-byte messages do not fit one line); the lines above them are short enough
	// to be joined for free, so they cost no model call.
	assert.equal(s.llmNodes, 8);
});

test("recent messages need no summary yet, so idle history is not summarised eagerly", async () => {
	o.builder.summarize = async () => "should not be called";
	o.builder.recentVerbatim = 16;
	fill(7, 16);
	await o.builder.idle();
	assert.equal(o.stats(7).nodes, 0, "16 leaves, all within the verbatim tail");
	fill(7, 16, 400, 16);
	await o.builder.idle();
	assert.ok(o.stats(7).nodes >= 1, "once older than the tail, blocks get summarised");
});

test("view covers all history exactly once, fits the budget, keeps recent verbatim and old coarse", async () => {
	o.builder.summarize = async (texts) => "sum " + texts.map((t) => t.slice(0, 20)).join(" / ");
	o.builder.recentVerbatim = 0;
	fill(3, 64);
	await o.builder.idle();
	const budget = 5000;
	const segs = o.fitView(3, 63, budget);
	const bytes = segs.reduce((n, s) => n + Buffer.byteLength(s.text) + 22, 0);
	assert.ok(bytes <= budget, `fits (${bytes} <= ${budget})`);
	let next = 0;
	for (const s of segs) { assert.equal(s.lo, next, "contiguous, no gaps or overlaps"); next = s.hi + 1; }
	assert.equal(next, 64, "covers every message");
	assert.ok(segs.length < 40, "older history was merged");
	assert.equal(segs[segs.length - 1].level, 0, "newest message verbatim");
	assert.ok(segs.slice(-4).every((s) => s.level === 0), "recent messages are individual");
	assert.ok(segs[0].level >= 2, "oldest history is the coarsest");
	for (let i = 1; i < segs.length; i++) assert.ok(segs[i].level <= segs[i - 1].level + 1 || segs[i].level === 0);
});

test("the early part of the view is stable when messages are appended (prompt-cache friendly)", async () => {
	o.builder.recentVerbatim = 0;
	fill(4, 64);
	await o.builder.idle();
	const before = o.fitView(4, 63, 5000).slice(0, 3).map((s) => `${s.level}.${s.idx}`);
	fill(4, 2, 400, 64);
	await o.builder.idle();
	const after = o.fitView(4, 65, 5000).slice(0, 3).map((s) => `${s.level}.${s.idx}`);
	assert.deepEqual(after, before);
});

test("without any summariser the view still works (extractive fallback) and zoom navigates down", () => {
	o.builder.summarize = undefined;
	fill(5, 32);
	const segs = o.fitView(5, 31, 4000);
	assert.ok(segs.reduce((n, s) => n + Buffer.byteLength(s.text) + 22, 0) <= 4000);
	const top = segs[0];
	const z = o.zoom(5, `#${top.level}.${top.idx}`);
	assert.match(z, /Finer detail:/);
	assert.match(z, /\d+\+\d+\|/);
	assert.throws(() => o.zoom(5, "nonsense"), /must look like/);
	assert.throws(() => o.zoom(5, "#0.999"), /no such line/);
	assert.equal(o.zoom(5, `${top.lo}+${top.hi - top.lo + 1}`), z, "the id+n form of the same line gives the same answer");
	const text = o.renderView(5, segs);
	assert.ok(text.startsWith(o.VIEW_MARKER) && /DATA about the past/.test(text) && /\n\d+\+\d+\|/.test(text));
});

test("a tiny budget degrades gracefully instead of failing", () => {
	fill(6, 40);
	const segs = o.fitView(6, 39, 500);
	assert.ok(segs.length >= 1 && segs.at(-1)!.hi === 39);
	assert.ok(segs.reduce((n, s) => n + Buffer.byteLength(s.text) + 22, 0) <= 1200);
});

// Taelin's rollback push (rollback_state_list.js), the reference the UniiChat spec derives the merge order from.
type PushList = { keep: number; life: number; state: number; older: PushList | null } | null;
function push(s: number, states: PushList): PushList {
	if (states === null) return { keep: 0, life: 0, state: s, older: null };
	const { keep, life, state, older } = states;
	if (keep === 0) return { keep: 1, life, state, older };
	if (life > 0) return { keep: 0, life: 0, state: s, older: { keep: 0, life: life - 1, state, older } };
	return { keep: 0, life, state: s, older: push(state, older) };
}
const startsOf = (l: PushList) => { const a: number[] = []; for (; l; l = l.older) a.push(l.state); return a.sort((x, y) => x - y); };

test("the merge order is Taelin's push: with a line budget the view equals his list at every step", () => {
	type S = { level: number; idx: number; lo: number; hi: number };
	const viewOf = (T: number, lines: number) => {
		let segs: S[] = Array.from({ length: T }, (_, i) => ({ level: 0, idx: i, lo: i, hi: i }));
		while (segs.length > lines) {
			let best = -1, bs = -1;
			for (let i = 0; i < segs.length - 1; i++) {
				const a = segs[i], b = segs[i + 1];
				if (a.level !== b.level || a.idx % 2 !== 0 || b.idx !== a.idx + 1) continue;
				const sc = o.due(T, b.hi, a.level);
				if (sc > bs) { bs = sc; best = i; }
			}
			const a = segs[best], b = segs[best + 1];
			segs = [...segs.slice(0, best), { level: a.level + 1, idx: a.idx / 2, lo: a.lo, hi: b.hi }, ...segs.slice(best + 2)];
		}
		return segs.map((s) => s.lo);
	};
	let list: PushList = null;
	for (let t = 0; t < 300; t++) {
		list = push(t, list);
		const want = startsOf(list);
		assert.deepEqual(viewOf(t + 1, want.length), want, `t=${t}`);
	}
});

// ---- UniiChat spec: free nodes, id+n addressing, size retries ------------------------------------------------

test("free nodes: lines that fit together are joined with a newline, with no model call", async () => {
	const conv = 910;
	o.builder.recentVerbatim = 16; // the builder is shared by all tests in this file
	const levels: number[] = [];
	o.builder.summarize = async (_t, level) => { levels.push(level); return "summary"; }; // set first: filling already starts the builder
	fill(conv, 40, 30); // ~46-byte messages: 2 -> ~92, 4 -> ~190, 8 -> ~380 bytes still fit one line; 16 -> ~760 do not
	o.builder.backfill(conv);
	await o.builder.idle();
	assert.ok(levels.length > 0 && levels.every((l) => l >= 4), `only lines that no longer fit were summarized (levels called: ${[...new Set(levels)]})`);
	const a = o.nodeText(conv, 0, 0, false)!, b = o.nodeText(conv, 0, 1, false)!;
	assert.equal(o.nodeText(conv, 1, 0, false), `${a}\n${b}`);
	assert.equal(o.nodeText(conv, 2, 0, false), `${o.nodeText(conv, 1, 0, false)}\n${o.nodeText(conv, 1, 1, false)}`);
	const st = o.stats(conv);
	assert.ok(st.nodes > st.llmNodes, "free nodes are built but not counted as model-written");
});

test("a merge whose lines do not fit still goes to the summariser", async () => {
	const conv = 911;
	o.builder.recentVerbatim = 16; // the builder is shared by all tests in this file
	let calls = 0;
	o.builder.summarize = async () => { calls++; return "merged"; };
	fill(conv, 40, 400);
	o.builder.backfill(conv);
	await o.builder.idle();
	assert.ok(calls > 0);
});

test("id+n addressing: the view shows message ids and spans, and zoom accepts both forms", () => {
	const conv = 912;
	fill(conv, 20, 300);
	o.builder.summarize = undefined;
	const view = o.renderView(conv, o.fitView(conv, 19, 2500));
	const lines = view.split("\n").filter((l) => /^\d+\+\d+\|/.test(l));
	assert.ok(lines.length >= 3, "lines look like 8+4|text");
	assert.ok(!/#\d+\.\d+/.test(view), "no tree coordinates in the view");
	assert.equal(o.zoom(conv, "4+4"), o.zoom(conv, "#2.1"), "id+n and the old form are the same line");
	assert.match(o.zoom(conv, "4+4"), /(^|\n)\s*(4\+2|6\+2)\|/, "children are shown in the same form");
	assert.match(o.zoom(conv, "7+1"), /message 7/, "n = 1 gives the message whole");
	for (const bad of ["5+4", "4+3", "4+0", "24+8", "x+4"]) assert.throws(() => o.zoom(conv, bad), /no line|no such line|must look like/, bad);
});

test("a line that is too long is retried with the cut marker, up to 5 times, keeping the shortest", async () => {
	const conv = 913;
	o.builder.recentVerbatim = 16; // the builder is shared by all tests in this file
	const seen: (undefined | { previous: string; cut: string })[] = [];
	o.builder.summarize = async (_t, _l, retry) => { seen.push(retry); return retry ? "short enough" : "x".repeat(900); };
	fill(conv, 40, 400);
	o.builder.backfill(conv);
	await o.builder.idle();
	assert.equal(seen[0], undefined, "the first try carries no retry info");
	const first = seen.findIndex((r) => r !== undefined);
	assert.ok(first > 0, "a too-long answer triggers a retry");
	assert.equal(seen[first]!.previous.length, 900);
	assert.equal(Buffer.byteLength(seen[first]!.cut), o.NODE_BYTES, "the cut is the first NODE bytes of the long line");
	assert.equal(o.nodeText(conv, 1, 0, false), "short enough");
});

test("when every retry is too long the shortest answer wins and there are at most 5 tries per line", async () => {
	const conv = 914;
	o.builder.recentVerbatim = 16; // the builder is shared by all tests in this file
	let calls = 0;
	o.builder.gapMs = 0;
	o.builder.summarize = async () => "y".repeat(Math.max(1000, 2000 - ++calls * 100)); // always over the limit, shrinking slowly
	fill(conv, 18, 400); // one level-1 line is due (18 leaves, the newest 16 stay verbatim)
	o.builder.backfill(conv);
	await o.builder.idle();
	assert.equal(calls, 5, "exactly the allowed number of tries");
	const node = o.nodeText(conv, 1, 0, false)!;
	assert.ok(Buffer.byteLength(node) <= o.NODE_BYTES + 40, "bounded by the safety clip");
	assert.ok(node.startsWith("y"), "a line was still produced and used");
});
