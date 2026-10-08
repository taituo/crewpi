import { Context } from "@temporalio/activity";
import { agentById } from "./agents.ts";
import { channelById, setChannelStatus } from "./channels.ts";
import { store } from "./db.ts";
import * as f from "./fakes.ts";
import { hub } from "./hub.ts";
import { askAgentAndWait } from "./runtime.ts";
import { stopSandbox } from "./sandbox.ts";
import { handoffs } from "./work/index.ts";
import { escalate } from "./work/escalation.ts";

/** Activities run in the workspace process: this is where a workflow reaches the agents and the channels. */

const post = (channelId: string, text: string, meta: Record<string, unknown> = { kind: "notice" }, authorName = "Workflow") => {
	if (!channelById(channelId)) throw new Error(`no channel ${channelId}`);
	const m = store.addMessage({ channelId, authorKind: "system", authorId: "workflow", authorName, text, meta });
	hub.publish({ type: "message", message: m });
	return m;
};

export async function postNotice(a: { channelId: string; text: string }) {
	post(a.channelId, a.text);
}

export async function askAgent(a: { channelId: string; agent: string; text: string; key: string }): Promise<string> {
	const info = Context.current().info;
	if (!agentById(a.agent)) throw new Error(`no agent ${a.agent}`);
	const r = await askAgentAndWait({
		channelId: a.channelId, agentId: a.agent, text: a.text,
		requestId: `wf:${info.workflowExecution?.workflowId ?? "unknown"}:${a.key}`, // stable across retries and worker restarts
		from: { name: "Workflow" },
		onWait: () => Context.current().heartbeat(),
	});
	return r.text;
}

export async function postDecisionCard(a: { channelId: string; workflowId: string; plan: string }) {
	post(a.channelId, "Workflow is waiting for a decision", { kind: "workflow", workflowId: a.workflowId, plan: a.plan, status: "waiting" });
}

export async function closeCase(a: { channelId: string; ticket: string | null; resolution: string }) {
	if (a.ticket) {
		const issue = f.findIssue(a.ticket);
		if (issue) { issue.status = "Done"; issue.updated = new Date().toISOString(); issue.comments.push({ by: "Workflow", at: new Date().toISOString(), text: `Resolved by workflow. ${a.resolution.slice(0, 400)}` }); }
	}
	post(a.channelId, `Case closed by the workflow.\n${a.resolution.slice(0, 1500)}`, { kind: "notice" });
	store.audit("workflow", "case.close", { channel: a.channelId, ticket: a.ticket });
	setChannelStatus(a.channelId, "archived");
	void stopSandbox(a.channelId).catch(() => undefined);
}

/** The only caller of escalation: the handoff watchdog workflow. Idempotent, so Temporal may retry it freely. */
export async function escalateHandoff(a: { handoffId: string; reason: string }) {
	const r = escalate(handoffs, a.handoffId, a.reason);
	return { status: r.handoff.status, reroutedTo: r.rerouted?.to ?? null };
}
