import { db, store } from "./db.ts";
import { openCase, createFakeTicket, saveAnomalies } from "./cases.ts";
import * as f from "./fakes.ts";
import { hub } from "./hub.ts";
import { channelById } from "./channels.ts";
import { startIncident, temporalConfigured } from "./temporal-client.ts";

type Rule = { id: string; metric: string; threshold: number; service: string; title: string; dashboards: string[]; lead: string; existingTicket?: string };

/** Anomaly rules over the (fake) Grafana metrics. A breach opens a ticket and a case channel by itself. */
export const RULES: Rule[] = [
	{ id: "orders-backlog", metric: "orders_queue_depth", threshold: 120, service: "orders-svc", title: "Orders queue backlog growing", dashboards: ["queues"], lead: "insight" },
	// Already ticketed by hand (PAY-412): recorded so it does not open a duplicate.
	{ id: "checkout-5xx", metric: "checkout_5xx_rate", threshold: 5, service: "checkout-api", title: "Checkout 5xx rate high", dashboards: ["checkout-overview"], lead: "ops", existingTicket: "PAY-412" },
];

db.exec("CREATE TABLE IF NOT EXISTS alerts (rule_id TEXT PRIMARY KEY, ticket TEXT, channel TEXT, opened_at INTEGER NOT NULL)");
const getAlert = (id: string) => db.prepare("SELECT * FROM alerts WHERE rule_id = ?").get(id) as { ticket: string; channel: string | null } | undefined;

export async function evaluate() {
	for (const r of RULES) {
		const pts = f.queryMetric(r.metric, 10, 6);
		const latest = pts[pts.length - 1].v;
		const alert = getAlert(r.id);
		if (latest > r.threshold && !alert) {
			if (r.existingTicket) {
				db.prepare("INSERT INTO alerts (rule_id, ticket, channel, opened_at) VALUES (?,?,?,?)").run(r.id, r.existingTicket, null, Date.now());
				continue;
			}
			const unit = f.METRICS[r.metric].unit;
			const ticket = createFakeTicket({
				summary: `${r.title} (${r.service})`,
				description: `Automatic alert: ${r.metric} = ${latest} ${unit}, threshold ${r.threshold} ${unit}.`,
				priority: "High", links: { dashboards: r.dashboards },
			});
			db.prepare("INSERT INTO alerts (rule_id, ticket, channel, opened_at) VALUES (?,?,?,?)").run(r.id, ticket.key, null, Date.now());
			const brief0 = `${r.metric} is ${latest} ${unit} (threshold ${r.threshold}) for ${r.service}`;
			const useWorkflow = temporalConfigured();
			const { channel } = await openCase({
				ticket: ticket.key, createdBy: "Watcher", source: "alert", notifyIn: "incidents", lead: useWorkflow ? undefined : r.lead,
				brief: `Anomaly detected by the watcher: ${r.metric} is ${latest} ${unit} (threshold ${r.threshold}) for ${r.service}. ` +
					`Ticket ${ticket.key} was opened and this channel created. Please investigate: chart the metric, check related workflows, CI runs and deployments, ` +
					`and post a short assessment with the likely cause and the next step. Ask @ops if cluster state is needed.`,
			});
			db.prepare("UPDATE alerts SET channel = ? WHERE rule_id = ?").run(channel.id, r.id);
			if (useWorkflow) {
				// Temporal now owns the process: diagnose -> plan -> human decision -> execute -> monitor -> verify -> close.
				await startIncident({ channelId: channel.id, ticket: ticket.key, brief: `Anomaly detected: ${brief0}`, lead: r.lead, monitorSeconds: 45 }).catch((e) => console.warn("[watch] workflow start failed:", e.message));
			}
			console.log(`anomaly ${r.id}: opened ${ticket.key} / #${channel.id}`);
		} else if (alert && latest < r.threshold * 0.5) {
			// Recovered: close the loop and re-arm the rule.
			db.prepare("DELETE FROM alerts WHERE rule_id = ?").run(r.id);
			if (alert.channel && channelById(alert.channel)) {
				hub.publish({
					type: "message",
					message: store.addMessage({ channelId: alert.channel, authorKind: "system", authorId: "system", authorName: "Watcher", text: `${r.metric} is back to normal (${latest}). The rule is re-armed.`, meta: { kind: "notice" } }),
				});
			}
		}
	}
}

export function setAnomaly(metric: string, active: boolean) {
	if (!RULES.some((r) => r.metric === metric) || metric !== "orders_queue_depth") throw new Error("only orders_queue_depth can be injected");
	if (active) f.anomalies[metric] = Date.now() - 12 * 60_000; // started 12 min ago, noticed now
	else delete f.anomalies[metric];
	saveAnomalies();
}

export function startWatcher() {
	const tick = () => evaluate().catch((e) => console.error("watcher", e));
	setTimeout(tick, 3000);
	setInterval(tick, 20_000).unref();
}
