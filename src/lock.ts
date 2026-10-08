import { closeSync, openSync, readFileSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * Pi Durable allows one process per storage and has no cross-process locking (its README). This is that lock:
 * a lease file in the data directory that is refreshed while the owner lives and considered dead when it stops.
 * It works across pods that share a volume (host name + pid), unlike a pid check alone.
 */
const LEASE_MS = 30_000;
const REFRESH_MS = 10_000;

type Owner = { host: string; pid: number; token: string };

export type Lease = { release(): void };

export function acquireLease(dir: string, name = "pi.lock", now = () => Date.now()): Lease {
	const file = join(dir, name);
	const me: Owner = { host: hostname(), pid: process.pid, token: Math.random().toString(36).slice(2) };
	const tryCreate = () => {
		const fd = openSync(file, "wx");
		writeSync(fd, JSON.stringify(me));
		closeSync(fd);
	};
	try {
		tryCreate();
	} catch (e: any) {
		if (e.code !== "EEXIST") throw e;
		let age = Infinity;
		let owner: Owner | undefined;
		try {
			const st = statMtime(file);
			age = now() - st;
			owner = JSON.parse(readFileSync(file, "utf8"));
		} catch { /* unreadable lock counts as stale */ }
		if (age < LEASE_MS && owner && !(owner.host === me.host && owner.pid === me.pid)) {
			throw new Error(`the agent storage in ${dir} is owned by ${owner.host}:${owner.pid} (lease refreshed ${Math.round(age / 1000)} s ago). Pi Durable allows one process per storage; stop the other one or wait ${Math.round((LEASE_MS - age) / 1000)} s.`);
		}
		try { unlinkSync(file); } catch { /* raced with the owner's release */ }
		tryCreate(); // loses the race loudly (EEXIST) if someone else took it in between
	}
	const timer = setInterval(() => { try { const t = new Date(now()); utimesSync(file, t, t); } catch { /* released */ } }, REFRESH_MS);
	timer.unref();
	return {
		release() {
			clearInterval(timer);
			try { if ((JSON.parse(readFileSync(file, "utf8")) as Owner).token === me.token) unlinkSync(file); } catch { /* already gone */ }
		},
	};
}

import { statSync } from "node:fs";
const statMtime = (f: string) => statSync(f).mtimeMs;
