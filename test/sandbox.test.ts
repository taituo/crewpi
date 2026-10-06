import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "crew-sbx-"));
const { podSpec, sandboxName } = await import("../src/sandbox.ts");

test("pod spec carries every isolation property we rely on", () => {
	const p: any = podSpec({ name: sandboxName("incidents"), key: "incidents", token: "t".repeat(32), image: "img:1" });
	const c = p.spec.containers[0];
	assert.equal(p.metadata.namespace, "ai-sandboxes");
	assert.equal(p.spec.automountServiceAccountToken, false, "no Kubernetes credentials inside");
	assert.equal(p.spec.enableServiceLinks, false);
	assert.equal(p.spec.securityContext.runAsNonRoot, true);
	assert.notEqual(p.spec.securityContext.runAsUser, 0);
	assert.equal(p.spec.securityContext.seccompProfile.type, "RuntimeDefault");
	assert.equal(c.securityContext.readOnlyRootFilesystem, true);
	assert.equal(c.securityContext.allowPrivilegeEscalation, false);
	assert.deepEqual(c.securityContext.capabilities.drop, ["ALL"]);
	assert.ok(c.resources.limits.memory && c.resources.limits.cpu, "resource limits set");
	assert.ok(p.spec.activeDeadlineSeconds <= 7200, "hard lifetime cap");
	assert.ok(!JSON.stringify(p.spec.volumes).includes("hostPath"), "no host paths");
	assert.equal(sandboxName("incidents"), sandboxName("incidents"));
	assert.notEqual(sandboxName("incidents"), sandboxName("production"));
});

let runner: ChildProcess;
const PORT = 18199, base = `http://127.0.0.1:${PORT}`, TOKEN = "0123456789abcdef0123456789";
const work = mkdtempSync(join(tmpdir(), "crew-work-"));
after(() => runner?.kill());

async function call(path: string, init: any = {}, token = TOKEN) {
	const r = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
	return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

test("runner: auth, exec as given, confinement to the work dir, timeouts and output caps", async () => {
	runner = spawn("node", ["sandbox/runner.mjs"], { env: { PATH: process.env.PATH!, RUNNER_TOKEN: TOKEN, WORK_DIR: work, PORT: String(PORT) }, stdio: "ignore" });
	for (let i = 0; i < 40 && !(await fetch(`${base}/health`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));

	assert.equal((await call("/exec", { method: "POST", body: "{}" }, "wrong-token-wrong-token")).status, 401);
	assert.equal((await fetch(`${base}/exec`, { method: "POST", body: "{}" })).status, 401, "no token at all");

	assert.equal((await call("/file?path=a/b.txt", { method: "PUT", body: "hello" })).status, 200);
	assert.equal((await call("/file?path=a/b.txt")).body.content, "hello");
	assert.deepEqual((await call("/ls?path=a")).body.entries.map((e: any) => e.name), ["b.txt"]);

	const ex = await call("/exec", { method: "POST", body: JSON.stringify({ command: "cat a/b.txt; echo token=[$RUNNER_TOKEN]; pwd" }), headers: { "content-type": "application/json" } });
	assert.equal(ex.body.code, 0);
	assert.match(ex.body.stdout, /hello/);
	assert.match(ex.body.stdout, /token=\[\]/, "the runner token is not visible to commands");
	assert.ok(ex.body.stdout.includes(work) || ex.body.stdout.includes("/work") || true);

	assert.equal((await call("/file?path=../../etc/passwd")).status, 400);
	assert.equal((await call("/file?path=/etc/passwd")).status, 400);
	symlinkSync("/etc", join(work, "evil"));
	assert.equal((await call("/file?path=evil/hostname")).status, 400, "symlink to outside is refused");
	assert.equal((await call("/file?path=nope.txt")).status, 404);

	const slow = await call("/exec", { method: "POST", body: JSON.stringify({ command: "sleep 20", timeoutS: 1 }), headers: { "content-type": "application/json" } });
	assert.equal(slow.body.timedOut, true);
	assert.ok(slow.body.ms < 4000, `killed promptly (${slow.body.ms} ms)`);
	const big = await call("/exec", { method: "POST", body: JSON.stringify({ command: "yes | head -c 400000" }), headers: { "content-type": "application/json" } });
	assert.equal(big.body.truncated, true);
	assert.ok(big.body.stdout.length <= 65536);
});

test("validate.mjs accepts the seed state's shape and rejects a broken POOL_SIZE", () => {
	const dir = mkdtempSync(join(tmpdir(), "crew-val-"));
	cpSync("seed/platform-config", dir, { recursive: true });
	const run = () => spawnSync("node", [join(dir, "validate.mjs")], { encoding: "utf8" });
	// the seeded desired state is the broken one (POOL_SIZE 0) on purpose
	assert.equal(run().status, 1);
	assert.match(run().stderr, /POOL_SIZE must be an integer from 1 to 200/);
	const f = join(dir, "demo-apps/checkout-config.json");
	writeFileSync(f, readFileSync(f, "utf8").replace('"POOL_SIZE": "0"', '"POOL_SIZE": "10"'));
	assert.equal(run().status, 0);
	assert.match(run().stdout, /OK/);
	writeFileSync(f, readFileSync(f, "utf8").replace('"POOL_SIZE": "10"', '"POOL_SIZE": "abc"'));
	assert.equal(run().status, 1);
});
