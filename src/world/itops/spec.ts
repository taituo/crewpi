import { DAY, HOUR, MIN } from "../engine.ts";
import type { Actor, Rng, WorldSpec } from "../types.ts";
import { BASE_POOL, BASE_REPLICAS, BASE_VERSION, HOMES, KINDS, SERVICES, WEIGHTS, judge, rightFix, type Action, type Cause, type ServiceId } from "./catalog.ts";
import { initial, reduce, type ItOpsState, type Severity } from "./state.ts";

/**
 * The IT-operations world with a chosen responder policy (Tier 0: rules, no model):
 *   oracle - knows the hidden cause and applies the right fix (proves every problem can be solved)
 *   naive  - restart, then scale, then roll back, whatever the problem (proves wrong fixes have consequences)
 *   none   - nobody responds (proves problems escalate by themselves)
 * The incidents that arrive never depend on the responder: it cannot change the weather.
 */
export type Policy = "oracle" | "naive" | "none";

/** Busier in business hours (deploys happen then). Day 0 is a Monday. Returns a multiplier of at most 1.5. */
const rate = (now: number) => { const d = Math.floor(now / DAY) % 7, h = (now % DAY) / HOUR; return d < 5 && h >= 8 && h < 18 ? 1.5 : 0.6; };

/** Next arrival by thinning: draw gaps at the maximum rate and keep each candidate with probability rate/max. */
function nextArrival(now: number, rng: Rng): number {
	let t = now;
	for (let i = 0; i < 200; i++) { t += Math.ceil(rng.exp(1 / (0.8 * DAY))); if (rng.chance(rate(t) / 1.5)) return t; }
	return t;
}

function makeCause(kind: (typeof KINDS)[number], service: ServiceId, serial: number, rng: Rng): Cause {
	const base = { kind, service, goodVersion: BASE_VERSION, defaultPool: BASE_POOL };
	switch (kind) {
		case "dependency_down": return { ...base, rootService: "db" };
		case "capacity": return { ...base, neededReplicas: rng.int(BASE_REPLICAS + 1, BASE_REPLICAS + 3) };
		case "bad_deploy": return { ...base, badVersion: `v${141 + serial}` };
		case "memory_leak": return { ...base, leakMbPerHour: rng.int(20, 80) };
		default: return base;
	}
}

export function itopsSpec(policy: Policy): WorldSpec<ItOpsState> {
	const delayMean = policy === "oracle" ? 25 * MIN : 40 * MIN;
	const chaos: Actor<ItOpsState> = {
		id: "chaos",
		step: ({ now, state, rng, wake }) => {
			// Godmode: the operator (or a test) opens an incident of a chosen kind on a chosen service, right now.
			if (wake.kind === "inject") {
				const kind = wake.data?.kind as (typeof KINDS)[number], service = (wake.data?.service ?? HOMES[kind]?.[0]) as ServiceId;
				if (!KINDS.includes(kind) || !SERVICES.includes(service)) throw new Error(`cannot inject kind "${kind}" on service "${service}"`);
				const id = `inc-${state.nextId}`, severity = Number(wake.data?.severity ?? (kind === "noisy_alert" ? 1 : 2)) as Severity;
				const wakes: any[] = [{ actor: "escalator", in: 4 * HOUR, kind: "escalate", data: { id, n: 0 } }];
				if (policy !== "none") wakes.push({ actor: "responder", in: 5 * MIN + Math.ceil(rng.exp(1 / delayMean)), kind: "respond", data: { id } });
				return { events: [{ type: "incident.opened", actor: "operator", payload: { id, kind, service, severity, cause: makeCause(kind, service, state.nextId, rng) as any } }], wakes };
			}
			const kind = rng.weighted(KINDS.map((k) => ({ item: k, weight: WEIGHTS[k] })));
			const service = rng.pick(HOMES[kind]);
			const severity = (kind === "noisy_alert" ? 1 : rng.weighted<Severity>([{ item: 1, weight: 4 }, { item: 2, weight: 4 }, { item: 3, weight: 2 }])) as Severity;
			const response = 5 * MIN + Math.ceil(rng.exp(1 / delayMean)); // drawn for every policy, so the arrival stream is identical
			const id = `inc-${state.nextId}`;
			const wakes: any[] = [{ actor: "escalator", in: 4 * HOUR, kind: "escalate", data: { id, n: 0 } }, { actor: "chaos", at: nextArrival(now, rng), kind: "arrive" }];
			if (policy !== "none") wakes.push({ actor: "responder", in: response, kind: "respond", data: { id } });
			return { events: [{ type: "incident.opened", actor: "chaos", payload: { id, kind, service, severity, cause: makeCause(kind, service, state.nextId, rng) as any } }], wakes };
		},
	};
	const escalator: Actor<ItOpsState> = {
		id: "escalator",
		step: ({ state, wake }) => {
			const id = String(wake.data?.id), n = Number(wake.data?.n ?? 0), inc = state.incidents[id];
			if (!inc || inc.status !== "open") return {};
			const events = inc.severity < 3 ? [{ type: "incident.worsened", actor: "escalator", payload: { id, severity: inc.severity + 1 } }] : [];
			return { events, wakes: n < 1 ? [{ actor: "escalator", in: 8 * HOUR, kind: "escalate", data: { id, n: n + 1 } }] : [] };
		},
	};
	/** What an action does to every open incident it touches: one fix.applied per incident, and a resolution when it fits. */
	const applyTo = (state: ItOpsState, action: Action, by: string): { events: any[]; touched: string[] } => {
		const target = action.service;
		const events: any[] = [];
		const touched: string[] = [];
		for (const inc of Object.values(state.incidents)) {
			if (inc.status !== "open") continue;
			if (!(inc.service === target || inc.cause.rootService === target)) continue;
			const { outcome, note } = judge(inc.cause, action);
			touched.push(inc.id);
			events.push({ type: "fix.applied", actor: by, payload: { id: inc.id, action, outcome, note } });
			if (outcome === "resolved") events.push({ type: "incident.resolved", actor: by, payload: { id: inc.id, by } });
		}
		return { events, touched };
	};
	/** The hands of a tool-using agent: performs an action on a service, in the world, with the world's consequences. */
	const hands: Actor<ItOpsState> = {
		id: "hands",
		step: ({ state, wake }) => {
			const action = wake.data?.action as unknown as Action, by = String(wake.data?.by ?? "tool:unknown");
			const { events, touched } = applyTo(state, action, by);
			events.push({ type: "action.performed", actor: by, payload: { action, affected: touched } });
			return { events };
		},
	};
	const responder: Actor<ItOpsState> = {
		id: "responder",
		step: ({ state, wake }) => {
			const id = String(wake.data?.id), inc = state.incidents[id];
			if (!inc || inc.status !== "open") return {};
			const generic = ["restart", "scale", "rollback"] as const;
			const action: Action = policy === "oracle" ? rightFix(inc.cause) : { type: generic[inc.attempts % 3], service: inc.service, replicas: state.replicas[inc.service] + 1 };
			const { outcome, note } = judge(inc.cause, action);
			const events: any[] = [{ type: "fix.applied", actor: `responder:${policy}`, payload: { id, action, outcome, note } }];
			if (outcome === "resolved") events.push({ type: "incident.resolved", actor: `responder:${policy}`, payload: { id, by: `responder:${policy}` } });
			const again = outcome !== "resolved" && policy === "naive" && inc.attempts + 1 < 3;
			return { events, wakes: again ? [{ actor: "responder", in: HOUR, kind: "respond", data: { id } }] : [] };
		},
	};
	return {
		name: `itops:${policy}`,
		initial,
		reduce,
		actors: [chaos, escalator, responder, hands],
		start: (rng) => [{ actor: "chaos", at: nextArrival(0, rng), kind: "arrive" }],
	};
}
