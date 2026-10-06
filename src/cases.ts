import { agentById } from "./agents.ts";
import { createChannel, channelById, type Channel } from "./channels.ts";
import { store, db } from "./db.ts";
import * as f from "./fakes.ts";
import { bridge, hub } from "./hub.ts";
import { isEnabled } from "./integrations.ts";

db.exec("CREATE TABLE IF NOT EXISTS fake_tickets (key TEXT PRIMARY KEY, json TEXT NOT NULL)");

/** Fake Jira tickets created at runtime (by the anomaly watcher) survive restarts. */
export function loadExtraTickets() {
	for (const r of db.prepare("SELECT json FROM fake_tickets").all() as { json: string }[]) {
		const { issue, links } = JSON.parse(r.json);
		if (!f.findIssue(issue.key)) f.jiraIssues.unshift(issue);
		f.caseLinks[issue.key] = links;
	}
	const a = db.prepare("SELECT value FROM settings WHERE key = 'anomalies'").get() as { value: string } | undefined;
	if (a) Object.assign(f.anomalies, JSON.parse(a.value));
}

export function saveAnomalies() {
	db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('anomalies', ?)").run(JSON.stringify(f.anomalies));
}

export function createFakeTicket(o: { summary: string; description: string; priority: string; assignee?: string; links: f.CaseLinks; prefix?: string }) {
	let n = 96;
	while (f.findIssue(`${o.prefix ?? "OPS"}-${n}`)) n++;
	const issue = {
		key: `${o.prefix ?? "OPS"}-${n}`, summary: o.summary, status: "Open", priority: o.priority, assignee: o.assignee ?? "Unassigned",
		updated: new Date().toISOString(), description: o.description, comments: [] as { by: string; at: string; text: string }[],
	};
	f.jiraIssues.unshift(issue);
	f.caseLinks[issue.key] = o.links;
	db.prepare("INSERT OR REPLACE INTO fake_tickets (key, json) VALUES (?, ?)").run(issue.key, JSON.stringify({ issue, links: o.links }));
	return issue;
}

const KEY = /^[A-Za-z]+-\d+$/;
export const isTicketKey = (s: string) => KEY.test(s.trim());

/**
 * Opens (or finds) the channel for a ticket or topic, posts the situation card and optionally briefs a lead agent.
 * Idempotent: the same ticket always maps to the same channel.
 */
export async function openCase(o: {
	ticket?: string; topic?: string; name?: string; agents?: string[]; createdBy: string; source: "manual" | "agent" | "alert";
	brief?: string; lead?: string; notifyIn?: string;
}): Promise<{ channel: Channel; created: boolean }> {
	let issue: ReturnType<typeof f.findIssue>;
	if (o.ticket) {
		if (!isTicketKey(o.ticket)) throw new Error(`"${o.ticket}" is not a ticket key like PAY-412`);
		if (!isEnabled("jira")) throw new Error("Jira is not connected, so tickets cannot be looked up. Create a topic channel instead, or ask an admin to enable Jira.");
		issue = f.findIssue(o.ticket);
		if (!issue) throw new Error(`no ticket ${o.ticket}`);
	}
	const topic = issue ? issue.summary : (o.topic ?? "").trim();
	if (!topic) throw new Error("give a ticket key or a topic");
	const { channel, created } = createChannel({
		name: o.name ?? topic, topic, kind: "issue", ticket: issue?.key ?? null, agents: o.agents, createdBy: o.createdBy,
	});
	if (!created) return { channel, created };

	const msg = store.addMessage({
		channelId: channel.id, authorKind: "system", authorId: "system", authorName: "System",
		text: issue ? `${issue.key}: ${issue.summary}` : topic,
		meta: {
			kind: "case", source: o.source,
			ticket: issue ? { key: issue.key, status: issue.status, priority: issue.priority, assignee: issue.assignee, description: issue.description } : null,
			related: issue ? f.caseContext(issue.key) : null,
		},
	});
	hub.publish({ type: "message", message: msg });

	if (o.notifyIn && o.notifyIn !== channel.id && channelById(o.notifyIn)) {
		hub.publish({
			type: "message",
			message: store.addMessage({
				channelId: o.notifyIn, authorKind: "system", authorId: "system", authorName: "System",
				text: `${o.createdBy} opened #${channel.id}${issue ? ` for ${issue.key}` : ""}: ${channel.topic}`,
				meta: { kind: "notice", link: channel.id },
			}),
		});
	}
	store.audit(o.createdBy, "case.open", { channel: channel.id, ticket: issue?.key ?? null, source: o.source });

	const lead = o.lead && agentById(o.lead) && channel.agents.includes(o.lead) ? o.lead : undefined;
	if (lead && o.brief && bridge.submitToAgent) {
		await bridge.submitToAgent({
			channelId: channel.id, agentId: lead, text: o.brief,
			from: { kind: "agent", id: "watcher", name: o.source === "alert" ? "Watcher" : o.createdBy },
			requestId: `case:${channel.id}:brief`,
		}).catch((e) => console.error("brief failed", e));
	}
	return { channel, created };
}
