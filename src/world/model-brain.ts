// Tier 2 brain: a language model reached through an OpenAI-compatible chat endpoint (the inference gateway), with the synthetic tools.
// It sees what a real agent would see: tool names, parameters and answers. Nothing else of the world.
import type { Brain, Session } from "./agents.ts";
import { toolCatalog } from "./itops/tools.ts";

export type ModelBrainOptions = {
	baseUrl: string;
	apiKey: string;
	model: string;
	role: "ops";
	maxTurns?: number;
	timeoutMs?: number;
	/** Prefix of the sticky-routing session id (the gateway keeps one session on one account to keep its cache warm). */
	sessionPrefix?: string;
};

const NUMBERS = new Set(["replicas", "value", "tail", "minutes"]);
const DOCS: Record<string, string> = {
	k8s_pods: "List the pods in a namespace with readiness, restarts and state.",
	k8s_events: "Recent Kubernetes events in a namespace, optionally for one object.",
	k8s_logs: "Logs of a pod (or the first pod of a deployment).",
	k8s_configmap: "Show a ConfigMap.",
	k8s_deployments: "List deployments with ready replicas and image.",
	jira_search: "Search tickets by text, status or assignee.",
	jira_get: "Show one ticket by key.",
	grafana_query: "Query a metric over the last minutes.",
	k8s_restart: "Restart a deployment.",
	k8s_scale: "Scale a deployment to a number of replicas.",
	k8s_rollback: "Roll a deployment back to its previous version.",
	k8s_set_config: "Change POOL_SIZE in a ConfigMap.",
	cert_rotate: "Rotate the TLS certificate of a service.",
	db_failover: "Fail a database service over to its standby.",
	alert_dismiss: "Dismiss the alerts of a service.",
};

const SYSTEM = {
	ops: "You are the on-call operations engineer of a small company. Production runs in the namespace \"prod\". Look at the open tickets, find out what is really wrong from logs, events and configuration, and fix it with the tools you have. Only act when you have evidence; a wrong fix can make things worse. When you are done, or there is nothing to do, answer in one or two sentences.",
};

const clock = (ms: number) => { const m = Math.floor(ms / 60_000); return `day ${Math.floor(m / 1440)}, ${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

export function modelBrain(o: ModelBrainOptions): Brain {
	const maxTurns = o.maxTurns ?? 12, timeoutMs = o.timeoutMs ?? 120_000;
	const tools = toolCatalog().map((t) => ({
		type: "function",
		function: {
			name: t.name,
			description: DOCS[t.name] ?? t.name,
			parameters: { type: "object", properties: Object.fromEntries(t.params.map((p) => [p, { type: NUMBERS.has(p) ? "number" : p === "previous" ? "boolean" : "string" }])) },
		},
	}));
	return {
		tier: 2,
		name: `model:${o.model}`,
		async shift(s: Session) {
			const messages: any[] = [{ role: "system", content: SYSTEM[o.role] }, { role: "user", content: `Shift start, ${clock(s.now())}. Check the open tickets and handle what you can.` }];
			let turn = 0;
			try {
				for (turn = 1; turn <= maxTurns; turn++) {
					const res = await fetch(`${o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
						method: "POST",
						headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}`, "x-session-id": `${o.sessionPrefix ?? "crew-world"}:${s.agent}` },
						body: JSON.stringify({ model: o.model, messages, tools }),
						signal: AbortSignal.timeout(timeoutMs),
					}).catch((e) => { throw new Error(`model request failed: ${(e as Error).name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : (e as Error).message}`); });
					if (!res.ok) throw new Error(`model request failed: HTTP ${res.status}`);
					const msg = ((await res.json()) as any).choices?.[0]?.message;
					if (!msg) throw new Error("model request failed: no message in the response");
					messages.push({ role: "assistant", content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
					if (!msg.tool_calls?.length) return { units: turn };
					for (const c of msg.tool_calls) {
						let out: string;
						try {
							const args = JSON.parse(c.function.arguments || "{}");
							if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error("not an object");
							out = (await s.call(c.function.name, args)).text;
						} catch (e) {
							out = (e as Error).message === "not an object" || e instanceof SyntaxError ? "Error: the arguments must be a JSON object" : `Error: ${(e as Error).message}`;
						}
						messages.push({ role: "tool", tool_call_id: c.id, content: out });
					}
				}
				throw new Error(`the model used more than ${maxTurns} turns without finishing`);
			} catch (e) {
				// a shift that fails has still spent its requests: say so, so a budget can see a stuck model
				throw Object.assign(e as Error, { shift: { units: Math.min(turn, maxTurns) } });
			}
		},
	};
}
