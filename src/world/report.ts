import type { EventBus } from "../work/events.ts";
import type { RunReport } from "./types.ts";
import type { World } from "./engine.ts";

/**
 * Only a summary of a slice goes to the main event log (scope synthetic): a year is millions of world events and they
 * stay in the world's own file. The hash lets anyone check later that the file still tells the same story.
 */
export function announceSlice(bus: EventBus, world: World, report: RunReport) {
	const s = world.status();
	return bus.emit({
		type: "world.slice_finished", actorId: `world:${s.name}`, actorType: "system", correlationId: `world:${s.name}`, visibility: "org",
		scope: { mode: "synthetic", worldId: s.name, branchId: "main" },
		payload: { day: s.day, fromDay: report.fromDay, steps: report.steps, events: report.events, totalEvents: s.events, wallMs: report.wallMs, stopped: report.stopped, hash: s.hash },
	});
}
