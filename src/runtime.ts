import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { assertBudget } from "./budget.ts";
import { acquireLease, type Lease } from "./lock.ts";
import { createRegistry, Harness, watchEvents, type Conversation } from "@earendil-works/pi-durable";
import { NODE_BYTES, SUMMARY_SYSTEM, addLeaf, builder, fitView, leafCount, leafRawByEntry, stats, type Role } from "./optchat.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AGENTS, agentById, type AgentDef } from "./agents.ts";
import { channelById } from "./channels.ts";
import { config } from "./config.ts";
import { createDemoProvider } from "./demo.ts";
import { db, store } from "./db.ts";
import { setOrigin } from "./work/handoffs.ts";
import { newId } from "./work/events.ts";
import { handoffs } from "./work/index.ts";
import { runEnded, runFailed, runStarted } from "./work/lifecycle.ts";
import { bridge, hub, type Artifact } from "./hub.ts";
import { ALL_EXTENSIONS } from "./tools.ts";

const ctx = BACKGROUND_CONTEXT;

type ModelRef = { provider: string; modelId: string };
export type Presence = { agentId: string; status: "idle" | "working" | "waiting_approval"; model: string; working: string[] };

let harness: Harness;
let lease: Lease | undefined;
const models = createModels();
const resolved = new Map<string, ModelRef>();
const convs = new Map<string, Conversation>(); // `${channel}:${agent}`
const mirrors = new Map<string, Mirror>();
const convIndex = new Map<number, { channelId: string; agentId: string }>();
export const providersAvailable: string[] = [];

// ------------------------------------------------------------------ inference

function setupInference() {
	const inf = config.inference;
	if (inf.openaiKey && !inf.forceDemo) {
		models.setProvider(openaiProvider()); // reads OPENAI_API_KEY
		providersAvailable.push("openai");
	}
	if (inf.openrouterKey && !inf.forceDemo) {
		models.setProvider(openrouterProvider()); // reads OPENROUTER_API_KEY
		providersAvailable.push("openrouter");
	}
	if (inf.localBaseUrl && inf.localModel && !inf.forceDemo) {
		models.setProvider(
			createProvider({
				id: "local",
				name: "Local OpenAI-compatible",
				baseUrl: inf.localBaseUrl,
				auth: { apiKey: { name: "Local LLM", // vLLM/Ollama ignore the key, but the OpenAI client refuses to send a request without one.
				resolve: async () => ({ auth: { apiKey: inf.localApiKey || "not-needed" } }) } },
				models: [
					{
						id: inf.localModel,
						name: inf.localModel,
						api: "openai-completions",
						provider: "local",
						baseUrl: inf.localBaseUrl,
						reasoning: false,
						input: inf.localVision ? ["text", "image"] : ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 16000,
					},
				],
				api: openAICompletionsApi(),
			}) as any,
		);
		providersAvailable.push("local");
	}
	const demo = createDemoProvider();
	models.setProvider(demo.provider);
	providersAvailable.push("demo");

	for (const a of AGENTS) {
		const override = process.env[`AGENT_${a.id.toUpperCase()}_MODEL`]; // "provider/model"
		let ref: ModelRef = a.model;
		if (override?.includes("/")) {
			const [provider, ...rest] = override.split("/");
			ref = { provider, modelId: rest.join("/") };
		}
		if (!providersAvailable.includes(ref.provider)) {
			ref = providersAvailable.includes("local") ? { provider: "local", modelId: inf.localModel } : { provider: "demo", modelId: a.id };
		}
		resolved.set(a.id, ref);
	}
}

// ------------------------------------------------------------------ mirroring conversation -> channel message

type Activity = { id: string; name: string; args: string; status: "running" | "done" | "error"; preview?: string };

const short = (v: unknown, n: number) => {
	const s = typeof v === "string" ? v : JSON.stringify(v);
	return s.length > n ? `${s.slice(0, n)}…` : s;
};
const textOf = (content: any): string =>
	typeof content === "string" ? content : (content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");

/** A transcript entry as memory-tree text, or undefined for entries that are not conversation (system prompt, summaries). */
function leafOf(entry: any): { role: Role; raw: string } | undefined {
	const msg = entry?.model?.[0];
	if (!msg) return undefined;
	const blocks = (c: any): string => (typeof c === "string" ? c : (c ?? []).map((b: any) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).join(" "));
	if (entry.kind === "pi.user") return { role: "user", raw: blocks(msg.content) };
	if (entry.kind === "pi.assistant") {
		const calls = (msg.content ?? []).filter((b: any) => b.type === "toolCall").map((b: any) => `[called ${b.name}(${short(b.arguments, 90)})]`);
		return { role: "assistant", raw: [blocks(msg.content), ...calls].join(" ").trim() };
	}
	if (entry.kind === "pi.tool-result") return { role: "tool", raw: `${msg.toolName ?? "tool"}: ${blocks(msg.content)}` };
	return undefined;
}

class Mirror {
	rowId: number | null = null;
	status: "idle" | "working" = "idle";
	final = "";
	live = new Map<number, string>();
	activity: Activity[] = [];
	artifacts: Artifact[] = [];
	timer: NodeJS.Timeout | undefined;

	readonly channelId: string;
	readonly agent: AgentDef;
	readonly convId: number;

	constructor(channelId: string, agent: AgentDef, convId: number) {
		this.channelId = channelId;
		this.agent = agent;
		this.convId = convId;
		const cur = store.getConv(channelId, agent.id)?.currentMessage;
		const row = cur ? store.getMessage(cur) : undefined;
		if (row && row.meta.status === "working") {
			this.rowId = row.id;
			this.status = "working";
			this.final = String(row.meta.final ?? "");
			this.activity = (row.meta.activity as Activity[]) ?? [];
			this.artifacts = (row.meta.artifacts as Artifact[]) ?? [];
		}
	}

	addArtifact(a: Artifact) {
		this.begin();
		this.artifacts.push(a);
		this.flush(true);
	}

	private display() {
		const live = [...this.live.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]).join("");
		return [this.final, live].filter(Boolean).join(this.final && live ? "\n\n" : "");
	}

	private ensureRow() {
		if (this.rowId) return;
		const m = store.addMessage({
			channelId: this.channelId,
			authorKind: "agent",
			authorId: this.agent.id,
			authorName: this.agent.name,
			text: "",
			meta: { kind: "agent", status: "working", activity: [], final: "" },
		});
		this.rowId = m.id;
		store.setCurrentMessage(this.channelId, this.agent.id, m.id);
		hub.publish({ type: "message", message: m });
	}

	flush(now = false) {
		if (!this.rowId) return;
		if (!now) {
			this.timer ??= setTimeout(() => this.flush(true), 120);
			return;
		}
		clearTimeout(this.timer);
		this.timer = undefined;
		const m = store.updateMessage(this.rowId, {
			text: this.display(),
			meta: { kind: "agent", status: this.status === "working" ? "working" : "done", activity: this.activity, artifacts: this.artifacts, final: this.final },
		});
		if (m) hub.publish({ type: "message", message: m });
	}

	private begin() {
		if (this.status === "working" && this.rowId) return;
		this.final = "";
		this.live.clear();
		this.activity = [];
		this.artifacts = [];
		this.rowId = null;
		this.status = "working";
		this.ensureRow();
		presenceChanged();
		try { runStarted(handoffs, this.channelId, this.agent.id); } catch (e) { console.error("handoff start", e); }
	}

	private end() {
		if (this.status !== "working") return;
		this.status = "idle";
		this.live.clear();
		if (!this.final && !this.activity.length) this.final = "(no answer)";
		this.flush(true);
		const answered = this.rowId ? `message:${this.rowId}` : null;
		store.setCurrentMessage(this.channelId, this.agent.id, null);
		this.rowId = null;
		presenceChanged();
		try { runEnded(handoffs, this.channelId, this.agent.id, answered); } catch (e) { console.error("handoff end", e); }
	}

	/** Every transcript entry becomes a leaf of this conversation's memory tree (idempotent per entry id). */
	feed(entry: any) {
		const leaf = leafOf(entry);
		if (!leaf) return;
		const { idx, created } = addLeaf(this.convId, Number(entry.id), leaf.role, leaf.raw);
		if (created) builder.onLeaf(this.convId, idx);
	}

	handle(ev: any) {
		switch (ev.type) {
			case "snapshot":
				for (const e of ev.entries ?? []) this.feed(e);
				builder.backfill(this.convId);
				if (ev.run) {
					this.begin();
					const m = ev.generation?.message;
					this.live.clear();
					if (m) this.live.set(0, textOf(m.content));
					this.flush();
				} else if (this.status === "working") this.end();
				break;
			case "run_start":
				this.begin();
				break;
			case "message_start":
				this.live.clear();
				break;
			case "message_update":
				for (const c of ev.changes) {
					if (c.type === "text_start") this.live.set(c.contentIndex, c.block.text ?? "");
					else if (c.type === "text_delta") this.live.set(c.contentIndex, (this.live.get(c.contentIndex) ?? "") + c.delta);
					else if (c.type === "block" && c.block.type === "text") this.live.set(c.contentIndex, c.block.text);
					else if (c.type === "message") {
						this.live.clear();
						this.live.set(0, textOf(c.message.content));
					}
				}
				this.flush();
				break;
			case "message_end": {
				this.feed(ev.entry);
				const msg = ev.entry?.model?.[0];
				this.live.clear();
				if (msg?.role === "assistant") {
					const t = textOf(msg.content).trim();
					if (t) this.final = this.final ? `${this.final}\n\n${t}` : t;
					if (msg.stopReason === "error") this.final += `${this.final ? "\n\n" : ""}⚠ Model error: ${msg.errorMessage ?? "unknown"}`;
				}
				this.flush();
				break;
			}
			case "tool_execution_start":
				this.begin();
				this.activity.push({ id: ev.toolCallId, name: ev.toolName, args: short(ev.args, 220), status: "running" });
				this.flush();
				break;
			case "tool_execution_end": {
				const a = this.activity.find((x) => x.id === ev.toolCallId);
				const res = ev.entry?.model?.[0];
				if (a) {
					a.status = !ev.entry || res?.isError ? "error" : "done";
					a.preview = short(textOf(res?.content), 500);
				}
				this.flush();
				break;
			}
			case "task_failed":
				try { runFailed(handoffs, this.channelId, this.agent.id, `${ev.kind}: ${ev.message}`); } catch (e) { console.error("handoff fail", e); }
				this.final += `${this.final ? "\n\n" : ""}⚠ Task failed (${ev.kind}): ${ev.message}`;
				this.flush();
				break;
			case "run_end":
				this.end();
				break;
		}
	}
}

// ------------------------------------------------------------------ conversations

async function ensureConv(channelId: string, agentId: string): Promise<Conversation> {
	const key = `${channelId}:${agentId}`;
	const cached = convs.get(key);
	if (cached) return cached;
	const agent = agentById(agentId);
	if (!agent || !channelById(channelId)?.agents.includes(agentId)) throw new Error(`agent ${agentId} is not in #${channelId}`);

	let conv: Conversation | undefined;
	const known = store.getConv(channelId, agentId);
	if (known) conv = await harness.conversation(Number(known.conversationId) as any, ctx);
	if (!conv) {
		const ref = resolved.get(agentId)!;
		conv = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: ref,
					extensions: ALL_EXTENSIONS.filter((e) => agent.extensions.includes(e.name)),
					instructions: `${agent.instructions}\n\n${channelById(channelId)?.kind === "dm" ? `This is a private one-to-one chat with one person. Answer every message; never mention or relay it to other channels.` : `You are "${agent.name}" in the channel #${channelId}.`}`,
				},
			},
			ctx,
		);
		store.setConv(channelId, agentId, String(conv.id));
	}
	// The model is stored per conversation when it is created; keep it in line with the current configuration.
	const want = resolved.get(agentId)!;
	const have = (await conv.agent(ctx).catch(() => undefined))?.model as any;
	if (have && (have.provider !== want.provider || have.modelId !== want.modelId)) {
		await conv.configure({ model: want }, ctx).catch((e) => console.warn(`model switch failed for ${key}: ${e.message}`));
		console.log(`model of ${key}: ${have.provider}/${have.modelId} -> ${want.provider}/${want.modelId}`);
	}
	const wantExt = ALL_EXTENSIONS.filter((e) => agent.extensions.includes(e.name));
	const haveExt = new Set(((await conv.agent(ctx).catch(() => undefined))?.extensions ?? []).map((e: any) => e.name));
	if (wantExt.length !== haveExt.size || wantExt.some((e) => !haveExt.has(e.name))) {
		await conv.configure({ extensions: wantExt }, ctx).catch((e) => console.warn(`extension sync failed for ${key}: ${e.message}`));
		console.log(`extensions of ${key} -> ${wantExt.map((e) => e.name).join(",")}`);
	}
	convs.set(key, conv);
	convIndex.set(Number(conv.id), { channelId, agentId });

	const mirror = new Mirror(channelId, agent, Number(conv.id));
	mirrors.set(key, mirror);
	const stream = await watchEvents(harness, conv.id, ctx);
	mirror.handle(stream.snapshot);
	stream.start(async (events) => {
		for (const ev of events) {
			try {
				mirror.handle(ev);
			} catch (e) {
				console.error("mirror error", e);
			}
		}
	});
	return conv;
}

export async function submitToAgent(o: {
	channelId: string;
	agentId: string;
	text: string;
	from: { kind: "human" | "agent"; id: string; name: string };
	requestId?: string;
	depth?: number;
	images?: { data: string; mimeType: string; name?: string }[];
}) {
	const agent = agentById(o.agentId)!;
	if (resolved.get(o.agentId)?.provider === "openrouter") await assertBudget();
	// Who started the chain this conversation is now working on is kept in rows (approvals use it for separation of duties).
	if (o.from.kind === "human") setOrigin(db, { channelId: o.channelId, agentId: o.agentId, originSub: o.from.id, correlationId: newId("corr"), depth: 0, handoffId: null });
	else if (o.from.id === "workflow") setOrigin(db, { channelId: o.channelId, agentId: o.agentId, originSub: null, correlationId: o.requestId ?? newId("corr"), depth: 0, handoffId: null });
	if (o.from.kind === "agent" && o.requestId && !store.hasMessageForRequest(o.requestId)) {
		const m = store.addMessage({
			channelId: o.channelId,
			authorKind: "system",
			authorId: o.from.id,
			authorName: o.from.name,
			text: o.text,
			meta: { kind: "delegation", to: agent.id, toName: agent.name, requestId: o.requestId },
		});
		hub.publish({ type: "message", message: m });
	}
	const conv = await ensureConv(o.channelId, o.agentId);
	const sender = o.from.kind === "agent" ? `@${o.from.name.toLowerCase()} (agent)` : o.from.name;
	const where = channelById(o.channelId)?.kind === "dm" ? "private chat" : `#${o.channelId}`;
	const header = `[${where}] ${sender}: ${o.text}`;
	let content: string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = header;
	if (o.images?.length) {
		const ref = resolved.get(o.agentId)!;
		const canSee = !!models.getModel(ref.provider, ref.modelId)?.input?.includes("image");
		content = canSee
			? [{ type: "text", text: header }, ...o.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))]
			: `${header}\n\n[${o.images.length} image attachment(s) (${o.images.map((i) => i.name ?? "image").join(", ")}) were shared, but your model cannot see images. Say so briefly and ask for the key details as text instead of guessing.]`;
	}
	return conv.submit({ type: "input", content, ...(o.requestId ? { requestId: o.requestId } : {}) }, ctx);
}

/**
 * Ask an agent and wait for its final answer: what a workflow activity needs. The same requestId always maps to the
 * same submission, so an activity retried after a crash waits for the original run instead of starting another.
 */
export async function askAgentAndWait(o: { channelId: string; agentId: string; text: string; requestId: string; from: { name: string }; onWait?: () => void }): Promise<{ status: string; text: string }> {
	const sub = (await submitToAgent({ channelId: o.channelId, agentId: o.agentId, text: o.text, requestId: o.requestId, from: { kind: "agent", id: "workflow", name: o.from.name } })) as { wait(c: any): Promise<any> };
	const tick = o.onWait ? setInterval(o.onWait, 10_000) : undefined;
	try {
		const settled = await sub.wait(ctx);
		if (settled.status !== "done") return { status: "unanswered", text: `(no answer: ${settled.reason ?? "unknown"})` };
		const conv = Number(convs.get(`${o.channelId}:${o.agentId}`)?.id);
		for (let i = 0; i < 40; i++) {
			const raw = leafRawByEntry(conv, Number(settled.answer));
			if (raw !== undefined) return { status: "done", text: raw.replace(/\s+/g, " ").trim().slice(0, 3000) };
			await new Promise((r) => setTimeout(r, 150));
		}
		return { status: "done", text: "(answer recorded; text not available yet)" };
	} finally {
		if (tick) clearInterval(tick);
	}
}

// ------------------------------------------------------------------ OptChat memory tree

function setupSummarizer() {
	const override = config.optchat.model.includes("/") ? config.optchat.model : "";
	const ref: ModelRef | undefined = override
		? { provider: override.split("/")[0], modelId: override.split("/").slice(1).join("/") }
		: [...resolved.values()].find((r) => r.provider !== "demo");
	builder.log = (m) => console.warn(`[memtree] ${m}`);
	if (!ref) return; // scripted demo: extractive summaries only
	builder.summarize = async (texts, _level, retry) => {
		if (ref.provider === "openrouter") await assertBudget(); // over budget: the builder falls back to extractive summaries
		const model = models.getModel(ref.provider, ref.modelId);
		if (!model) throw new Error("summarizer model not available");
		// A line that came back too long is asked for again with the cut marker (models cannot count bytes).
		const again = retry ? `\n\nYour previous line was ${Buffer.byteLength(retry.previous)} bytes, over the limit of ${NODE_BYTES}. Write the whole line again for the same chunks, cutting just enough of the least valuable items so that it ends before this cut:\n${retry.cut}| ← LIMIT` : "";
		const msg = await models.complete(model, {
			systemPrompt: SUMMARY_SYSTEM,
			messages: [{ role: "user", content: `Chunk A:\n${texts[0]}\n\nChunk B:\n${texts[1]}${again}`, timestamp: Date.now() }],
		});
		if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage ?? "summarizer error");
		return textOf(msg.content).trim();
	};
}

export async function compactAgent(channelId: string, agentId: string): Promise<{ compacted: boolean }> {
	const conv = await ensureConv(channelId, agentId);
	const id = await conv.compact("Replace the earlier history with the compressed memory view.", ctx);
	const done = (await harness.waitForTask(id, ctx)).state as any;
	return { compacted: done.outcome?.status === "completed" && done.outcome?.result?.submissionId !== undefined };
}

export function memtreeInfo(channelId: string, agentId: string) {
	const known = store.getConv(channelId, agentId);
	if (!known) return { leaves: 0, nodes: 0, llmNodes: 0, pending: builder.pending, view: [] };
	const conv = Number(known.conversationId);
	const n = leafCount(conv);
	const view = fitView(conv, n - 1, config.optchat.viewBytes).map((s) => ({ id: s.idx >= 0 ? `#${s.level}.${s.idx}` : "#~", msgs: s.hi - s.lo + 1, role: s.role ?? null, text: s.text }));
	return { ...stats(conv), pending: builder.pending, viewBytes: config.optchat.viewBytes, view };
}

export async function stopAgent(channelId: string, agentId: string) {
	const conv = convs.get(`${channelId}:${agentId}`);
	if (conv) await conv.abort(ctx);
}

// ------------------------------------------------------------------ presence

export function presence(): Presence[] {
	const waiting = new Set(store.listApprovals("pending").map((a) => a.agentId));
	return AGENTS.map((a) => {
		// Private chats are left out so presence never reveals who is talking to an agent.
		const working = [...mirrors.values()].filter((m) => m.agent.id === a.id && m.status === "working" && channelById(m.channelId)?.kind !== "dm").map((m) => m.channelId);
		const ref = resolved.get(a.id)!;
		return {
			agentId: a.id,
			status: waiting.has(a.id) ? "waiting_approval" : working.length ? "working" : "idle",
			model: `${ref.provider}/${ref.modelId}`,
			working,
		};
	});
}
export const presenceChanged = () => hub.publish({ type: "presence", presence: presence() });

export function inferenceInfo() {
	return {
		providers: providersAvailable,
		demo: [...resolved.values()].some((r) => r.provider === "demo"),
		agents: Object.fromEntries([...resolved.entries()].map(([k, v]) => [k, `${v.provider}/${v.modelId}`])),
	};
}

// ------------------------------------------------------------------ lifecycle

export async function startRuntime() {
	lease = acquireLease(config.dataDir); // fail fast if another process owns the agent storage
	setupInference();
	const registry = createRegistry();
	for (const e of ALL_EXTENSIONS) registry.install(e);
	harness = await Harness.open(
		await openNodeSqliteStorage(join(config.dataDir, "pi.sqlite")),
		{ models, registry, settings: { toolExecution: "parallel", retry: { maxRetries: 2 }, stream: { timeoutMs: 180_000 }, compaction: { enabled: true, keepRecentTokens: config.optchat.keepRecentTokens } } as any },
		ctx,
	);
	setupSummarizer();
	bridge.submitToAgent = submitToAgent;
	bridge.locate = (id) => convIndex.get(Number(id));
	bridge.attachArtifact = (id, a) => {
		const loc = convIndex.get(Number(id));
		if (loc) mirrors.get(`${loc.channelId}:${loc.agentId}`)?.addArtifact(a);
	};
	// Re-attach every known conversation first so mirrors exist before interrupted work resumes.
	for (const c of store.allConvs()) await ensureConv(c.channelId, c.agentId).catch((e) => console.error("attach failed", c, e));
	harness.resume();
	console.log(`runtime up; providers=${providersAvailable.join(",")}`);
}

export async function stopRuntime() {
	await harness?.close(ctx);
	lease?.release();
}
