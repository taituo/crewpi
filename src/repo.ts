import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";

/**
 * Agents never get a shell. They get a handful of git operations on one small repository,
 * run with fixed argv (no shell), validated paths and branches, and one operation at a time.
 */
export const REPO = resolve(config.dataDir, "repos", "platform-config");
const SEED = resolve(dirname(fileURLToPath(import.meta.url)), "..", "seed", "platform-config");

function git(args: string[], input?: string): Promise<string> {
	return new Promise((res, rej) => {
		const child = execFile(
			"git",
			["-C", REPO, ...args],
			{ timeout: 20_000, maxBuffer: 2_000_000, env: { PATH: process.env.PATH ?? "", HOME: "/tmp", GIT_CONFIG_NOSYSTEM: "1" } },
			(err, stdout, stderr) => (err ? rej(new Error((stderr || err.message).trim().slice(0, 400))) : res(stdout)),
		);
		if (input !== undefined) child.stdin?.end(input);
	});
}

let chain: Promise<unknown> = Promise.resolve();
/** Serialises operations: branch checkouts share one working tree. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
	const next = chain.then(fn, fn);
	chain = next.catch(() => undefined);
	return next;
}

/** Adds seed files missing from main (so existing volumes receive new ones) without touching existing files. */
async function syncSeed() {
	const have = new Set((await git(["ls-tree", "-r", "--name-only", "main"])).trim().split("\n"));
	let added = 0;
	const walk = (rel: string) => {
		for (const e of readdirSync(join(SEED, rel), { withFileTypes: true })) {
			const p = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(p);
			else if (!have.has(p)) {
				mkdirSync(dirname(join(REPO, p)), { recursive: true });
				cpSync(join(SEED, p), join(REPO, p));
				added++;
			}
		}
	};
	walk("");
	if (added) {
		await git(["checkout", "-q", "-f", "main"]);
		await git(["add", "-A"]);
		await git(["commit", "-q", "-m", `Add ${added} new seed file(s)`]);
	}
}

export async function initRepo() {
	if (existsSync(join(REPO, ".git"))) return syncSeed();
	mkdirSync(REPO, { recursive: true });
	cpSync(SEED, REPO, { recursive: true });
	await git(["init", "-q", "-b", "main"]);
	await git(["config", "user.name", "Crew Platform"]);
	await git(["config", "user.email", "platform@crew.local"]);
	await git(["add", "-A"]);
	await git(["commit", "-q", "-m", "Initial desired state"]);
}

export function safePath(p: string): string {
	if (!p || p.length > 200 || p.includes("\0")) throw new Error("invalid path");
	const n = normalize(p).replace(/^\.\//, "");
	if (n.startsWith("..") || n.startsWith("/") || n.split(sep).includes(".git") || n.startsWith(".git")) {
		throw new Error(`path not allowed: ${p}`);
	}
	return n;
}

export function safeRef(ref: string): string {
	if (!/^[A-Za-z0-9._\/-]{1,80}$/.test(ref) || ref.includes("..") || ref.startsWith("-")) throw new Error(`invalid ref: ${ref}`);
	return ref;
}

const branchOk = (b: string) => safeRef(b) && /^agent\//.test(b);

export const repo = {
	list: (ref = "main") => git(["ls-tree", "-r", "--name-only", safeRef(ref)]).then((s) => s.trim().split("\n").filter(Boolean)),
	read: (path: string, ref = "main") => git(["show", `${safeRef(ref)}:${safePath(path)}`]),
	branches: async () => {
		const out = await git(["for-each-ref", "--format=%(refname:short)\t%(objectname:short)\t%(subject)", "refs/heads"]);
		return out
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				const [name, sha, subject] = l.split("\t");
				return { name, sha, subject };
			});
	},
	diff: (branch: string) => git(["diff", "--no-color", `main...${safeRef(branch)}`]),
	/** Commit one file on an agent/* branch (created from main when new). Never touches main. */
	write: (o: { branch: string; path: string; content: string; message: string; author: string }) =>
		exclusive(async () => {
			if (!branchOk(o.branch)) throw new Error("branch must match agent/<topic>");
			if (Buffer.byteLength(o.content) > 200_000) throw new Error("file too large");
			const path = safePath(o.path);
			const exists = (await git(["branch", "--list", o.branch])).trim() !== "";
			try {
				await git(exists ? ["checkout", "-q", o.branch] : ["checkout", "-q", "-b", o.branch, "main"]);
				const abs = resolve(REPO, path);
				if (!abs.startsWith(REPO + sep)) throw new Error("path escapes repository");
				mkdirSync(dirname(abs), { recursive: true });
				writeFileSync(abs, o.content);
				await git(["add", "--", path]);
				const status = await git(["status", "--porcelain"]);
				if (!status.trim()) return { committed: false, sha: (await git(["rev-parse", "--short", "HEAD"])).trim() };
				await git(["-c", `user.name=${o.author}`, "-c", `user.email=${o.author.toLowerCase()}@agents.crew.local`, "commit", "-q", "-m", o.message.slice(0, 200)]);
				return { committed: true, sha: (await git(["rev-parse", "--short", "HEAD"])).trim() };
			} finally {
				await git(["checkout", "-q", "-f", "main"]).catch(() => undefined);
			}
		}),
};

export function readSeedFile(rel: string) {
	return readFileSync(join(REPO, rel), "utf8");
}
