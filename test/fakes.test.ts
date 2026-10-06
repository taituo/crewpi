import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-fakes-"));
const f = await import("../src/fakes.ts");
const { isEnabled, setEnabled, offResult, listIntegrations } = await import("../src/integrations.ts");

test("metric series is stable, bounded and shows the incident", () => {
	const a = f.queryMetric("checkout_5xx_rate", 90);
	assert.equal(a.length, 24);
	assert.ok(a[0].v < 1.5, "healthy before the incident");
	assert.ok(a[a.length - 1].v > 10, "elevated during the incident");
	assert.deepEqual(a.map((p) => p.v), f.queryMetric("checkout_5xx_rate", 90).map((p) => p.v), "deterministic within a minute");
	assert.throws(() => f.queryMetric("nope", 60));
});

test("integrations default on, can be switched off, and tools see it", () => {
	assert.equal(isEnabled("jira"), true);
	assert.equal(offResult("jira"), undefined);
	assert.equal(setEnabled("jira", false, "test"), true);
	assert.equal(isEnabled("jira"), false);
	assert.match((offResult("jira") as any).content[0].text, /not connected/);
	assert.equal(setEnabled("bogus", true, "test"), false);
	assert.equal(listIntegrations().find((i) => i.id === "jira")?.enabled, false);
});

test("fake world tells one story", () => {
	assert.ok(f.githubPrs.some((p) => p.branch === "agent/fix-checkout-pool-size"));
	assert.ok(f.workflows.some((w) => w.status === "Failed" && /smokeTest/.test(w.failure ?? "")));
	assert.ok(f.ciLogs["github:9004:unit-tests"]);
});

test("the demo world recovers once the checkout fix is applied", () => {
	const before = f.queryMetric("checkout_5xx_rate", 10, 6).at(-1)!.v;
	assert.ok(before > 5);
	assert.equal(f.envView().prod.find((s: any) => s.service === "checkout-api")?.health, "CrashLoopBackOff");
	f.live.checkoutFixedAt = Date.now() - 120_000; // fixed two minutes ago
	assert.ok(f.queryMetric("checkout_5xx_rate", 10, 6).at(-1)!.v < 1.5, "5xx back to normal after the fix");
	assert.equal(f.envView().prod.find((s: any) => s.service === "checkout-api")?.health, "Healthy");
	f.live.checkoutFixedAt = null;
});
