import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { bridge, type Artifact } from "./hub.ts";
import { isEnabled, offResult, type IntegrationId } from "./integrations.ts";
import * as f from "./fakes.ts";
import { describeLive, getClient, historyLive, listLive } from "./temporal-client.ts";

const clip = (s: string, n = 6000) => (s.length > n ? `${s.slice(0, n)}\n... [truncated]` : s);
const ok = (t: string) => ({ content: [{ type: "text" as const, text: clip(t) }] });
const bad = (t: string) => ({ isError: true, content: [{ type: "text" as const, text: t }] });
const ageOf = (iso: string) => {
	const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
	return m < 90 ? `${Math.round(m)}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const mins = (m: number) => (m < 90 ? `${Math.round(m)}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`);

/** Build a tool that is gated by an integration switch and never throws. */
function tool<P extends Parameters<typeof Type.Object>[0]>(integration: IntegrationId | null, name: string, description: string, props: P, run: (args: any, api: any) => string | Promise<string>) {
	return defineTool({
		name,
		description,
		parameters: Type.Object(props),
		replay: "safe",
		execute: async (args: any, api: any) => {
			const off = integration ? offResult(integration) : undefined;
			if (off) return off;
			try {
				return ok(await run(args, api));
			} catch (e) {
				return bad(`Error: ${(e as Error).message}`);
			}
		},
	} as any);
}

const S = (d?: string) => Type.Optional(Type.String(d ? { description: d } : {}));
const attach = (api: any, a: Artifact) => bridge.attachArtifact?.(api.conversationId, a);

// ---------------------------------------------------------------- Jira
const jiraSearch = tool("jira", "jira_search", "Search Jira issues by text, status or assignee.", { text: S("Substring of key or summary"), status: S("e.g. Open, In Progress, Done"), assignee: S() }, ({ text, status, assignee }) => {
	const r = f.jiraIssues.filter((i) => (!text || `${i.key} ${i.summary}`.toLowerCase().includes(text.toLowerCase())) && (!status || i.status.toLowerCase() === status.toLowerCase()) && (!assignee || i.assignee.toLowerCase().includes(assignee.toLowerCase())));
	return r.map((i) => `${i.key}  [${i.status}]  ${i.priority}  ${i.assignee}  ${ageOf(i.updated)}  ${i.summary}`).join("\n") || "no issues";
});
const jiraGet = tool("jira", "jira_get", "Get one Jira issue with description and comments.", { key: Type.String() }, ({ key }) => {
	const i = f.jiraIssues.find((x) => x.key === key.toUpperCase());
	if (!i) throw new Error(`no issue ${key}`);
	return `${i.key} ${i.summary}\nstatus=${i.status} priority=${i.priority} assignee=${i.assignee}\n\n${i.description}\n\ncomments:\n${i.comments.map((c) => `- ${c.by} (${ageOf(c.at)}): ${c.text}`).join("\n") || "(none)"}`;
});
const jiraComment = tool("jira", "jira_comment", "Add a comment to a Jira issue (demo fake: kept in memory).", { key: Type.String(), text: Type.String() }, ({ key, text }) => {
	const i = f.jiraIssues.find((x) => x.key === key.toUpperCase());
	if (!i) throw new Error(`no issue ${key}`);
	i.comments.push({ by: "Insight (agent)", at: new Date().toISOString(), text });
	return `Comment added to ${i.key}.`;
});

// ---------------------------------------------------------------- GitHub / GitLab / Gerrit
const ghPrs = tool("github", "github_prs", "List GitHub pull requests with check status. Optionally filter by repo or state (open/merged/closed).", { repo: S("e.g. acme/checkout-api"), state: S() }, ({ repo, state }) =>
	f.githubPrs.filter((p) => (!repo || p.repo === repo) && (!state || p.state === state)).map((p) => `${p.repo}#${p.number}  [${p.state}]  ${p.title}  by ${p.author}  checks: ${p.checks.map((c) => `${c.name}=${c.status}`).join(", ")}  ${ageOf(p.updated)}`).join("\n") || "no pull requests");
const ghPr = tool("github", "github_pr", "Get one GitHub pull request.", { repo: Type.String(), number: Type.Number() }, ({ repo, number }) => {
	const p = f.githubPrs.find((x) => x.repo === repo && x.number === number);
	if (!p) throw new Error("no such PR");
	return `${p.repo}#${p.number} ${p.title}\nstate=${p.state} author=${p.author} branch=${p.branch}\nchecks: ${p.checks.map((c) => `${c.name}=${c.status}`).join(", ")}\n\n${p.body}`;
});
const needCi = () => { if (!isEnabled("github") && !isEnabled("gitlab")) throw new Error("No CI integration is connected (GitHub and GitLab are both disabled). An admin can enable one in the Integrations panel."); };
const ciRuns = tool(null, "ci_runs", "List recent CI runs (GitHub Actions and GitLab pipelines). Filter by provider (github|gitlab) or status.", { provider: S(), status: S("success | failure | running") }, ({ provider, status }) => { needCi(); return f.ciRuns.filter((r) => isEnabled(r.provider) && (!provider || r.provider === provider) && (!status || r.status === status)).map((r) => `${r.provider}:${r.id}  ${r.project}  ${r.name}  ${r.branch}  ${r.status}${r.failedJob ? ` (job ${r.failedJob})` : ""}  ${Math.round(r.durationS / 6) / 10}min  ${mins(r.startedMinAgo)}`).join("\n"); });
const ciLog = tool(null, "ci_log", "Read the log of a failed CI job. id is like github:9004 and job like unit-tests.", { id: Type.String(), job: Type.String() }, ({ id, job }) => { needCi(); return f.ciLogs[`${id}:${job}`] ?? (() => { throw new Error("no log for that run/job"); })(); });
const glMrs = tool("gitlab", "gitlab_mrs", "List GitLab merge requests with their pipeline id.", { project: S(), state: S("opened | merged") }, ({ project, state }) =>
	f.gitlabMrs.filter((m) => (!project || m.project === project) && (!state || m.state === state)).map((m) => `${m.project}!${m.iid}  [${m.state}]  ${m.title}  by ${m.author}  pipeline #${m.pipeline}  ${ageOf(m.updated)}`).join("\n") || "none");
const gerritChanges = tool("gerrit", "gerrit_changes", "List Gerrit changes with label votes. Filter by status NEW or MERGED.", { status: S() }, ({ status }) =>
	f.gerritChanges.filter((c) => !status || c.status === status.toUpperCase()).map((c) => `${c.id}  [${c.status}]  ${c.project}  ${c.subject}  by ${c.owner}  votes: ${Object.entries(c.labels).map(([k, v]) => `${k}${v >= 0 ? "+" : ""}${v}`).join(" ")}`).join("\n") || "none");
const gerritChange = tool("gerrit", "gerrit_change", "Get one Gerrit change with review comments.", { id: Type.Number() }, ({ id }) => {
	const c = f.gerritChanges.find((x) => x.id === id);
	if (!c) throw new Error("no such change");
	return `${c.id} ${c.subject}\nproject=${c.project} branch=${c.branch} status=${c.status}\nvotes: ${JSON.stringify(c.labels)}\ncomments:\n${c.comments.map((x) => `- ${x}`).join("\n") || "(none)"}`;
});

// ---------------------------------------------------------------- Temporal
const ago2 = (ms: number) => mins((Date.now() - ms) / 60000);
const wfList = tool("temporal", "temporal_workflows", "List Temporal workflow executions: live ones from the real Temporal server first ([live]), then demo fixtures ([demo]). Filter by status (Running|Completed|Failed) or type.", { status: S(), type: S() }, async ({ status, type }) => {
	const live = (await getClient()) ? await listLive(20).catch(() => []) : [];
	const liveRows = live.filter((w) => (!status || w.status.toLowerCase().startsWith(status.toLowerCase())) && (!type || w.type.toLowerCase().includes(type.toLowerCase())))
		.map((w) => `[live] ${w.id}  ${w.type}  ${w.status}${w.step ? `  step=${w.step}` : ""}  started ${ago2(w.startedAt)}${w.closedAt ? `  closed ${ago2(w.closedAt)}` : ""}`);
	const demoRows = f.workflows.filter((w) => (!status || w.status.toLowerCase() === status.toLowerCase()) && (!type || w.type.toLowerCase().includes(type.toLowerCase()))).map((w) => `[demo] ${w.id}  ${w.type}  ${w.status}  queue=${w.taskQueue}  started ${mins(w.startedMinAgo)}${w.closedMinAgo ? `  closed ${mins(w.closedMinAgo)}` : ""}${w.pending ? `  pending: ${w.pending.activity}` : ""}${w.failure ? `  FAILURE: ${w.failure}` : ""}`);
	return [...liveRows, ...demoRows].join("\n") || "none";
});
const wfDescribe = tool("temporal", "temporal_describe", "Describe one workflow execution (live or demo): status, current step, pending activity and failure.", { id: Type.String() }, async ({ id }) => {
	const live = (await getClient()) ? await describeLive(id).catch(() => undefined) : undefined;
	if (live) return `[live] ${live.id} (${live.type})\nstatus=${live.status} queue=${live.taskQueue} started ${ago2(live.startedAt)}${live.closedAt ? `, closed ${ago2(live.closedAt)}` : ""}\n${live.pending.length ? `pending activities: ${live.pending.join(", ")}\n` : ""}${live.status_query ? `workflow state: ${JSON.stringify(live.status_query).slice(0, 1500)}` : ""}`;
	const w = f.workflows.find((x) => x.id === id);
	if (!w) throw new Error("no such workflow");
	return `[demo] ${w.id} (${w.type})\nstatus=${w.status} queue=${w.taskQueue} started ${mins(w.startedMinAgo)}\n${w.pending ? `pending activity: ${w.pending.activity} attempt ${w.pending.attempt}: ${w.pending.detail}\n` : ""}${w.failure ? `failure: ${w.failure}\n` : ""}`;
});
const wfHistory = tool("temporal", "temporal_history", "Event history of a workflow execution (live or demo), oldest first.", { id: Type.String() }, async ({ id }) => {
	if ((await getClient()) && (await describeLive(id).catch(() => undefined))) return (await historyLive(id)).join("\n");
	const w = f.workflows.find((x) => x.id === id);
	if (!w) throw new Error("no such workflow");
	return w.history.map((e, i) => `${i + 1}  ${mins(e.minAgo)}  ${e.type}  ${e.detail}`).join("\n");
});

// ---------------------------------------------------------------- environments
const envStatus = tool("envstatus", "env_status", "Status of services in dev, staging and prod (version, readiness, health, last deploy).", { env: S("dev | staging | prod; omit for all") }, ({ env }) => {
	const names = env ? [env] : ["prod", "staging", "dev"];
	return names.map((n) => {
		const e = (f.environments as any)[n];
		if (!e) throw new Error(`unknown environment ${n}`);
		return `${n}:\n${e.map((s: any) => `  ${s.service}  ${s.version}  ${s.ready}  ${s.health}  deployed ${mins(s.deployedMinAgo)}${s.note ? `  - ${s.note}` : ""}`).join("\n")}`;
	}).join("\n");
});

// ---------------------------------------------------------------- Grafana
const grafanaDashboards = tool("grafana", "grafana_dashboards", "List Grafana dashboards and the metrics (panels) on them.", {}, () =>
	f.dashboards.map((d) => `${d.uid}  "${d.title}"  tags=${d.tags.join(",")}\n  metrics: ${d.panels.join(", ")}`).join("\n"));
const grafanaQuery = tool("grafana", "grafana_query", "Query a Grafana metric over the last N minutes. The result is also drawn as a chart in the channel automatically (set show=false to suppress). Metrics: " + Object.keys(f.METRICS).join(", "), {
	metric: Type.String(), minutes: Type.Optional(Type.Number({ description: "Window, default 60, max 720" })), show: Type.Optional(Type.Boolean()),
}, ({ metric, minutes, show }, api) => {
	const win = Math.min(Math.max(Math.floor(minutes ?? 60), 5), 720);
	const pts = f.queryMetric(metric, win);
	const m = f.METRICS[metric];
	if (show !== false) attach(api, { kind: "chart", title: `${m.title} — last ${win} min`, type: metric === "checkout_pod_restarts" ? "bar" : "area", unit: m.unit, series: [{ name: metric, points: pts.map((p) => ({ x: p.t, y: p.v })) }] });
	const vals = pts.map((p) => p.v);
	return `${metric} (${m.unit}) last ${win} min: min=${Math.min(...vals)} max=${Math.max(...vals)} latest=${vals[vals.length - 1]}  first=${vals[0]}\npoints: ${pts.map((p) => `${new Date(p.t).toISOString().slice(11, 16)}=${p.v}`).join(" ")}${show === false ? "" : "\n(chart shown to the user)"}`;
});

// ---------------------------------------------------------------- charts and tables from any data
const renderChart = tool(null, "render_chart", "Draw a chart in the channel from data you already have. type: line | area | bar. x is a timestamp (ms) or a category label.", {
	title: Type.String(), type: Type.Union([Type.Literal("line"), Type.Literal("area"), Type.Literal("bar")]), unit: S(),
	series: Type.Array(Type.Object({ name: Type.String(), points: Type.Array(Type.Object({ x: Type.Union([Type.String(), Type.Number()]), y: Type.Number() }), { maxItems: 400 }) }), { maxItems: 6 }),
}, (a, api) => {
	attach(api, { kind: "chart", title: a.title, type: a.type, unit: a.unit, series: a.series });
	return "Chart shown to the user.";
});
const renderTable = tool(null, "render_table", "Show a table in the channel. Use for lists of more than a few rows.", {
	title: Type.String(), columns: Type.Array(Type.String(), { maxItems: 10 }), rows: Type.Array(Type.Array(Type.Union([Type.String(), Type.Number()])), { maxItems: 100 }),
}, (a, api) => {
	attach(api, { kind: "table", title: a.title, columns: a.columns, rows: a.rows });
	return "Table shown to the user.";
});

export const InsightExtension = defineExtension({
	name: "insight",
	tools: [jiraSearch, jiraGet, jiraComment, ghPrs, ghPr, ciRuns, ciLog, glMrs, gerritChanges, gerritChange, wfList, wfDescribe, wfHistory, envStatus, grafanaDashboards, grafanaQuery, renderChart, renderTable] as any,
});
