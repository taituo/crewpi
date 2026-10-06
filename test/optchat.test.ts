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
	assert.equal(s.llmNodes, 15);
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
	assert.match(z, /#\d+\.\d+/);
	assert.throws(() => o.zoom(5, "nonsense"), /must look like/);
	assert.throws(() => o.zoom(5, "#0.999"), /no such line/);
	const text = o.renderView(5, segs);
	assert.ok(text.startsWith(o.VIEW_MARKER) && /DATA about the past/.test(text) && /#\d\.\d/.test(text));
});

test("a tiny budget degrades gracefully instead of failing", () => {
	fill(6, 40);
	const segs = o.fitView(6, 39, 500);
	assert.ok(segs.length >= 1 && segs.at(-1)!.hi === 39);
	assert.ok(segs.reduce((n, s) => n + Buffer.byteLength(s.text) + 22, 0) <= 1200);
});
