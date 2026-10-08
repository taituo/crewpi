// A model-driven team from the terminal: Tier 2 ops agents on a daily budget, recorded to a tape, replayed later with zero requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const data = mkdtempSync(join(tmpdir(), "crew-modelcli-"));
let hits = 0, auth = "";
const srv = createServer((req, res) => {
	let raw = ""; req.on("data", (c) => (raw += c));
	req.on("end", () => {
		hits++; auth = String(req.headers.authorization);
		const last = JSON.parse(raw).messages.at(-1);
		const message = last.role === "user" ? { role: "assistant", content: null, tool_calls: [{ id: "c" + hits, type: "function", function: { name: "jira_search", arguments: '{"status":"Open"}' } }] } : { role: "assistant", content: "ok" };
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message }] }));
	});
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(srv.address() as any).port}/v1`;
const crew = async (env: Record<string, string>, ...args: string[]) => {
	try { const r = await run(process.execPath, ["src/cli.ts", ...args], { env: { ...process.env, DATA_DIR: data, SESSION_SECRET: "t", CREW_USER: "tester", ...env } }); return { code: 0, out: r.stdout, err: r.stderr }; }
	catch (x: any) { return { code: x.code as number, out: x.stdout as string, err: x.stderr as string }; }
};
const field = (out: string, key: string) => new RegExp(`^${key}:\\s+(.+)$`, "m").exec(out)?.[1]?.trim();
const ENV = { LOCAL_LLM_BASE_URL: base, LOCAL_LLM_API_KEY: "cli-test-key" };

test("--brain model: the operators are Tier 2 on a daily budget, the tape is written, the key stays out of the world", async () => {
	const made = await crew(ENV, "world", "new", "m1", "--spec", "itops:none", "--team", "ops=2,dev=1", "--brain", "model", "--model", "fake-m", "--budget", "12", "--seed", "mc");
	assert.equal(made.code, 0, made.err);
	assert.match(made.out, /model fake-m/);
	const ran = await crew(ENV, "world", "run", "m1", "--days", "3");
	assert.equal(ran.code, 0, ran.err);
	assert.match(ran.out, /degraded/, "the budget (12 units/day, 2 turns a shift) runs out and it is reported");
	assert.ok(hits > 20, `the model was called (${hits})`);
	assert.equal(auth, "Bearer cli-test-key");
	assert.ok(existsSync(join(data, "worlds", "m1.tape.jsonl")));
	assert.ok(!JSON.stringify(await Bun_free_read(join(data, "worlds", "m1.team.json"))).includes("cli-test-key"), "the key is never written next to the world");
});
async function Bun_free_read(p: string) { return (await import("node:fs")).readFileSync(p, "utf8"); }

test("--brain model without an endpoint is refused clearly", async () => {
	const r = await crew({ LOCAL_LLM_BASE_URL: "", LOCAL_LLM_API_KEY: "" }, "world", "new", "m2", "--spec", "itops:none", "--team", "ops=1", "--brain", "model", "--model", "x");
	assert.notEqual(r.code, 0);
	assert.match(r.err, /LOCAL_LLM_BASE_URL/);
	assert.notEqual((await crew(ENV, "world", "new", "m3", "--spec", "itops:none", "--team", "ops=1", "--brain", "model")).code, 0, "a model needs a name");
	assert.notEqual((await crew(ENV, "world", "new", "m4", "--spec", "itops:none", "--team", "ops=1", "--brain", "oracle")).code, 0);
	assert.notEqual((await crew(ENV, "world", "new", "m5", "--spec", "itops:none", "--team", "ops=1", "--budget", "5")).code, 0, "a budget needs a model");
});

test("a replay world driven from the tape reproduces the run with zero requests", async () => {
	const tape = join(data, "worlds", "m1.tape.jsonl");
	const a = field((await crew(ENV, "world", "status", "m1")).out, "hash")!;
	const before = hits;
	const made = await crew(ENV, "world", "new", "r1", "--spec", "itops:none", "--team", "ops=2,dev=1", "--brain", "replay", "--tape", tape, "--seed", "mc");
	assert.equal(made.code, 0, made.err);
	const ran = await crew({}, "world", "run", "r1", "--days", "3");
	assert.equal(ran.code, 0, ran.err);
	assert.equal(hits, before, "not one request to the model");
	assert.equal(field((await crew({}, "world", "status", "r1")).out, "hash"), a);
	srv.close();
});
