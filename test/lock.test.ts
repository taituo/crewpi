import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease } from "../src/lock.ts";

const other = (dir: string) => writeFileSync(join(dir, "pi.lock"), JSON.stringify({ host: "other-pod", pid: 7, token: "x" }));

test("a fresh lease held by another pod/process refuses a second owner", () => {
	const dir = mkdtempSync(join(tmpdir(), "crew-lock-"));
	other(dir);
	assert.throws(() => acquireLease(dir), /owned by other-pod:7/);
});

test("a stale lease is taken over, and release frees it for the next owner", () => {
	const dir = mkdtempSync(join(tmpdir(), "crew-lock-"));
	other(dir);
	const old = new Date(Date.now() - 60_000);
	utimesSync(join(dir, "pi.lock"), old, old);
	const mine = acquireLease(dir);
	mine.release();
	assert.equal(existsSync(join(dir, "pi.lock")), false);
	acquireLease(dir).release();
});

test("release never deletes a lease that someone else took over", () => {
	const dir = mkdtempSync(join(tmpdir(), "crew-lock-"));
	const mine = acquireLease(dir);
	other(dir);
	mine.release();
	assert.equal(existsSync(join(dir, "pi.lock")), true);
});

test("the server startup path refuses a second process on the same data dir", async () => {
	const { execFileSync } = await import("node:child_process");
	const dir = mkdtempSync(join(tmpdir(), "crew-lock2-"));
	const holder = acquireLease(dir);
	const code = `import("./src/lock.ts").then((m)=>{try{m.acquireLease(process.argv[1]);console.log("got it")}catch(e){console.log("refused")}})`;
	// a different pid on the same host: the lease file names this test process, so the child must be refused
	assert.equal(execFileSync(process.execPath, ["-e", code, dir], { encoding: "utf8" }).trim(), "refused");
	holder.release();
});
