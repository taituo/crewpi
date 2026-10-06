// Runs INSIDE a sandbox pod. A tiny authenticated HTTP API over one working directory (/work):
// exec a command, read/write a file, list a directory. No dependencies. The pod itself (non-root, read-only root,
// no service account token, network policy, resource limits) is the security boundary, not this file; the checks
// here only keep file access inside /work and bound time and output.
import http from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const TOKEN = process.env.RUNNER_TOKEN ?? "";
delete process.env.RUNNER_TOKEN; // children must not inherit it
const ROOT = process.env.WORK_DIR ?? "/work";
const PORT = Number(process.env.PORT ?? 8099);
const MAX_OUT = 64 * 1024, MAX_FILE = 1024 * 1024, MAX_BODY = 2 * 1024 * 1024;
let running = 0;

const send = (res, code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));

function authed(req) {
	const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
	const want = Buffer.from(TOKEN);
	return TOKEN.length >= 16 && given.length === want.length && timingSafeEqual(given, want);
}

/** Resolve inside ROOT, following symlinks, so a link to /etc or /proc cannot be used to escape. */
async function safe(p = ".") {
	const abs = path.resolve(ROOT, String(p));
	if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw Object.assign(new Error("path escapes the workspace"), { status: 400 });
	let probe = abs;
	for (;;) {
		try {
			const real = await fs.realpath(probe);
			if (real !== ROOT && !real.startsWith(ROOT + path.sep)) throw Object.assign(new Error("path escapes the workspace (symlink)"), { status: 400 });
			break;
		} catch (e) {
			if (e.status) throw e;
			if (probe === ROOT) break;
			probe = path.dirname(probe);
		}
	}
	return abs;
}

async function body(req, max = MAX_BODY) {
	const chunks = []; let n = 0;
	for await (const c of req) { n += c.length; if (n > max) throw Object.assign(new Error("body too large"), { status: 413 }); chunks.push(c); }
	return Buffer.concat(chunks);
}

function exec(command, cwd, timeoutS) {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const child = spawn("sh", ["-c", command], {
			cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
			env: { PATH: process.env.PATH, HOME: ROOT, TMPDIR: "/tmp", LANG: "C.UTF-8", CI: "1" },
		});
		const out = { stdout: "", stderr: "" }; let truncated = false, timedOut = false;
		const add = (k) => (d) => { if (out[k].length < MAX_OUT) out[k] += d.toString(); else truncated = true; };
		child.stdout.on("data", add("stdout")); child.stderr.on("data", add("stderr"));
		const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, timeoutS * 1000);
		child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, truncated, ms: Date.now() - t0, stdout: out.stdout.slice(0, MAX_OUT), stderr: out.stderr.slice(0, MAX_OUT) }); });
		child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, signal: null, timedOut: false, truncated: false, ms: 0, stdout: "", stderr: String(e) }); });
	});
}

http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, "http://x");
		if (url.pathname === "/health") return send(res, 200, { ok: true });
		if (!authed(req)) return send(res, 401, { error: "unauthorized" });

		if (req.method === "POST" && url.pathname === "/exec") {
			const { command, cwd, timeoutS } = JSON.parse((await body(req, 64 * 1024)).toString() || "{}");
			if (typeof command !== "string" || !command.trim()) return send(res, 400, { error: "command required" });
			if (running >= 2) return send(res, 429, { error: "too many commands running" });
			const dir = await safe(cwd ?? ".");
			running++;
			try { return send(res, 200, await exec(command, dir, Math.min(Math.max(Number(timeoutS) || 60, 1), 300))); } finally { running--; }
		}
		if (req.method === "GET" && url.pathname === "/file") {
			const p = await safe(url.searchParams.get("path"));
			const st = await fs.stat(p);
			if (!st.isFile()) return send(res, 400, { error: "not a file" });
			if (st.size > MAX_FILE) return send(res, 413, { error: "file too large" });
			return send(res, 200, { content: await fs.readFile(p, "utf8") });
		}
		if (req.method === "PUT" && url.pathname === "/file") {
			const p = await safe(url.searchParams.get("path"));
			const data = await body(req, MAX_FILE);
			await fs.mkdir(path.dirname(p), { recursive: true });
			await fs.writeFile(p, data);
			return send(res, 200, { ok: true, bytes: data.length });
		}
		if (req.method === "GET" && url.pathname === "/ls") {
			const p = await safe(url.searchParams.get("path") ?? ".");
			const ents = await fs.readdir(p, { withFileTypes: true });
			const rows = await Promise.all(ents.slice(0, 500).map(async (e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file", size: e.isFile() ? (await fs.stat(path.join(p, e.name))).size : 0 })));
			return send(res, 200, { entries: rows });
		}
		send(res, 404, { error: "not found" });
	} catch (e) {
		send(res, e.status ?? (e.code === "ENOENT" ? 404 : 500), { error: e.code === "ENOENT" ? "no such file or directory" : String(e.message ?? e) });
	}
}).listen(PORT, "0.0.0.0", () => console.log(`runner on :${PORT}, root ${ROOT}`));
