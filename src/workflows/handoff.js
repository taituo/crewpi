// Deterministic workflow code (runs in Temporal's sandbox: only @temporalio/workflow imports, no I/O).
// Temporal owns only the clock of a handoff: "was it picked up in time?" and "was it finished in time?".
// The business status lives in the handoffs row; the workflow is told about changes by signal and holds only ids.
import { proxyActivities, defineSignal, defineQuery, setHandler, condition } from "@temporalio/workflow";

const act = proxyActivities({ startToCloseTimeout: "1 minute", retry: { initialInterval: "2 seconds", backoffCoefficient: 2, maximumInterval: "30 seconds", maximumAttempts: 6 } });

export const handoffStateSignal = defineSignal("handoffState");
export const handoffStatusQuery = defineQuery("status");

const FINAL = ["completed", "failed", "rejected", "escalated", "cancelled"];

/** input: { handoffId, ackWithinMs?, dueAtMs? } */
export async function handoffWorkflow(input) {
	let status = "requested";
	setHandler(handoffStateSignal, (s) => { status = s.status; });
	setHandler(handoffStatusQuery, () => ({ status, handoffId: input.handoffId }));

	// 1. Somebody has to take it.
	if (input.ackWithinMs) {
		const acknowledged = await condition(() => status !== "requested", input.ackWithinMs);
		if (!acknowledged) {
			await act.escalateHandoff({ handoffId: input.handoffId, reason: "not acknowledged in time" });
			return { outcome: "escalated", why: "no-ack" };
		}
	}
	// 2. It has to be finished by the due time.
	if (input.dueAtMs) {
		const finished = await condition(() => FINAL.includes(status), Math.max(1, input.dueAtMs - Date.now()));
		if (!finished) {
			await act.escalateHandoff({ handoffId: input.handoffId, reason: "overdue" });
			return { outcome: "escalated", why: "overdue" };
		}
	} else {
		await condition(() => FINAL.includes(status));
	}
	// 3. A rejection or a failure is not the end of the matter: somebody else has to look at it.
	if (status === "failed" || status === "rejected") {
		await act.escalateHandoff({ handoffId: input.handoffId, reason: status });
		return { outcome: "escalated", why: status };
	}
	return { outcome: status };
}
