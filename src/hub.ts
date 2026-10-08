import type { ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { store } from "./db.ts";
import { changesSince, recordChange } from "./feed.ts";

/** Fan-out of workspace events to every connected browser over server-sent events. */
const clients = new Map<ServerResponse, string>(); // response -> user sub

/** Set by the channels module: may this user see this channel? (private chats are owner-only) */
let canSee: (sub: string, channelId: string) => boolean = () => true;
let channelsFor: (sub: string) => unknown[] = () => [];

/** What one user may receive of an event, or null. Everything channel-scoped is filtered here, server-side. */
function forUser(event: { type: string; [k: string]: unknown }, sub: string): { type: string; [k: string]: unknown } | null {
	if (event.type === "message") return canSee(sub, (event.message as any).channelId) ? event : null;
	if (event.type === "approval") return canSee(sub, (event.approval as any).channelId) ? event : null;
	if (event.type === "channels") return { type: "channels", channels: channelsFor(sub) }; // each user gets their own full list
	return event;
}

export const hub = {
	setVisibility(fn: typeof canSee, lister: (sub: string) => unknown[]) {
		canSee = fn;
		channelsFor = lister;
	},
	/** Registers a client. With `lastEventId` it first replays what changed since then (or says "reset"). */
	add(res: ServerResponse, sub: string, lastEventId?: number) {
		if (lastEventId !== undefined && Number.isFinite(lastEventId)) {
			const changes = changesSince(lastEventId);
			if (changes === "reset") res.write(`event: reset\ndata: {}\n\n`);
			else {
				for (const c of changes) {
					const ev = c.kind === "message" ? { type: "message", message: store.getMessage(c.refId) } : { type: "approval", approval: store.getApproval(c.refId) };
					const body = c.kind === "message" ? (ev as any).message : (ev as any).approval;
					const e = body && forUser(ev, sub);
					if (e) res.write(`id: ${c.sequence}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
				}
			}
		}
		clients.set(res, sub);
		res.on("close", () => clients.delete(res));
	},
	publish(event: { type: string; [k: string]: unknown }) {
		// Message and approval changes are numbered so a reconnecting browser can resume (Last-Event-ID).
		const ref = event.type === "message" ? (event.message as any) : event.type === "approval" ? (event.approval as any) : undefined;
		const id = ref ? recordChange(event.type as "message" | "approval", ref.id, ref.channelId) : undefined;
		for (const [c, sub] of clients) {
			const e = forUser(event, sub);
			if (e) c.write(`${id ? `id: ${id}\n` : ""}event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
		}
	},
	get size() {
		return clients.size;
	},
};

setInterval(() => {
	for (const c of clients.keys()) c.write(": ping\n\n");
}, 20_000).unref();

/** Wakes tools that wait for a human decision. */
export const approvalBus = new EventEmitter();
approvalBus.setMaxListeners(200);

export type Artifact =
	| { kind: "chart"; title: string; type: "line" | "area" | "bar"; unit?: string; series: { name: string; points: { x: string | number; y: number }[] }[] }
	| { kind: "table"; title: string; columns: string[]; rows: (string | number)[][] }
	| { kind: "ui"; spec: { root: string; elements: Record<string, { type: string; props: Record<string, unknown>; children: string[] }> } };

/** Late-bound hooks set by the runtime, so tools can reach it without an import cycle. */
export const bridge: {
	submitToAgent?: (o: {
		channelId: string;
		agentId: string;
		text: string;
		from: { kind: "human" | "agent"; id: string; name: string };
		requestId?: string;
		/** Hops since the human message / alert that started this chain (0 = started by a human or the watcher). */
		depth?: number;
	}) => Promise<unknown>;
	depthOf?: (channelId: string, agentId: string) => number;
	/** Attach a chart/table to the agent message currently being written by this conversation. */
	attachArtifact?: (conversationId: unknown, artifact: Artifact) => void;
	locate?: (conversationId: unknown) => { channelId: string; agentId: string } | undefined;
} = {};
