import type { WorldEvent } from "../types.ts";
import { BASE_POOL, BASE_REPLICAS, BASE_VERSION, SERVICES, type Action, type Cause, type Kind, type ServiceId } from "./catalog.ts";

/**
 * State of the IT-operations world. The single source of truth for "what is broken" is the list of open incidents:
 * a service's effective condition is derived from them (`effective`), so the world cannot say "healthy" while a fault
 * is open, or "broken" after it is fixed, and overlapping incidents never undo each other's repairs.
 */
export type Severity = 1 | 2 | 3;
export type Incident = {
	id: string; kind: Kind; service: ServiceId; severity: Severity; openedAt: number; status: "open" | "resolved";
	cause: Cause; attempts: number; worse: number; escalations: number; resolvedAt?: number; resolvedBy?: string;
};
export type ItOpsState = {
	replicas: Record<ServiceId, number>;
	incidents: Record<string, Incident>;
	nextId: number;
	stats: { opened: number; resolved: number; worse: number; impactResolved: number };
};

export const initial = (): ItOpsState => ({
	replicas: Object.fromEntries(SERVICES.map((s) => [s, BASE_REPLICAS])) as Record<ServiceId, number>,
	incidents: {}, nextId: 1, stats: { opened: 0, resolved: 0, worse: 0, impactResolved: 0 },
});

const open = (s: ItOpsState) => Object.values(s.incidents).filter((i) => i.status === "open");

/** A service as it really is right now, derived from the faults that are open. */
export function effective(s: ItOpsState, id: ServiceId) {
	let pool = BASE_POOL, version = BASE_VERSION, certValid = true, up = true;
	for (const i of open(s)) {
		if (i.kind === "bad_config" && i.service === id) pool = 0;
		if (i.kind === "bad_deploy" && i.service === id) version = i.cause.badVersion ?? "v-bad";
		if (i.kind === "expired_cert" && i.service === id) certValid = false;
		if (i.kind === "dependency_down" && i.cause.rootService === id) up = false;
	}
	return { pool, version, certValid, up, replicas: s.replicas[id] };
}

/** Severity-weighted minutes of customer impact so far (resolved ones are summed once; open ones keep counting). */
export function impactMinutes(s: ItOpsState, now: number): number {
	return s.stats.impactResolved + open(s).reduce((n, i) => n + ((now - i.openedAt) / 60_000) * i.severity, 0);
}

/** The engine owns the state it passes in, so this reducer updates it in place and returns it (cheap for a year of incidents). */
export function reduce(s: ItOpsState, e: WorldEvent): ItOpsState {
	const p = e.payload as any;
	switch (e.type) {
		case "incident.opened":
			s.incidents[p.id] = { id: p.id, kind: p.kind, service: p.service, severity: p.severity, openedAt: e.vtime, status: "open", cause: p.cause, attempts: 0, worse: 0, escalations: 0 };
			s.nextId++; s.stats.opened++;
			break;
		case "fix.applied": {
			const i = s.incidents[p.id];
			if (!i) break;
			i.attempts++;
			const a = p.action as Action;
			if (a.type === "scale" && a.service && a.replicas) s.replicas[a.service] = a.replicas;
			if (p.outcome === "worse") { i.worse++; i.severity = Math.min(3, i.severity + 1) as Severity; s.stats.worse++; }
			break;
		}
		case "incident.worsened": {
			const i = s.incidents[p.id];
			if (i) { i.severity = p.severity; i.escalations++; }
			break;
		}
		case "incident.resolved": {
			const i = s.incidents[p.id];
			if (!i || i.status === "resolved") break;
			i.status = "resolved"; i.resolvedAt = e.vtime; i.resolvedBy = p.by;
			s.stats.resolved++;
			s.stats.impactResolved += ((e.vtime - i.openedAt) / 60_000) * i.severity;
			break;
		}
	}
	return s;
}
