import { DAY, HOUR } from "../engine.ts";
import type { WorldSpec } from "../types.ts";

/**
 * The smallest world that is still alive: customers arrive (busier by day than by night), a server finishes each one
 * after a random time, a clock closes every day, and a probe lets tests schedule exact wake-ups.
 * All of it is Tier 0 (rules and seeded randomness): no model, no cost.
 */
export type TickerState = { arrived: number; served: number; queue: number; days: number; pings: number };

const arrivalRate = (now: number) => { const h = Math.floor((now % DAY) / HOUR); return h >= 8 && h < 20 ? 6 : 1; }; // per virtual hour

export const tickerSpec: WorldSpec<TickerState> = {
	name: "ticker",
	initial: () => ({ arrived: 0, served: 0, queue: 0, days: 0, pings: 0 }),
	reduce(s, e) {
		switch (e.type) {
			case "customer.arrived": return { ...s, arrived: s.arrived + 1, queue: s.queue + 1 };
			case "customer.served": return { ...s, served: s.served + 1, queue: s.queue - 1 };
			case "day.closed": return { ...s, days: s.days + 1 };
			case "probe.pinged": return { ...s, pings: s.pings + 1 };
			default: return s;
		}
	},
	actors: [
		{
			id: "arrivals",
			step: ({ now, state, rng }) => ({
				events: [{ type: "customer.arrived", actor: "arrivals", payload: { id: state.arrived + 1 } }],
				wakes: [
					{ actor: "server", in: Math.ceil(rng.exp(5 / HOUR)), kind: "serve", data: { id: state.arrived + 1 } },
					{ actor: "arrivals", in: Math.ceil(rng.exp(arrivalRate(now) / HOUR)), kind: "arrive" },
				],
			}),
		},
		{ id: "server", step: ({ wake }) => ({ events: [{ type: "customer.served", actor: "server", payload: { id: wake.data?.id ?? null } }] }) },
		{
			id: "daily",
			step: ({ state }) => ({ events: [{ type: "day.closed", actor: "daily", payload: { arrived: state.arrived, served: state.served, queue: state.queue } }], wakes: [{ actor: "daily", in: DAY, kind: "close" }] }),
		},
		{ id: "probe", step: () => ({ events: [{ type: "probe.pinged", actor: "probe" }] }) },
	],
	start: (rng) => [
		{ actor: "arrivals", at: Math.ceil(rng.exp(1 / HOUR)), kind: "arrive" },
		{ actor: "daily", at: DAY, kind: "close" },
	],
};
