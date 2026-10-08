/**
 * The IT-operations domain: services, the kinds of trouble they get into, and the physics of fixing them.
 * Nothing here is random and nothing here is a model: a problem has a hidden cause, and `judge` says what
 * an action does to it. Wrong fixes are not just "no": some do nothing, some help a little, some make it worse.
 */
export const SERVICES = ["api", "checkout", "payments", "search", "db", "queue"] as const;
export type ServiceId = (typeof SERVICES)[number];

/** Who calls whom: checkout needs payments, db and queue. A failing dependency shows up as errors in its callers. */
export const DEPS: Record<ServiceId, ServiceId[]> = { api: ["checkout", "search", "db"], checkout: ["payments", "db", "queue"], payments: ["db"], search: ["db"], db: [], queue: [] };

export const KINDS = ["bad_config", "memory_leak", "capacity", "dependency_down", "bad_deploy", "expired_cert", "noisy_alert"] as const;
export type Kind = (typeof KINDS)[number];

/** How often each kind turns up, and which services it happens to. */
export const WEIGHTS: Record<Kind, number> = { bad_config: 3, memory_leak: 2, capacity: 3, dependency_down: 2, bad_deploy: 3, expired_cert: 1, noisy_alert: 4 };
export const HOMES: Record<Kind, ServiceId[]> = {
	bad_config: ["checkout", "api", "search", "payments"],
	memory_leak: ["api", "search", "queue"],
	capacity: ["api", "checkout", "search"],
	dependency_down: ["checkout", "api", "payments", "search"],
	bad_deploy: ["api", "checkout", "payments", "search"],
	expired_cert: ["payments", "api"],
	noisy_alert: [...SERVICES],
};

export const BASE_VERSION = "v141", BASE_REPLICAS = 2, BASE_POOL = 20;

/** The hidden truth of one incident. Only symptoms are visible to a responder. */
export type Cause = {
	kind: Kind;
	service: ServiceId;
	rootService?: ServiceId;      // dependency_down: the service that is really broken
	neededReplicas?: number;      // capacity
	badVersion?: string;          // bad_deploy
	goodVersion: string;
	defaultPool: number;          // bad_config
	leakMbPerHour?: number;       // memory_leak
};

export type ActionType = "restart" | "scale" | "rollback" | "set_config" | "rotate_cert" | "failover" | "dismiss";
export type Action = { type: ActionType; service?: ServiceId; replicas?: number; key?: string; value?: number };
export type Outcome = "resolved" | "partial" | "no_effect" | "worse";

export function rightFix(c: Cause): Action {
	switch (c.kind) {
		case "bad_config": return { type: "set_config", service: c.service, key: "pool", value: c.defaultPool };
		case "memory_leak": return { type: "rollback", service: c.service };
		case "capacity": return { type: "scale", service: c.service, replicas: c.neededReplicas };
		case "dependency_down": return { type: "failover", service: c.rootService };
		case "bad_deploy": return { type: "rollback", service: c.service };
		case "expired_cert": return { type: "rotate_cert", service: c.service };
		case "noisy_alert": return { type: "dismiss", service: c.service };
	}
}

/** What this action does to this problem. */
export function judge(c: Cause, a: Action): { outcome: Outcome; note: string } {
	const target = a.service ?? c.service;
	const here = target === c.service;
	const r = (outcome: Outcome, note: string) => ({ outcome, note });
	switch (c.kind) {
		case "bad_config":
			if (a.type === "set_config" && here && a.key === "pool" && (a.value ?? 0) > 0) return r("resolved", "pool size restored");
			return r("no_effect", a.type === "restart" ? "it crashes again for the same reason" : "nothing changed in the configuration");
		case "memory_leak":
			if (a.type === "rollback" && here) return r("resolved", "the leaking build is gone");
			if (a.type === "restart" && here) return r("partial", "memory is freed for a few hours, the leak is still there");
			return r("no_effect", "the leak continues");
		case "capacity":
			if (a.type === "scale" && here) return (a.replicas ?? 0) >= (c.neededReplicas ?? 1) ? r("resolved", "enough replicas for the load") : (a.replicas ?? 0) >= 1 ? r("partial", "more capacity, still not enough") : r("no_effect", "no replicas requested");
			if (a.type === "restart" && here) return r("worse", "a cold restart drops warm connections while saturated");
			return r("no_effect", "the load is unchanged");
		case "dependency_down":
			if (a.type === "failover" && target === c.rootService) return r("resolved", `${c.rootService} failed over`);
			if (a.type === "scale") return r("worse", `more clients hammer the failing ${c.rootService}`);
			return r("no_effect", `${c.rootService} is still down`);
		case "bad_deploy":
			if (a.type === "rollback" && here) return r("resolved", `rolled back to ${c.goodVersion}`);
			return r("no_effect", `the bad build ${c.badVersion} is still serving`);
		case "expired_cert":
			if (a.type === "rotate_cert" && here) return r("resolved", "new certificate issued");
			return r("no_effect", "the certificate is still expired");
		case "noisy_alert":
			if (a.type === "dismiss" && here) return r("resolved", "alert dismissed, nothing was wrong");
			return r("worse", "acting on a false alarm caused a real, brief outage");
	}
}
