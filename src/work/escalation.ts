import { config } from "../config.ts";
import { HandoffError, type Handoff, type HandoffService } from "./handoffs.ts";

/**
 * Escalation: the one place that decides what happens when a handoff is not acknowledged, is rejected, fails or is overdue.
 * Called by the Temporal watchdog (an activity) and by nothing else, so there is one owner of the decision.
 * With a backup the task is re-requested from the backup (a new handoff, caused by the escalated one);
 * without one it only becomes `escalated`, and the notify consumer tells the channel and the people who must be informed.
 */
export function escalate(svc: HandoffService, handoffId: string, reason: string): { handoff: Handoff; rerouted: Handoff | null } {
	const r = svc.transition(handoffId, "escalated", { by: "watchdog", byType: "workflow", reason });
	if (!r.changed) return { handoff: r.handoff, rerouted: null };
	const h = r.handoff;
	if (!h.backup || h.backup === h.to) return { handoff: h, rerouted: null };
	try {
		const next = svc.request({
			requestId: `${h.requestId}:esc`, channelId: h.channelId, from: h.from, to: h.backup, backup: null,
			text: `[escalated: ${reason}; this was asked of @${h.to}] ${h.text}`, correlationId: h.correlationId, causationId: h.requestedEventId ?? undefined,
			originSub: h.originSub, requesterDepth: Math.max(0, h.depth - 1), parentHandoffId: h.handoffId,
			ackWithinMs: config.handoff.ackWithinMs, dueInMs: config.handoff.dueInMs, fromType: "internal_agent",
		});
		return { handoff: h, rerouted: next.handoff };
	} catch (e) {
		if (e instanceof HandoffError) return { handoff: h, rerouted: null }; // limits hit: the notice tells the humans instead
		throw e;
	}
}
