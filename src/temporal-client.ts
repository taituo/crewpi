import { Client, Connection } from "@temporalio/client";
import { config } from "./config.ts";

/** Temporal client helpers (no worker, no activities: safe to import anywhere). Everything degrades to "workflows unavailable" when no server is configured. */

let client: Client | undefined;
let connecting: Promise<Client | undefined> | undefined;
export const temporalConfigured = () => !!config.temporal.address;

export async function getClient(): Promise<Client | undefined> {
	if (!temporalConfigured()) return undefined;
	if (client) return client;
	connecting ??= (async () => {
		try {
			const connection = await Connection.connect({ address: config.temporal.address, connectTimeout: 4000 });
			client = new Client({ connection, namespace: config.temporal.namespace });
			return client;
		} catch {
			return undefined;
		} finally {
			connecting = undefined;
		}
	})();
	return connecting;
}

export const incidentWorkflowId = (channelId: string) => `incident-${channelId}`;

export type IncidentInput = { channelId: string; ticket?: string | null; brief: string; lead?: string; monitorSeconds?: number; decisionTimeoutMinutes?: number };

export async function startIncident(input: IncidentInput): Promise<{ workflowId: string; started: boolean }> {
	const c = await getClient();
	if (!c) throw new Error("Temporal is not available");
	const workflowId = incidentWorkflowId(input.channelId);
	try {
		// ALLOW_DUPLICATE: a closed case can be run again; a running one is still refused (AlreadyStarted below).
		await c.workflow.start("incidentWorkflow", { taskQueue: config.temporal.taskQueue, workflowId, args: [input], workflowIdReusePolicy: "ALLOW_DUPLICATE" as any });
		return { workflowId, started: true };
	} catch (e) {
		if ((e as Error).name === "WorkflowExecutionAlreadyStartedError") return { workflowId, started: false };
		throw e;
	}
}

export async function signalDecision(workflowId: string, d: { decision: "continue" | "close" | "abort"; by: string; note?: string }) {
	const c = await getClient();
	if (!c) throw new Error("Temporal is not available");
	await c.workflow.getHandle(workflowId).signal("decision", d);
}

export type LiveWorkflow = { id: string; type: string; status: string; startedAt: number; closedAt: number | null; step?: string; channelId?: string };

export async function listLive(limit = 15): Promise<LiveWorkflow[]> {
	const c = await getClient();
	if (!c) return [];
	const out: LiveWorkflow[] = [];
	const seen = new Set<string>();
	for await (const w of c.workflow.list({ pageSize: limit * 2 })) {
		if (seen.has(w.workflowId)) continue; // newest run first: older runs of the same id are history
		seen.add(w.workflowId);
		out.push({ id: w.workflowId, type: w.type, status: w.status.name, startedAt: w.startTime.getTime(), closedAt: w.closeTime ? w.closeTime.getTime() : null, channelId: w.workflowId.replace(/^incident-/, "") });
		if (out.length >= limit) break;
	}
	await Promise.all(out.filter((w) => w.status === "RUNNING").map(async (w) => {
		try { w.step = (await c.workflow.getHandle(w.id).query<{ step: string }>("status")).step; } catch { /* not queryable yet */ }
	}));
	return out;
}

export async function describeLive(id: string) {
	const c = await getClient();
	if (!c) return undefined;
	const h = c.workflow.getHandle(id);
	const d = await h.describe();
	let status: any; try { status = await h.query("status"); } catch { /* closed or not ready */ }
	return { id, type: d.type, status: d.status.name, startedAt: d.startTime.getTime(), closedAt: d.closeTime?.getTime() ?? null, taskQueue: d.taskQueue, pending: d.raw.pendingActivities?.map((a) => `${a.activityType?.name} attempt ${a.attempt}`) ?? [], status_query: status };
}

export async function historyLive(id: string, max = 40) {
	const c = await getClient();
	if (!c) return [];
	const h = await c.workflow.getHandle(id).fetchHistory();
	return (h.events ?? []).slice(0, max).map((e: any, i: number) => `${i + 1}  ${e.eventTime ? new Date(Number(e.eventTime.seconds) * 1000).toISOString().slice(11, 19) : ""}  ${String(e.eventType).replace("EVENT_TYPE_", "")}`);
}

// ---- handoff watchdog ------------------------------------------------------------------------------------------------

export const handoffWorkflowId = (handoffId: string) => `handoff:${handoffId}`;

/** One workflow per handoff, started with a stable id, so a repeated start is harmless. */
export async function startHandoffWatch(input: { handoffId: string; ackWithinMs?: number; dueAtMs?: number }): Promise<boolean> {
	const c = await getClient();
	if (!c) throw new Error("Temporal is not available");
	try {
		await c.workflow.start("handoffWorkflow", { taskQueue: config.temporal.taskQueue, workflowId: handoffWorkflowId(input.handoffId), args: [input] });
		return true;
	} catch (e) {
		if ((e as Error).name === "WorkflowExecutionAlreadyStartedError") return false;
		throw e;
	}
}

export async function signalHandoff(handoffId: string, status: string): Promise<void> {
	const c = await getClient();
	if (!c) throw new Error("Temporal is not available");
	try {
		await c.workflow.getHandle(handoffWorkflowId(handoffId)).signal("handoffState", { status });
	} catch (e) {
		// A finished (or never started) watchdog has nothing left to watch.
		if (/not found|already completed|completed/i.test((e as Error).message)) return;
		throw e;
	}
}
