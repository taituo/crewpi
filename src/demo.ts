import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

/**
 * Scripted offline "brains" so the whole workspace (channels, tools, approvals, delegation) can be demoed
 * and tested without an inference key. They are NOT intelligent: they follow one incident playbook, but
 * every tool call is real and goes through the same Pi Durable machinery as a real model would.
 */

type Msg = any;
type ToolResult = { name: string; text: string; isError: boolean };

function lastUserText(messages: Msg[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user") {
			return typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
		}
	}
	return "";
}

/** Tool results produced since the latest user message, oldest first. */
function resultsSinceUser(messages: Msg[]): ToolResult[] {
	let start = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			start = i + 1;
			break;
		}
	}
	return messages
		.slice(start)
		.filter((m) => m.role === "toolResult")
		.map((m) => ({
			name: m.toolName,
			isError: !!m.isError,
			text: (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"),
		}));
}

type Step = { tool: string; args: (r: ToolResult[], user: string) => Record<string, unknown>; say?: string };
type Playbook = { match: RegExp; steps: Step[]; final: (r: ToolResult[], user: string) => string };

const NS = "demo-apps";
const CFG = "demo-apps/checkout-config.json";
/** Last real log line, ignoring errors and the tool's own notes. */
const lastLogLine = (r?: ToolResult) =>
	!r || r.isError ? undefined : r.text.split("\n").filter((l) => l.trim() && !l.startsWith("(")).pop() || undefined;
const branchIn = (s: string) => /agent\/[\w.-]+/.exec(s)?.[0];

const crashingPod = (r: ToolResult[]) => {
	const pods = r.find((x) => x.name === "k8s_pods")?.text ?? "";
	const line = pods.split("\n").find((l) => /CrashLoopBackOff|Error|restarts=[1-9]/.test(l)) ?? pods.split("\n")[0] ?? "";
	return line.split(/\s+/)[0] || "checkout-api";
};

const BRAINS: Record<string, Playbook[]> = {
	ops: [
		{
			// A reviewed fix is ready: apply it (human approves), then verify.
			match: /agent\/[\w.-]+/,
			steps: [
				{
					tool: "k8s_apply_from_repo",
					args: (_r, u) => ({
						ref: branchIn(u),
						path: CFG,
						restart: "checkout-api",
						reason: "Reviewer approved the branch; it fixes POOL_SIZE=0, which crash-loops checkout-api.",
					}),
					say: "Reviewed fix is ready. Requesting approval to apply it and restart checkout-api.",
				},
				{ tool: "k8s_pods", args: () => ({ namespace: NS }), say: "Verifying the rollout." },
			],
			final: (r) => {
				const applied = r.find((x) => x.name === "k8s_apply_from_repo")?.text ?? "";
				const pods = r.find((x) => x.name === "k8s_pods")?.text ?? "";
				if (/REJECTED/.test(applied)) return `The change was rejected, so I made no changes.\n\n${applied}`;
				if (/Error:/.test(applied)) return `I could not apply the change: ${applied}`;
				return `${applied}\n\nPods now:\n${pods}\n\nStatus: remediation applied. I will keep an eye on restarts.`;
			},
		},
		{
			match: /(tutki|investigat|check|alert|checkout|crash|down|hidas|slow|status|tilanne|selvit|miksi|why|fail|restart|prod)/i,
			steps: [
				{ tool: "k8s_pods", args: () => ({ namespace: NS }), say: "Looking at the pods first." },
				{ tool: "k8s_events", args: () => ({ namespace: NS }), say: "Checking recent events." },
				{ tool: "k8s_logs", args: (r) => ({ namespace: NS, pod: crashingPod(r), previous: true, tail: 20 }), say: "Reading the crashed container's log." },
				{ tool: "k8s_configmap", args: () => ({ namespace: NS, name: "checkout-config" }), say: "Comparing with the configuration." },
				{
					tool: "ask_agent",
					args: (r) => ({
						agent: "developer",
						request:
							`checkout-api in ${NS} is in CrashLoopBackOff. ${(() => { const l = lastLogLine(r.find((x) => x.name === "k8s_logs")); return l ? `The log says: "${l}". ` : ""; })()}` +
							`The live ConfigMap checkout-config has POOL_SIZE=0. The desired state is in the platform-config repo at ${CFG}. ` +
							`Please fix it on a branch (POOL_SIZE must be a positive integer, 10 is the usual value), commit, then ask @reviewer to review.`,
					}),
				},
			],
			final: (r) => {
				const logRes = r.find((x) => x.name === "k8s_logs");
				const logs = lastLogLine(logRes);
				return (
					`**Root cause:** checkout-api crash-loops because \`POOL_SIZE=0\` in ConfigMap \`checkout-config\`.\n\n` +
					`Evidence: the container exits with code 1 right after start and ${logs ? `its last log line is \`${logs}\`` : "its log was not retrievable"}; the events show BackOff restarts.\n\n` +
					`I asked @developer to prepare a fix in the repo. Once it is reviewed I will request your approval to apply it.`
				);
			},
		},
	],
	developer: [
		{
			match: /(fix|korjaa|POOL_SIZE|checkout|config|branch|repo|crash)/i,
			steps: [
				{ tool: "repo_read", args: () => ({ path: CFG }), say: "Reading the current desired state." },
				{
					tool: "repo_write",
					args: (r) => {
						// Raw text edit keeps the diff to the one changed line.
						const raw = r.find((x) => x.name === "repo_read")?.text ?? "";
						return {
							branch: "agent/fix-checkout-pool-size",
							path: CFG,
							content: raw.replace(/("POOL_SIZE"\s*:\s*)"0"/, '$1"10"'),
							message: "checkout-config: set POOL_SIZE=10 (0 crash-loops the service)",
						};
					},
					say: "Committing the fix on a branch.",
				},
				{ tool: "repo_diff", args: () => ({ branch: "agent/fix-checkout-pool-size" }) },
				{
					tool: "ask_agent",
					args: () => ({
						agent: "reviewer",
						request:
							"Please review branch agent/fix-checkout-pool-size in the platform-config repo (file demo-apps/checkout-config.json). " +
							"Problem: checkout-api crash-loops because POOL_SIZE=0. Change: POOL_SIZE 0 -> 10, nothing else. Reply with APPROVE or CHANGES REQUESTED.",
					}),
				},
			],
			final: (r) => {
				const w = r.find((x) => x.name === "repo_write")?.text ?? "";
				const d = r.find((x) => x.name === "repo_diff")?.text ?? "";
				return `${w}\n\nDiff:\n\`\`\`diff\n${d.split("\n").filter((l) => /^[+-][^+-]/.test(l)).join("\n")}\n\`\`\`\nI asked @reviewer to check branch \`agent/fix-checkout-pool-size\`.`;
			},
		},
	],
	reviewer: [
		{
			match: /agent\/[\w.-]+/,
			steps: [
				{ tool: "repo_diff", args: (_r, u) => ({ branch: branchIn(u) }), say: "Reading the diff." },
				{ tool: "repo_read", args: (_r, u) => ({ path: CFG, ref: branchIn(u) }), say: "Checking the whole file on the branch." },
				{
					tool: "ask_agent",
					args: (_r, u) => ({
						agent: "ops",
						request: `Review verdict APPROVE for branch ${branchIn(u)}: demo-apps/checkout-config.json only changes POOL_SIZE from 0 to 10. It is ready to apply with k8s_apply_from_repo (restart checkout-api).`,
					}),
				},
			],
			final: (r, u) => {
				const diff = r.find((x) => x.name === "repo_diff")?.text ?? "";
				const changed = diff.split("\n").filter((l) => /^[+-][^+-]/.test(l));
				const ok = changed.length === 2 && /POOL_SIZE/.test(changed.join()) && /"10"/.test(changed.join());
				return ok
					? `**APPROVE** \`${branchIn(u)}\`.\n\nThe diff touches only \`POOL_SIZE\` ("0" -> "10"), valid JSON, no other keys affected. Blast radius is one ConfigMap in demo-apps. I told @ops it is ready to apply.`
					: `**CHANGES REQUESTED** on \`${branchIn(u)}\`: the diff does more than the stated one-line change.\n\n${changed.join("\n")}`;
			},
		},
	],
};

BRAINS.insight = [
	{
		match: /(grafana|metric|latency|5xx|error rate|graaf|kaavio|chart|cpu|restart)/i,
		steps: [{ tool: "grafana_query", args: (_r, u) => ({ metric: /latency|viive|hidas/i.test(u) ? "checkout_latency_p95_ms" : /restart/i.test(u) ? "checkout_pod_restarts" : "checkout_5xx_rate", minutes: 90 }) }],
		final: (r) => `${r[0]?.text.split("\n")[0] ?? ""}\n\nThe chart above shows the series; the step change about 42 minutes ago lines up with the checkout-api crash loop (PAY-412).`,
	},
	{ match: /(temporal|workflow)/i, steps: [{ tool: "temporal_workflows", args: () => ({}) }], final: (r) => `Workflows:\n${r[0]?.text}` },
	{ match: /(ci|pipeline|build|github|gitlab)/i, steps: [{ tool: "ci_runs", args: () => ({}) }], final: (r) => `Recent CI runs:\n${r[0]?.text}` },
	{ match: /(jira|ticket|issue)/i, steps: [{ tool: "jira_search", args: () => ({}) }], final: (r) => `Tickets:\n${r[0]?.text}` },
	{ match: /(env|status|ympäristö|tilanne|prod|staging)/i, steps: [{ tool: "env_status", args: () => ({}) }], final: (r) => `Environment status:\n${r[0]?.text}` },
];

const GREETING: Record<string, string> = {
	insight: "I'm Insight. Ask me about metrics (e.g. \"@insight show checkout 5xx rate\"), CI, Temporal workflows, tickets or environment status.",
	ops: "I'm Ops, the SRE agent. Ask me to look at `demo-apps` (e.g. \"@ops tutki checkout-api\").",
	developer: "I'm Developer. I change the platform-config repo on branches; ask me for a fix.",
	reviewer: "I'm Reviewer. Give me a branch name (agent/...) and I'll review the diff.",
};

export function createDemoProvider() {
	const faux = fauxProvider({
		provider: "demo",
		models: [
			{ id: "ops", name: "Scripted Ops" },
			{ id: "developer", name: "Scripted Developer" },
			{ id: "reviewer", name: "Scripted Reviewer" },
			{ id: "insight", name: "Scripted Insight" },
		],
		tokensPerSecond: 120,
	});

	const factory = (context: any, _options: any, _state: any, model: any) => {
		faux.appendResponses([factory]); // keep the queue topped up; each call consumes one
		const agent = String(model.id);
		const messages: Msg[] = context.messages ?? [];
		const user = lastUserText(messages);
		const results = resultsSinceUser(messages);
		const book = (BRAINS[agent] ?? []).find((b) => b.match.test(user));
		if (!book) return fauxAssistantMessage(fauxText(GREETING[agent] ?? "Hello."));
		const step = book.steps[results.length];
		if (!step) return fauxAssistantMessage(fauxText(book.final(results, user)));
		const blocks = [...(step.say ? [fauxText(step.say)] : []), fauxToolCall(step.tool, step.args(results, user) as any)];
		return fauxAssistantMessage(blocks, { stopReason: "toolUse" });
	};
	faux.setResponses(Array.from({ length: 16 }, () => factory));
	return faux;
}
