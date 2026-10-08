import { getOrigin, isActive, type HandoffService } from "./handoffs.ts";

/**
 * The run lifecycle of the recipient (observed by the runtime's Mirror) is what moves a handoff forward:
 *   durable submit -> accepted;  run start -> in_progress;  run end -> completed;  task failure -> failed.
 * "Completed" means the recipient finished a run and answered: it does not prove the work is right.
 */
export function runStarted(svc: HandoffService, channelId: string, agentId: string) {
	// The run can begin before the dispatcher has recorded the acknowledgement; a started run proves the submission was taken.
	for (const h of svc.activeFor(channelId, agentId)) {
		if (h.status === "requested") svc.accept(h.handoffId, `agent:${agentId}`);
		svc.start(h.handoffId, `agent:${agentId}`);
	}
}

export function runEnded(svc: HandoffService, channelId: string, agentId: string, resultRef: string | null) {
	// A run drains everything queued for the conversation, so every active handoff of this recipient is answered by it.
	for (const h of svc.activeFor(channelId, agentId)) if (h.status === "accepted" || h.status === "in_progress") svc.complete(h.handoffId, `agent:${agentId}`, resultRef ?? undefined);
}

export function runFailed(svc: HandoffService, channelId: string, agentId: string, message: string) {
	for (const h of svc.activeFor(channelId, agentId)) if (isActive(h.status) && h.status !== "requested") svc.fail(h.handoffId, `agent:${agentId}`, message.slice(0, 300));
}

/** The depth and starter of the chain the agent is working on (0 and null when a person addressed it directly). */
export const chainOf = (db: import("node:sqlite").DatabaseSync, channelId: string, agentId: string) => getOrigin(db, channelId, agentId);
