import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { kube } from "./kube.ts";

/**
 * Sandboxes: one short-lived pod per channel (private chats get their own), created and deleted by the workspace.
 * The pod runs sandbox/runner.mjs; this module creates it, finds it, calls it and sweeps idle ones.
 * Isolation is the pod's job: non-root, read-only root, no service-account token, no capabilities, resource
 * limits, a deadline, and NetworkPolicies in k8s/40-sandboxes.yaml (default deny, DNS + public web only).
 */

const NS = "ai-sandboxes";
const PORT = 8099;

db.exec("CREATE TABLE IF NOT EXISTS sandboxes (key TEXT PRIMARY KEY, pod TEXT NOT NULL, token TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER NOT NULL)");

export const sandboxName = (key: string) => `sbx-${createHash("sha1").update(key).digest("hex").slice(0, 10)}`;

export function podSpec(o: { name: string; key: string; token: string; image: string }) {
	return {
		apiVersion: "v1",
		kind: "Pod",
		metadata: { name: o.name, namespace: NS, labels: { app: "crew-sandbox", "crew.io/key": createHash("sha1").update(o.key).digest("hex").slice(0, 16) }, annotations: { "crew.io/channel": o.key } },
		spec: {
			restartPolicy: "Never",
			automountServiceAccountToken: false,
			enableServiceLinks: false,
			activeDeadlineSeconds: 7200,
			securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } },
			containers: [
				{
					name: "runner",
					image: o.image,
					imagePullPolicy: "IfNotPresent",
					env: [{ name: "RUNNER_TOKEN", value: o.token }, { name: "WORK_DIR", value: "/work" }],
					ports: [{ containerPort: PORT }],
					readinessProbe: { httpGet: { path: "/health", port: PORT }, periodSeconds: 1 },
					securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
					resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "1", memory: "1Gi" } },
					volumeMounts: [{ name: "work", mountPath: "/work" }, { name: "tmp", mountPath: "/tmp" }],
				},
			],
			volumes: [{ name: "work", emptyDir: { sizeLimit: "1Gi" } }, { name: "tmp", emptyDir: { sizeLimit: "256Mi" } }],
		},
	};
}

type Row = { key: string; pod: string; token: string; created_at: number; last_used: number };
const rowOf = (key: string) => db.prepare("SELECT * FROM sandboxes WHERE key = ?").get(key) as Row | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getPod(name: string): Promise<any | undefined> {
	try {
		return await kube("GET", `/api/v1/namespaces/${NS}/pods/${name}`);
	} catch (e) {
		if (/-> 404/.test((e as Error).message)) return undefined;
		throw e;
	}
}

const ready = (p: any) => p?.status?.phase === "Running" && p.status.podIP && p.status.containerStatuses?.[0]?.ready;

export type Sandbox = { name: string; url: string; token: string };

const starting = new Map<string, Promise<Sandbox>>();

/** Returns the running sandbox for a channel, creating it on first use. */
export function ensureSandbox(key: string): Promise<Sandbox> {
	const inflight = starting.get(key);
	if (inflight) return inflight;
	const p = (async () => {
		const name = sandboxName(key);
		let row = rowOf(key);
		let pod = await getPod(name);
		if (pod && (!row || ["Failed", "Succeeded"].includes(pod.status?.phase))) {
			await kube("DELETE", `/api/v1/namespaces/${NS}/pods/${name}`).catch(() => undefined);
			for (let i = 0; i < 30 && (await getPod(name)); i++) await sleep(1000);
			pod = undefined;
		}
		if (!pod) {
			const live = await kube("GET", `/api/v1/namespaces/${NS}/pods?labelSelector=app%3Dcrew-sandbox`);
			if ((live.items ?? []).length >= config.sandbox.max) throw new Error(`sandbox limit reached (${config.sandbox.max} running). Ask a human to stop one, or wait for an idle one to expire.`);
			const token = randomBytes(24).toString("base64url");
			await kube("POST", `/api/v1/namespaces/${NS}/pods`, podSpec({ name, key, token, image: config.sandbox.image }));
			db.prepare("INSERT OR REPLACE INTO sandboxes (key, pod, token, created_at, last_used) VALUES (?,?,?,?,?)").run(key, name, token, Date.now(), Date.now());
			row = rowOf(key);
		}
		for (let i = 0; i < 90; i++) {
			pod = await getPod(name);
			if (ready(pod)) break;
			if (pod?.status?.phase === "Failed") throw new Error(`sandbox failed to start: ${pod.status.reason ?? ""} ${pod.status.message ?? ""}`);
			await sleep(1000);
		}
		if (!ready(pod)) throw new Error("sandbox did not become ready in 90 s");
		db.prepare("UPDATE sandboxes SET last_used = ? WHERE key = ?").run(Date.now(), key);
		return { name, url: `http://${pod.status.podIP}:${PORT}`, token: row!.token };
	})().finally(() => starting.delete(key));
	starting.set(key, p);
	return p;
}

/** One call to the runner inside the sandbox. */
export async function runner<T = any>(sb: Sandbox, method: "GET" | "POST" | "PUT", path: string, body?: string | object, timeoutMs = 20_000): Promise<T> {
	const res = await fetch(`${sb.url}${path}`, {
		method,
		headers: { authorization: `Bearer ${sb.token}`, ...(typeof body === "object" ? { "content-type": "application/json" } : {}) },
		body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const data = (await res.json().catch(() => ({}))) as any;
	if (!res.ok) throw new Error(data.error ?? `runner HTTP ${res.status}`);
	return data as T;
}

export async function stopSandbox(key: string): Promise<boolean> {
	const row = rowOf(key);
	await kube("DELETE", `/api/v1/namespaces/${NS}/pods/${row?.pod ?? sandboxName(key)}`).catch(() => undefined);
	db.prepare("DELETE FROM sandboxes WHERE key = ?").run(key);
	return !!row;
}

export function listSandboxes() {
	return (db.prepare("SELECT * FROM sandboxes ORDER BY created_at").all() as Row[]).map((r) => ({ key: r.key, pod: r.pod, createdAt: r.created_at, lastUsed: r.last_used }));
}

/** Deletes sandboxes idle longer than the configured time, and pods nobody tracks any more. */
export async function sweepSandboxes() {
	const cutoff = Date.now() - config.sandbox.idleMin * 60_000;
	for (const r of db.prepare("SELECT * FROM sandboxes WHERE last_used < ?").all(cutoff) as Row[]) await stopSandbox(r.key);
	const live = await kube("GET", `/api/v1/namespaces/${NS}/pods?labelSelector=app%3Dcrew-sandbox`).catch(() => ({ items: [] }));
	const tracked = new Set((db.prepare("SELECT pod FROM sandboxes").all() as { pod: string }[]).map((r) => r.pod));
	for (const p of live.items ?? []) if (!tracked.has(p.metadata.name)) await kube("DELETE", `/api/v1/namespaces/${NS}/pods/${p.metadata.name}`).catch(() => undefined);
}

export function startSandboxSweeper() {
	if (!process.env.KUBERNETES_SERVICE_HOST) return;
	setInterval(() => void sweepSandboxes().catch((e) => console.warn("[sandbox] sweep failed:", e.message)), 60_000).unref();
}
