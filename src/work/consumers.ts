import { agentById } from "../agents.ts";
import { channelById } from "../channels.ts";
import { db, store } from "../db.ts";
import { bridge, hub } from "../hub.ts";
import { informTargets } from "../org/routing.ts";
import { signalHandoff, startHandoffWatch, temporalConfigured } from "../temporal-client.ts";
import { bus, handoffs } from "./index.ts";
import { setOrigin } from "./handoffs.ts";

/**
 * Consumers of the event outbox. Each is idempotent (the inbox guarantees one execution per event, and every action
 * below is also safe to repeat): delivery is at-least-once.
 */

const notice = (channelId: string, text: string) => {
	const ch = channelById(channelId);
	if (!ch || ch.kind === "dm") return; // private chats never receive work chatter
	hub.publish({ type: "message", message: store.addMessage({ channelId, authorKind: "system", authorId: "handoffs", authorName: "Handoffs", text, meta: { kind: "notice" } }) });
};

export function registerWorkConsumers() {
	// Hands a requested handoff to the recipient. The durable submit is the acknowledgement.
	bus.register({
		name: "dispatch",
		types: (t) => t === "handoff.requested",
		handle: async (e) => {
			const h = handoffs.get(String(e.payload.handoffId));
			if (!h || (h.status !== "requested" && h.status !== "accepted")) return; // cancelled or already settled meanwhile
			if (!bridge.submitToAgent) throw new Error("agent runtime is not up yet");
			setOrigin(db, { channelId: h.channelId, agentId: h.to, originSub: h.originSub, correlationId: h.correlationId, depth: h.depth, handoffId: h.handoffId });
			const from = agentById(h.from);
			await bridge.submitToAgent({ channelId: h.channelId, agentId: h.to, text: h.text, from: { kind: "agent", id: h.from, name: from?.name ?? h.from }, requestId: h.requestId, depth: h.depth });
			handoffs.accept(h.handoffId, "runtime");
		},
	});

	// The clock. Without Temporal there is no timeout at all (and the API says so) rather than a second, hidden timer.
	bus.register({
		name: "watchdog",
		types: (t) => t.startsWith("handoff."),
		handle: async (e) => {
			if (!temporalConfigured()) return;
			const id = String(e.payload.handoffId);
			if (e.type === "handoff.requested") {
				const h = handoffs.get(id);
				if (h) await startHandoffWatch({ handoffId: id, ackWithinMs: h.ackByAt ? Math.max(1, h.ackByAt - h.createdAt) : undefined, dueAtMs: h.dueAt ?? undefined });
			} else {
				await signalHandoff(id, e.type.slice("handoff.".length));
			}
		},
	});

	// Tells people. Posts into the channel and into the rooms the organization says must be informed.
	bus.register({
		name: "notify",
		types: (t) => ["handoff.rejected", "handoff.failed", "handoff.escalated"].includes(t),
		handle: (e) => {
			const h = handoffs.get(String(e.payload.handoffId));
			if (!h) return;
			const reason = h.reason ? ` (${h.reason})` : "";
			let text: string;
			if (e.type === "handoff.escalated") {
				const next = handoffs.byRequest(`${h.requestId}:esc`);
				text = next ? `@${h.to} did not handle "${h.text.slice(0, 80)}"${reason}. Asked @${next.to} instead.` : `@${h.to} did not handle "${h.text.slice(0, 80)}"${reason}. No backup could take it: a person needs to look.`;
			} else if (e.type === "handoff.rejected") text = `@${h.to} declined "${h.text.slice(0, 80)}"${reason}.`;
			else text = `@${h.to} failed on "${h.text.slice(0, 80)}"${reason}.`;
			notice(h.channelId, text);
			if (e.type === "handoff.escalated") for (const room of informTargets(db, h.to)) if (room !== h.channelId) notice(room, `Escalated in #${h.channelId}: ${text}`);
		},
	});

	// Delivers the outcome of a handoff to whoever asked. Without this an agent that delegates never learns the answer:
	// the recipient replies in the channel, the handoff is marked completed, and the requester is not even woken.
	bus.register({
		name: "return",
		types: (t) => ["handoff.completed", "handoff.rejected", "handoff.failed"].includes(t),
		handle: async (e) => {
			const h = handoffs.get(String(e.payload.handoffId));
			if (!h || channelById(h.channelId)?.kind === "dm") return; // a private chat never has handoffs, and nothing is delivered there
			const requester = agentById(h.from);
			if (!requester || h.from === h.to) return; // a workflow, a person or the system asked: they have their own way to see the result
			if (!bridge.submitToAgent) throw new Error("agent runtime is not up yet");
			const ref = /^message:(\d+)$/.exec(h.resultRef ?? "");
			const answer = (ref ? store.getMessage(Number(ref[1]))?.text : undefined)?.trim();
			const ask = `"${h.text.replace(/\s+/g, " ").slice(0, 160)}"`;
			const text = e.type === "handoff.completed"
				? `[handoff result] @${h.to} has answered your request ${ask}.${answer ? `\n\nTheir answer:\n${answer.slice(0, 3000)}` : "\n\nThey finished without a recorded answer; look in the channel."}`
				: e.type === "handoff.rejected"
					? `[handoff result] @${h.to} declined your request ${ask}${h.reason ? `: ${h.reason}` : ""}. Decide whether to ask someone else or tell the humans.`
					: `[handoff result] @${h.to} failed on your request ${ask}${h.reason ? `: ${h.reason}` : ""}. Decide whether to retry, ask someone else or tell the humans.`;
			await bridge.submitToAgent({ channelId: h.channelId, agentId: h.from, text, from: { kind: "agent", id: h.to, name: agentById(h.to)?.name ?? h.to }, requestId: `result:${h.handoffId}`, depth: Math.max(0, h.depth - 1), card: false });
		},
	});

	bus.log = (m) => console.warn(`[events] ${m}`);
}
