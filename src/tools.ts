import { Type } from "@earendil-works/pi-ai";
import { CompactionTask, defineExtension, defineTool, hook, section } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { agentById } from "./agents.ts";
import { backupFor } from "./org/routing.ts";
import { handoffs } from "./work/index.ts";
import { getOrigin } from "./work/handoffs.ts";
import { newId } from "./work/events.ts";
import { agentsInChannel, channelById } from "./channels.ts";
import { isTicketKey, markCheckoutFixed, openCase } from "./cases.ts";
import { config } from "./config.ts";
import { db, store } from "./db.ts";
import { approvalBus, bridge, hub } from "./hub.ts";
import { assertName, assertReadable, assertWritable, kube } from "./kube.ts";
import { repo } from "./repo.ts";
import { InsightExtension } from "./tools-insight.ts";
import { SandboxExtension } from "./tools-sandbox.ts";
import { renderUi } from "./ui-spec.ts";
import { memorySection, recall, saveNote } from "./memory.ts";
import { fitView, lastLeafBefore, renderView, zoom } from "./optchat.ts";

const clip = (s: string, n = 6000) => (s.length > n ? `${s.slice(0, n)}\n... [truncated ${s.length - n} chars]` : s);
const text = (t: string) => ({ content: [{ type: "text" as const, text: clip(t) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] });

function where(conversationId: unknown) {
	const loc = bridge.locate?.(conversationId);
	if (!loc) throw new Error("conversation is not attached to a channel");
	return loc;
}

// ---------------------------------------------------------------- approval gate

/**
 * Opens (or finds, after a replay) the approval for this tool task, posts the card to the channel and
 * waits for a human verdict. The approval row, not memory, is the source of truth.
 */
async function gate(
	api: { taskId: unknown; conversationId: unknown },
	context: Context,
	req: { title: string; detail: Record<string, unknown> },
): Promise<{ approved: boolean; by: string | null; note: string | null }> {
	const { channelId, agentId } = where(api.conversationId);
	const { approval, created } = store.openApproval({ channelId, agentId, taskId: String(api.taskId), title: req.title, detail: req.detail, requestedBySub: getOrigin(db, channelId, agentId)?.originSub ?? undefined });
	if (created) {
		const agent = agentById(agentId)!;
		const msg = store.addMessage({
			channelId,
			authorKind: "system",
			authorId: agentId,
			authorName: agent.name,
			text: req.title,
			meta: { kind: "approval", approvalId: approval.id, status: "pending", detail: req.detail },
		});
		store.patchApprovalDetail(approval.id, { messageId: msg.id });
		store.audit(`agent:${agentId}`, "approval.requested", { approvalId: approval.id, title: req.title });
		hub.publish({ type: "message", message: msg });
		hub.publish({ type: "approval", approval: store.getApproval(approval.id) });
	}
	const signal = context.abortSignal;
	for (;;) {
		const cur = store.getApproval(approval.id)!;
		if (cur.status !== "pending") return { approved: cur.status === "approved", by: cur.decidedBy, note: cur.note };
		await new Promise<void>((resolve, reject) => {
			const done = () => {
				clearTimeout(timer);
				approvalBus.off("decided", onDecided);
				signal?.removeEventListener("abort", onAbort);
			};
			const onDecided = (id: number) => id === approval.id && (done(), resolve());
			const onAbort = () => (done(), reject(new Error("aborted while waiting for approval")));
			const timer = setTimeout(() => (done(), resolve()), 5000);
			approvalBus.on("decided", onDecided);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}

const verdict = (v: { approved: boolean; by: string | null; note: string | null }) =>
	v.approved
		? `APPROVED by ${v.by}${v.note ? ` (${v.note})` : ""}.`
		: `REJECTED by ${v.by}${v.note ? `: ${v.note}` : ""}. Do not retry or work around this; report it and stop.`;

// ---------------------------------------------------------------- collab

const askAgent = defineTool({
	name: "ask_agent",
	description:
		"Hand a task to another agent in THIS channel. The other agent cannot see your tool results, so the request must be self-contained. It answers in the channel; this call returns immediately.",
	parameters: Type.Object({
		agent: Type.String({ description: "Agent id, e.g. developer, reviewer, ops" }),
		request: Type.String({ description: "Self-contained request with all facts the other agent needs" }),
	}),
	replay: "safe",
	execute: async (args, api) => {
		try {
			const { channelId, agentId } = where(api.conversationId);
			const target = agentsInChannel(channelId).find((a) => a.id === args.agent.toLowerCase().replace(/^@/, ""));
			if (!target) throw new Error(`no agent "${args.agent}" in #${channelId}. Present: ${agentsInChannel(channelId).map((a) => a.id).join(", ")}`);
			if (target.id === agentId) throw new Error("cannot ask yourself");
			// A handoff: a durable record with an owner, a due time and an acknowledgement. The limits (depth, repeats, rate)
			// are checked against rows, so they survive a restart. Same request id as before: a replayed tool call is the same handoff.
			const origin = getOrigin(db, channelId, agentId);
			const { handoff, created } = handoffs.request({
				requestId: `ask:${String(api.taskId)}`, channelId, from: agentId, to: target.id, backup: backupFor(db, target.id), text: args.request,
				correlationId: origin?.correlationId ?? newId("corr"), originSub: origin?.originSub ?? null, requesterDepth: origin?.depth ?? 0, parentHandoffId: origin?.handoffId ?? null,
				ackWithinMs: config.handoff.ackWithinMs, dueInMs: config.handoff.dueInMs, fromType: "internal_agent",
			});
			return text(`${created ? "Asked" : "Already asked"} @${target.id}. Their answer will appear in #${channelId}. (handoff ${handoff.handoffId}: ${handoff.status})`);
		} catch (e) {
			return fail(e);
		}
	},
});

const requestApproval = defineTool({
	name: "request_approval",
	description:
		"Ask the humans in this channel to approve an action BEFORE you do it. Blocks until someone with the approver role decides. Only for actions you will then perform yourself with your own tools and that no other tool already gates. Never use it to request permissions, access or work you cannot do; tell the humans plainly what is blocked instead.",
	parameters: Type.Object({
		action: Type.String({ description: "What will be done, one line" }),
		target: Type.String({ description: "System or object affected" }),
		reason: Type.String({ description: "Why, with the evidence" }),
	}),
	replay: "safe",
	execute: async (args, api, context) => {
		try {
			const v = await gate(api, context, {
				title: `${args.action}`,
				detail: { action: args.action, target: args.target, reason: args.reason },
			});
			return text(verdict(v));
		} catch (e) {
			return fail(e);
		}
	},
});

const recentChannelOpens: number[] = [];

const openChannel = defineTool({
	name: "open_channel",
	description:
		"Open a dedicated case channel for a Jira ticket (or a topic) so people and agents can follow one situation in one place. Idempotent: the same ticket always maps to the same channel. A brief for the lead agent can be included; it starts working there. Use when work grows beyond the current channel or a ticket deserves its own room.",
	parameters: Type.Object({
		ticket: Type.Optional(Type.String({ description: "Jira key like PAY-412 (preferred)" })),
		topic: Type.Optional(Type.String({ description: "Topic when there is no ticket" })),
		brief: Type.Optional(Type.String({ description: "Self-contained task for the lead agent in the new channel" })),
		lead: Type.Optional(Type.String({ description: "Agent id that starts the work; default: you" })),
	}),
	replay: "safe",
	execute: async (args, api) => {
		try {
			const { channelId, agentId } = where(api.conversationId);
			if (channelById(channelId)?.kind === "dm") throw new Error("not available in a private chat: opening a shared channel could expose it. Tell the user what you would put in it and let them open the case themselves.");
			const now = Date.now();
			while (recentChannelOpens.length && now - recentChannelOpens[0] > 3_600_000) recentChannelOpens.shift();
			if (recentChannelOpens.length >= 6) throw new Error("channel limit reached (6 per hour); ask a human");
			const me = agentById(agentId)!;
			const { channel, created } = await openCase({
				...(args.ticket && isTicketKey(args.ticket) ? { ticket: args.ticket.toUpperCase() } : { topic: args.topic ?? args.ticket }),
				createdBy: `${me.name} (agent)`, source: "agent", notifyIn: channelId, brief: args.brief, lead: args.lead ?? agentId,
			});
			if (created) recentChannelOpens.push(now);
			return text(created ? `Opened #${channel.id}${args.brief ? " and briefed the lead agent" : ""}. Tell the user where to follow it.` : `#${channel.id} already exists; use it.`);
		} catch (e) {
			return fail(e);
		}
	},
});

const memoNote = defineTool({
	name: "memo_note",
	description:
		"Save one durable note to your memory (max 280 chars): a decision, an outcome, what was tried and failed, a person's preference, a recurring pattern. Not for chatter or things visible in the chat anyway. Notes survive restarts and appear at the top of your context. scope 'agent' (default) is remembered in every channel; 'channel' only here. In a private chat notes always stay private to that chat.",
	parameters: Type.Object({ text: Type.String(), scope: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("channel")])) }),
	replay: "safe",
	execute: async (args, api) => {
		try {
			const { channelId, agentId } = where(api.conversationId);
			const r = saveNote({ agentId, channelId, scope: args.scope, text: args.text, source: "agent" });
			return text(r.created ? `Saved note #${r.note.id} (${r.note.scope === "agent" ? "all channels" : "this channel"}).` : `Already remembered as #${r.note.id}.`);
		} catch (e) {
			return fail(e);
		}
	},
});

const memoRecall = defineTool({
	name: "memo_recall",
	description: "Search your saved notes (agent-wide and this channel's). All words in query must match; omit query for the newest notes.",
	parameters: Type.Object({ query: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
	replay: "safe",
	execute: async (args, api) => {
		try {
			const { channelId, agentId } = where(api.conversationId);
			const notes = recall(agentId, channelId, args.query, Math.floor(args.limit ?? 10));
			return text(notes.length ? notes.map((n) => `#${n.id} ${new Date(n.createdAt).toISOString().slice(0, 10)} [${n.scope === "agent" ? "all channels" : n.scope}] ${n.text}`).join("\n") : "no matching notes");
		} catch (e) {
			return fail(e);
		}
	},
});

const memoryZoom = defineTool({
	name: "memory_zoom",
	description:
		"Expand a line of the compressed conversation memory. Lines look like '#2.5 12 msgs ...'; zooming shows the finer lines below it, and a '#0.N' line shows the original message in full. Use it before relying on a detail that a coarse line only hints at.",
	parameters: Type.Object({ id: Type.String({ description: 'Line id such as "#2.5"' }) }),
	replay: "safe",
	execute: async (args, api) => {
		try {
			return text(zoom(Number(api.conversationId), args.id));
		} catch (e) {
			return fail(e);
		}
	},
});

export const CollabExtension = defineExtension({
	name: "collab",
	tools: [askAgent, requestApproval, openChannel, renderUi, memoNote, memoRecall, memoryZoom],
	hooks: [
		// When Pi compacts the context, replace its linear summary with the OptChat view of the WHOLE history
		// before the kept tail: recent messages verbatim, older ones ever coarser, every line zoomable.
		hook(CompactionTask, {
			beforeCompact: (c: any, api: any) => {
				const conv = Number(api.conversationId);
				const upTo = lastLeafBefore(conv, Number(c.firstKept));
				if (upTo < 3) return undefined; // too little recorded history: let Pi summarise as usual
				return { summary: renderView(conv, fitView(conv, upTo, config.optchat.viewBytes)) };
			},
		}),
	] as any,
	sections: [
		section("memory", (input) => {
			const loc = bridge.locate?.(input.conversationId);
			return loc ? memorySection(loc.agentId, loc.channelId) : undefined;
		}, { tag: false }),
	],
});

// ---------------------------------------------------------------- kubernetes

const ns = Type.String({ description: "Kubernetes namespace" });

const age = (iso?: string) => {
	if (!iso) return "?";
	const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

const podsTool = defineTool({
	name: "k8s_pods",
	description: "List pods in a namespace with phase, readiness, restarts and container state (waiting reason, last exit).",
	parameters: Type.Object({ namespace: ns }),
	replay: "safe",
	execute: async ({ namespace }) => {
		try {
			assertReadable(namespace);
			const r = await kube("GET", `/api/v1/namespaces/${namespace}/pods`);
			const lines = (r.items ?? []).map((p: any) => {
				const cs = p.status?.containerStatuses ?? [];
				const ready = `${cs.filter((c: any) => c.ready).length}/${cs.length || p.spec?.containers?.length || 0}`;
				const restarts = cs.reduce((n: number, c: any) => n + (c.restartCount ?? 0), 0);
				const state = cs
					.map((c: any) => {
						const w = c.state?.waiting;
						const t = c.state?.terminated;
						const last = c.lastState?.terminated;
						return w ? `waiting:${w.reason}` : t ? `terminated:${t.reason}(${t.exitCode})` : last ? `running (last exit ${last.exitCode} ${last.reason})` : "running";
					})
					.join(",");
				return `${p.metadata.name}  ${ready}  ${p.status?.phase}  restarts=${restarts}  ${state}  age=${age(p.metadata.creationTimestamp)}`;
			});
			return text(lines.length ? lines.join("\n") : `no pods in ${namespace}`);
		} catch (e) {
			return fail(e);
		}
	},
});

const eventsTool = defineTool({
	name: "k8s_events",
	description: "Recent events in a namespace, optionally only those about one object name.",
	parameters: Type.Object({ namespace: ns, object: Type.Optional(Type.String({ description: "Object name filter (substring)" })) }),
	replay: "safe",
	execute: async ({ namespace, object }) => {
		try {
			assertReadable(namespace);
			const r = await kube("GET", `/api/v1/namespaces/${namespace}/events`);
			const items = (r.items ?? [])
				.filter((e: any) => !object || (e.involvedObject?.name ?? "").includes(object))
				.sort((a: any, b: any) => Date.parse(a.lastTimestamp ?? a.eventTime ?? 0) - Date.parse(b.lastTimestamp ?? b.eventTime ?? 0))
				.slice(-25)
				.map((e: any) => `${age(e.lastTimestamp ?? e.eventTime)} ago  ${e.type}  ${e.reason}  ${e.involvedObject?.kind}/${e.involvedObject?.name}  x${e.count ?? 1}  ${e.message}`);
			return text(items.length ? items.join("\n") : "no matching events");
		} catch (e) {
			return fail(e);
		}
	},
});

const logsTool = defineTool({
	name: "k8s_logs",
	description: "Tail of a pod's container log. Use previous=true to read the log of the last crashed container instance.",
	parameters: Type.Object({
		namespace: ns,
		pod: Type.String(),
		previous: Type.Optional(Type.Boolean()),
		tail: Type.Optional(Type.Number({ description: "Lines, default 60, max 300" })),
	}),
	replay: "safe",
	execute: async ({ namespace, pod, previous, tail }) => {
		try {
			assertReadable(namespace);
			assertName("pod", pod);
			const n = Math.min(Math.max(Math.floor(tail ?? 60), 1), 300);
			const get = (prev: boolean) =>
				kube<string>("GET", `/api/v1/namespaces/${namespace}/pods/${pod}/log?tailLines=${n}${prev ? "&previous=true" : ""}`, undefined, { raw: true });
			let out = await get(!!previous).catch((e) => (previous ? "unable to retrieve container logs" : Promise.reject(e)));
			// The kubelet answers 200 with this sentence when the previous instance's log is not available (yet).
			if (previous && /^unable to retrieve container logs/.test(out.trim())) {
				const current = await get(false).catch((e: Error) => `(current container has no log either: ${e.message.slice(-120)})`);
				out = `(previous container log not available; showing the current container)\n${current}`;
			}
			return text(out.trim() || "(empty log)");
		} catch (e) {
			return fail(e);
		}
	},
});

const configMapTool = defineTool({
	name: "k8s_configmap",
	description: "Show a ConfigMap's data.",
	parameters: Type.Object({ namespace: ns, name: Type.String() }),
	replay: "safe",
	execute: async ({ namespace, name }) => {
		try {
			assertReadable(namespace);
			assertName("configmap", name);
			const r = await kube("GET", `/api/v1/namespaces/${namespace}/configmaps/${name}`);
			return text(Object.entries(r.data ?? {}).map(([k, v]) => `${k}=${v}`).join("\n") || "(no data)");
		} catch (e) {
			return fail(e);
		}
	},
});

const deploymentsTool = defineTool({
	name: "k8s_deployments",
	description: "List deployments with replica status and the ConfigMaps/env sources they use.",
	parameters: Type.Object({ namespace: ns }),
	replay: "safe",
	execute: async ({ namespace }) => {
		try {
			assertReadable(namespace);
			const r = await kube("GET", `/apis/apps/v1/namespaces/${namespace}/deployments`);
			const lines = (r.items ?? []).map((d: any) => {
				const c = d.spec?.template?.spec?.containers?.[0] ?? {};
				const cms = (c.envFrom ?? []).map((e: any) => e.configMapRef?.name).filter(Boolean);
				return `${d.metadata.name}  ready=${d.status?.readyReplicas ?? 0}/${d.spec?.replicas}  image=${c.image}  configmaps=${cms.join(",") || "-"}`;
			});
			return text(lines.join("\n") || `no deployments in ${namespace}`);
		} catch (e) {
			return fail(e);
		}
	},
});

const applyFromRepo = defineTool({
	name: "k8s_apply_from_repo",
	description:
		"Apply a ConfigMap manifest from the platform-config repo (any branch or main) to the cluster, optionally restarting a deployment afterwards. A human must approve; the approval card shows the exact before/after values. Blocks until decided.",
	parameters: Type.Object({
		ref: Type.String({ description: "Repo branch or main" }),
		path: Type.String({ description: "File in the repo, e.g. demo-apps/checkout-config.json" }),
		restart: Type.Optional(Type.String({ description: "Deployment to restart after applying" })),
		reason: Type.String({ description: "Why, with evidence and the reviewer verdict" }),
	}),
	replay: "safe",
	execute: async (args, api, context) => {
		try {
			const manifest = JSON.parse(await repo.read(args.path, args.ref));
			if (manifest.kind !== "ConfigMap") throw new Error("only ConfigMap manifests can be applied by agents");
			const namespace = manifest.metadata?.namespace;
			const name = manifest.metadata?.name;
			assertWritable(namespace);
			assertName("configmap", name);
			if (args.restart) assertName("deployment", args.restart);
			const live = await kube("GET", `/api/v1/namespaces/${namespace}/configmaps/${name}`);
			const changes = Object.keys({ ...(live.data ?? {}), ...(manifest.data ?? {}) })
				.filter((k) => (live.data ?? {})[k] !== (manifest.data ?? {})[k])
				.map((k) => ({ key: k, from: (live.data ?? {})[k] ?? null, to: (manifest.data ?? {})[k] ?? null }));
			if (!changes.length) return text("Live ConfigMap already matches the repo; nothing to apply.");
			const v = await gate(api, context, {
				title: `Apply ${namespace}/${name} from ${args.ref}${args.restart ? ` and restart ${args.restart}` : ""}`,
				detail: { action: "apply configmap", target: `${namespace}/${name}`, ref: args.ref, path: args.path, restart: args.restart ?? null, reason: args.reason, changes },
			});
			if (!v.approved) return text(verdict(v));
			// JSON merge patch: idempotent, so a replay after a crash is safe.
			await kube("PATCH", `/api/v1/namespaces/${namespace}/configmaps/${name}`, { data: manifest.data }, { contentType: "application/merge-patch+json" });
			let restarted = "";
			if (args.restart) {
				const at = await api.memo<string>("restart-at", new Date().toISOString(), context);
				await kube(
					"PATCH",
					`/apis/apps/v1/namespaces/${namespace}/deployments/${args.restart}`,
					{ spec: { template: { metadata: { annotations: { "crew.io/restarted-at": at } } } } },
					{ contentType: "application/merge-patch+json" },
				);
				restarted = ` Restarted deployment ${args.restart}.`;
			}
			if (namespace === "demo-apps" && changes.some((c) => c.key === "POOL_SIZE" && Number(c.to) > 0)) markCheckoutFixed();
			store.audit(`agent:${where(api.conversationId).agentId}`, "k8s.apply", { namespace, name, ref: args.ref, changes, approvedBy: v.by });
			return text(`${verdict(v)} Applied ${namespace}/${name}: ${changes.map((c) => `${c.key} ${c.from} -> ${c.to}`).join(", ")}.${restarted} Verify with k8s_pods.`);
		} catch (e) {
			return fail(e);
		}
	},
});

export const K8sExtension = defineExtension({
	name: "k8s",
	tools: [podsTool, eventsTool, logsTool, configMapTool, deploymentsTool, applyFromRepo],
});

// ---------------------------------------------------------------- repository

const repoList = defineTool({
	name: "repo_list",
	description: "List files in the platform-config repo at a ref (default main), and the agent/* branches.",
	parameters: Type.Object({ ref: Type.Optional(Type.String()) }),
	replay: "safe",
	execute: async ({ ref }) => {
		try {
			const files = await repo.list(ref ?? "main");
			const branches = await repo.branches();
			return text(`files @ ${ref ?? "main"}:\n${files.join("\n")}\n\nbranches:\n${branches.map((b) => `${b.name} ${b.sha} ${b.subject}`).join("\n")}`);
		} catch (e) {
			return fail(e);
		}
	},
});

const repoRead = defineTool({
	name: "repo_read",
	description: "Read a file from the platform-config repo at a ref (default main).",
	parameters: Type.Object({ path: Type.String(), ref: Type.Optional(Type.String()) }),
	replay: "safe",
	execute: async ({ path, ref }) => {
		try {
			return text(await repo.read(path, ref ?? "main"));
		} catch (e) {
			return fail(e);
		}
	},
});

const repoDiff = defineTool({
	name: "repo_diff",
	description: "Unified diff of a branch against main.",
	parameters: Type.Object({ branch: Type.String() }),
	replay: "safe",
	execute: async ({ branch }) => {
		try {
			return text((await repo.diff(branch)) || "(no difference from main)");
		} catch (e) {
			return fail(e);
		}
	},
});

export const RepoReadExtension = defineExtension({ name: "repo", tools: [repoList, repoRead, repoDiff] });

const repoWrite = defineTool({
	name: "repo_write",
	description:
		"Write the full content of one file on an agent/<topic> branch and commit it (the branch is created from main if new). Never changes main. Returns the commit.",
	parameters: Type.Object({
		branch: Type.String({ description: "Branch name, must start with agent/" }),
		path: Type.String(),
		content: Type.String({ description: "Complete new file content" }),
		message: Type.String({ description: "Commit message" }),
	}),
	replay: "safe",
	execute: async (args, api) => {
		try {
			const { agentId } = where(api.conversationId);
			const r = await repo.write({ ...args, author: agentById(agentId)?.name ?? agentId });
			store.audit(`agent:${agentId}`, "repo.commit", { branch: args.branch, path: args.path, sha: r.sha });
			return text(r.committed ? `Committed ${r.sha} on ${args.branch}.` : `No change; ${args.branch} already has this content (${r.sha}).`);
		} catch (e) {
			return fail(e);
		}
	},
});

export const RepoWriteExtension = defineExtension({ name: "repo-write", tools: [repoWrite] });

export const ALL_EXTENSIONS = [CollabExtension, K8sExtension, RepoReadExtension, RepoWriteExtension, InsightExtension, SandboxExtension];
