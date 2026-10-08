import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, DEFAULT_POLICY, type WorkItem } from "../src/policy.ts";
import { generateWork, routeAll } from "../src/workitems.ts";

const base: WorkItem = { id: "x", kind: "customer_message", risk: "low", costUsd: 0.01, confidence: 0.9, writes: false };

test("routine low-risk work is allowed", () => {
	assert.equal(decide(DEFAULT_POLICY, base).verdict, "allow");
});

test("writes, high risk, low confidence and unknown kinds go to a person", () => {
	assert.equal(decide(DEFAULT_POLICY, { ...base, writes: true }).verdict, "escalate");
	assert.equal(decide(DEFAULT_POLICY, { ...base, risk: "high" }).verdict, "escalate");
	assert.equal(decide(DEFAULT_POLICY, { ...base, confidence: 0.1 }).verdict, "escalate");
	assert.equal(decide(DEFAULT_POLICY, { ...base, kind: "weird", confidence: 0.8 }).verdict, "escalate");
});

test("denied kinds are refused even when everything else is fine", () => {
	assert.equal(decide(DEFAULT_POLICY, { ...base, kind: "legal_commitment" }).verdict, "deny");
});

test("untrusted source cannot combine with a write, even where writes are allowed", () => {
	const p = { ...DEFAULT_POLICY, rules: [{ kind: "*", maxRisk: "low" as const, allowWrites: true, maxCostUsd: 1, minConfidence: 0 }] };
	assert.equal(decide(p, { ...base, writes: true }).verdict, "allow");
	assert.equal(decide(p, { ...base, writes: true, untrustedSource: true }).verdict, "escalate");
});

test("budget exhaustion escalates", () => {
	assert.equal(decide(DEFAULT_POLICY, base, DEFAULT_POLICY.budgetUsd).verdict, "escalate");
});

test("200 synthetic items: most finish without a person, and the run is reproducible", () => {
	const a = routeAll(generateWork(200, 7));
	const b = routeAll(generateWork(200, 7));
	assert.deepEqual(a, b);
	assert.equal(a.allow + a.deny + a.escalate, 200);
	assert.ok(a.allow > 100, `allowed ${a.allow}`);
	assert.ok(a.deny > 0 && a.escalate > 0, "some items must reach policy exceptions");
	console.log(`200 items: allow=${a.allow} deny=${a.deny} escalate=${a.escalate} humanTouches/100=${a.humanTouchesPer100}`, a.reasons);
});
