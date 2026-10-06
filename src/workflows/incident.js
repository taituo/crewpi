// Deterministic workflow code (runs in Temporal's sandbox: only @temporalio/workflow imports, no I/O).
// Temporal owns the PROCESS (what step we are in, timers, retries, waiting for a person); the agents are
// activities that do the thinking. Kill the worker at any point and the workflow resumes where it was.
import { proxyActivities, defineSignal, defineQuery, setHandler, condition, sleep, workflowInfo } from "@temporalio/workflow";

const act = proxyActivities({
	startToCloseTimeout: "8 minutes",
	heartbeatTimeout: "90 seconds",
	retry: { initialInterval: "5 seconds", backoffCoefficient: 2, maximumInterval: "1 minute", maximumAttempts: 3 },
});
// An agent that asks for human approval can legitimately wait a long time; heartbeats keep the activity alive.
const longAct = proxyActivities({ startToCloseTimeout: "2 hours", heartbeatTimeout: "90 seconds", retry: { maximumAttempts: 2 } });

export const decisionSignal = defineSignal("decision");
export const statusQuery = defineQuery("status");

/**
 * input: { channelId, ticket?, brief, lead?, monitorSeconds?, decisionTimeoutMinutes? }
 */
export async function incidentWorkflow(input) {
	const id = workflowInfo().workflowId;
	const channelId = input.channelId;
	let step = "starting";
	let decision;
	const steps = [];
	const mark = (name, detail) => steps.push({ name, detail: String(detail ?? "").slice(0, 300) });
	setHandler(decisionSignal, (d) => { decision = d; });
	setHandler(statusQuery, () => ({ step, steps, decision: decision ?? null }));

	try {
		await act.postNotice({ channelId, text: `Workflow ${id} started: diagnose → plan → human decision → execute → monitor → verify → close.` });

		step = "diagnose";
		const diagnosis = await act.askAgent({ channelId, agent: input.lead ?? "insight", key: "diagnose",
			text: `Diagnose this situation: ${input.brief}\nGive a short root-cause hypothesis with the evidence you actually saw (cite ids). Do not change anything.` });
		mark("diagnose", diagnosis);

		step = "plan";
		const plan = await act.askAgent({ channelId, agent: "ops", key: "plan",
			text: `Diagnosis so far:\n${diagnosis}\n\nPropose the safest next action in at most 3 lines, or say that no action is needed. Do not change anything yet.` });
		mark("plan", plan);

		step = "await-human";
		await act.postDecisionCard({ channelId, workflowId: id, plan });
		const got = await condition(() => decision !== undefined, input.decisionTimeoutMs ?? (input.decisionTimeoutMinutes ?? 30) * 60_000);
		if (!got) {
			step = "timed-out";
			await act.postNotice({ channelId, text: `Workflow ${id}: no decision within ${input.decisionTimeoutMinutes ?? 30} minutes. The case stays open; nothing was changed.` });
			return { outcome: "timed-out", steps };
		}
		mark("decision", `${decision.decision} by ${decision.by ?? "?"}${decision.note ? ": " + decision.note : ""}`);

		if (decision.decision === "abort") {
			step = "aborted";
			await act.postNotice({ channelId, text: `Workflow ${id} stopped by ${decision.by ?? "a person"}. Nothing was changed; the case stays open.` });
			return { outcome: "aborted", steps };
		}

		if (decision.decision === "continue") {
			step = "execute";
			const result = await longAct.askAgent({ channelId, agent: "ops", key: "execute",
				text: `A person (${decision.by ?? "approver"}) approved continuing${decision.note ? `: "${decision.note}"` : ""}.\nPlan:\n${plan}\n\nCarry it out with your tools. Anything that changes a system still needs the approval request. Report exactly what happened.` });
			mark("execute", result);

			step = "monitor";
			await sleep((input.monitorSeconds ?? 120) * 1000);

			step = "verify";
			const verdict = await act.askAgent({ channelId, agent: "insight", key: "verify",
				text: `Verify the situation after the action (${input.brief}). Chart the relevant metric and say plainly whether it recovered.` });
			mark("verify", verdict);
		}

		step = "close";
		await act.closeCase({ channelId, ticket: input.ticket ?? null, resolution: steps.map((s) => `${s.name}: ${s.detail}`).join("\n") });
		step = "done";
		return { outcome: decision.decision === "continue" ? "resolved" : "closed", steps };
	} catch (e) {
		step = "failed";
		await act.postNotice({ channelId, text: `Workflow ${id} failed: ${String(e?.cause?.message ?? e?.message ?? e).slice(0, 300)}` }).catch(() => {});
		throw e;
	}
}
