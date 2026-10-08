import type { Incident, ItOpsState } from "./state.ts";

/**
 * What a responder can see of an incident: numbers and log lines, never the cause. Derived from the hidden cause
 * and the time since it began, so the same incident always looks the same at the same moment.
 */
export type Symptoms = { metrics: { cpu: number; memMb: number; latencyMs: number; errorRate: number; restarts: number }; logs: string[]; alerts: string[] };
const HEALTHY = { cpu: 0.35, memMb: 420, latencyMs: 120, errorRate: 0.002, restarts: 0 };

export function symptoms(_state: ItOpsState, inc: Incident, now: number): Symptoms {
	const hours = Math.max(0, (now - inc.openedAt) / 3_600_000);
	const c = inc.cause;
	let m = { ...HEALTHY };
	let logs: string[] = [];
	let alerts: string[] = [];
	if (inc.status === "resolved") return { metrics: m, logs, alerts };
	switch (c.kind) {
		case "bad_config":
			m = { cpu: 0.05, memMb: 90, latencyMs: 0, errorRate: 1, restarts: 12 + Math.floor(hours * 2) };
			logs = ["FATAL database pool size must be >0 (POOL_SIZE=0)", "container exited with code 1; back-off restarting"];
			break;
		case "memory_leak": {
			const mem = Math.min(2048, 512 + (c.leakMbPerHour ?? 40) * hours);
			m = { cpu: 0.5, memMb: mem, latencyMs: 180 + hours * 20, errorRate: 0.02 + Math.min(0.3, hours * 0.01), restarts: Math.floor(hours / 6) };
			logs = [`GC pressure rising; heap ${Math.round(mem)} MB (limit 2048 MB)`, ...(mem >= 2000 ? ["OOMKilled: container exceeded its memory limit"] : [])];
			break;
		}
		case "capacity":
			m = { cpu: 0.97, memMb: 700, latencyMs: 2400, errorRate: 0.08, restarts: 0 };
			logs = ["request queue full, shedding load"];
			break;
		case "dependency_down":
			m = { cpu: 0.2, memMb: 450, latencyMs: 5000, errorRate: 0.9, restarts: 0 };
			logs = [`connection refused: ${c.rootService}:5432`, `upstream ${c.rootService} health check failing`];
			break;
		case "bad_deploy":
			m = { cpu: 0.6, memMb: 520, latencyMs: 900, errorRate: 0.35, restarts: 2 };
			logs = [`panic: nil pointer dereference in handler (version ${c.badVersion})`, `deploy of ${c.badVersion} finished ${hours.toFixed(1)} h ago`];
			break;
		case "expired_cert":
			m = { cpu: 0.3, memMb: 430, latencyMs: 300, errorRate: 0.6, restarts: 0 };
			logs = ["tls: handshake failed: x509: certificate has expired or is not yet valid"];
			break;
		case "noisy_alert":
			alerts = ["p99 latency above 800 ms (single sample)"];
			break;
	}
	if (c.kind !== "noisy_alert" && m.errorRate > 0.03) alerts = [`${inc.service} error rate ${(m.errorRate * 100).toFixed(0)}%`];
	return { metrics: { ...m, errorRate: Math.min(1, m.errorRate), latencyMs: Math.round(m.latencyMs), memMb: Math.round(m.memMb) }, logs, alerts };
}
