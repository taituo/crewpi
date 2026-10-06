import { db, store } from "./db.ts";
import { hub } from "./hub.ts";

/** Fake integrations an admin can switch on and off live. Tools check the switch on every call. */
export const INTEGRATIONS = [
	{ id: "jira", name: "Jira", description: "Tickets and comments" },
	{ id: "github", name: "GitHub", description: "Pull requests and Actions CI" },
	{ id: "gitlab", name: "GitLab", description: "Merge requests and pipelines" },
	{ id: "gerrit", name: "Gerrit", description: "Code review changes" },
	{ id: "temporal", name: "Temporal", description: "Workflow executions" },
	{ id: "grafana", name: "Grafana", description: "Dashboards and metric queries" },
	{ id: "envstatus", name: "Environment status", description: "dev / staging / prod services" },
	{ id: "sandbox", name: "Sandbox pods", description: "Isolated pods where agents run commands and tests" },
] as const;

export type IntegrationId = (typeof INTEGRATIONS)[number]["id"];

db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

const initial = (process.env.FAKE_INTEGRATIONS ?? INTEGRATIONS.map((i) => i.id).join(","))
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

export function isEnabled(id: IntegrationId): boolean {
	const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`integration:${id}`) as { value: string } | undefined;
	return row ? row.value === "1" : initial.includes(id);
}

export function listIntegrations() {
	return INTEGRATIONS.map((i) => ({ ...i, enabled: isEnabled(i.id) }));
}

export function setEnabled(id: string, on: boolean, actor: string): boolean {
	if (!INTEGRATIONS.some((i) => i.id === id)) return false;
	db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(`integration:${id}`, on ? "1" : "0");
	store.audit(actor, on ? "integration.enable" : "integration.disable", { id });
	hub.publish({ type: "integrations", integrations: listIntegrations() });
	return true;
}

/** A tool result for a switched-off integration, or undefined when it is on. */
export function offResult(id: IntegrationId) {
	if (isEnabled(id)) return undefined;
	const name = INTEGRATIONS.find((i) => i.id === id)!.name;
	return { isError: true, content: [{ type: "text" as const, text: `${name} is not connected (integration disabled). An admin can enable it in the Integrations panel. Tell the user instead of guessing.` }] };
}
