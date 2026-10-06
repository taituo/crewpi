/**
 * A small, deterministic fake "company": tickets, code hosting, CI, Gerrit, Temporal, Grafana, environments.
 * Everything is demo data. It tells one consistent story: checkout-api crash-loops in prod since ~42 minutes
 * ago because of POOL_SIZE=0, a fix is in review, a release workflow failed on its smoke test, and a self-heal
 * workflow is waiting for a human approval.
 */

const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN).toISOString();

// ------------------------------------------------------------------ Jira

type Issue = { key: string; summary: string; status: string; priority: string; assignee: string; updated: string; description: string; comments: { by: string; at: string; text: string }[] };
export const jiraIssues: Issue[] = [
	{ key: "PAY-412", summary: "checkout-api crash loop after config change", status: "In Progress", priority: "Highest", assignee: "Mika Laine", updated: ago(9),
		description: "Since the 10:xx config sync checkout-api in prod restarts every ~30s (CrashLoopBackOff). Suspect POOL_SIZE=0 in ConfigMap checkout-config. Fix proposed in platform-config PR #77.",
		comments: [{ by: "Sara Niemi", at: ago(30), text: "Customers see 5xx at checkout. Paging SRE." }, { by: "Mika Laine", at: ago(9), text: "Confirmed POOL_SIZE=0. Waiting for reviewed fix + approval." }] },
	{ key: "PAY-407", summary: "Checkout latency p95 above SLO in eu-north-1", status: "Open", priority: "High", assignee: "Unassigned", updated: ago(55),
		description: "p95 latency over the 400 ms SLO since the incident started. Likely a symptom of PAY-412.", comments: [] },
	{ key: "PAY-420", summary: "Add idempotency key to POST /orders", status: "In Progress", priority: "Medium", assignee: "Jussi Aalto", updated: ago(190), description: "Prevent duplicate orders on client retries.", comments: [] },
	{ key: "PAY-398", summary: "Upgrade Node runtime to 22 LTS", status: "In Review", priority: "Medium", assignee: "Aino Virta", updated: ago(300), description: "Tracked in checkout-api PR #221; CI is green.", comments: [] },
	{ key: "PAY-391", summary: "Flaky smoke test in ReleaseWorkflow", status: "To Do", priority: "High", assignee: "Unassigned", updated: ago(1200), description: "smokeTest activity times out when the target is still rolling out. Needs a readiness wait.", comments: [{ by: "Aino Virta", at: ago(1200), text: "Seen 3 times this week." }] },
	{ key: "OPS-95", summary: "Q4 capacity review", status: "To Do", priority: "Low", assignee: "Sara Niemi", updated: ago(4000), description: "Quarterly review of node and DB capacity.", comments: [] },
	{ key: "OPS-88", summary: "Rotate inference gateway bearer tokens", status: "Done", priority: "Medium", assignee: "Mika Laine", updated: ago(7000), description: "Completed.", comments: [] },
];

// ------------------------------------------------------------------ GitHub / GitLab / CI

type Pr = { repo: string; number: number; title: string; author: string; state: "open" | "merged" | "closed"; branch: string; updated: string; checks: { name: string; status: "success" | "failure" | "pending" }[]; body: string };
export const githubPrs: Pr[] = [
	{ repo: "acme/checkout-api", number: 218, title: "Add retry with backoff to payment client", author: "sara-niemi", state: "open", branch: "feat/payment-retry", updated: ago(70),
		checks: [{ name: "lint", status: "success" }, { name: "unit-tests", status: "failure" }, { name: "build", status: "success" }], body: "Retries 3x with jittered backoff on 502/503 from the PSP." },
	{ repo: "acme/checkout-api", number: 221, title: "Bump Node to 22 LTS", author: "aino-virta", state: "open", branch: "chore/node-22", updated: ago(300),
		checks: [{ name: "lint", status: "success" }, { name: "unit-tests", status: "success" }, { name: "build", status: "success" }], body: "Runtime upgrade, no code changes." },
	{ repo: "acme/checkout-api", number: 215, title: "fix: validate POOL_SIZE at startup", author: "mika-laine", state: "merged", branch: "fix/pool-size-validation", updated: ago(2600),
		checks: [{ name: "lint", status: "success" }, { name: "unit-tests", status: "success" }], body: "Fail fast with a clear message when POOL_SIZE <= 0." },
	{ repo: "acme/platform-config", number: 77, title: "checkout-config: POOL_SIZE=10", author: "developer-agent", state: "open", branch: "agent/fix-checkout-pool-size", updated: ago(12),
		checks: [{ name: "schema-validate", status: "success" }, { name: "policy-check", status: "success" }], body: "Fixes PAY-412. Reviewed by reviewer-agent: APPROVE. Needs human approval to apply." },
];

type Run = { id: number; provider: "github" | "gitlab"; project: string; name: string; branch: string; status: "success" | "failure" | "running"; startedMinAgo: number; durationS: number; failedJob?: string };
export const ciRuns: Run[] = [
	{ id: 9004, provider: "github", project: "acme/checkout-api", name: "CI", branch: "feat/payment-retry", status: "failure", startedMinAgo: 71, durationS: 238, failedJob: "unit-tests" },
	{ id: 9003, provider: "github", project: "acme/checkout-api", name: "CI", branch: "chore/node-22", status: "success", startedMinAgo: 301, durationS: 214 },
	{ id: 9002, provider: "github", project: "acme/platform-config", name: "validate", branch: "agent/fix-checkout-pool-size", status: "success", startedMinAgo: 12, durationS: 41 },
	{ id: 9001, provider: "github", project: "acme/checkout-api", name: "CI", branch: "main", status: "success", startedMinAgo: 2610, durationS: 207 },
	{ id: 3301, provider: "gitlab", project: "payments/payments-gateway", name: "pipeline", branch: "main", status: "failure", startedMinAgo: 95, durationS: 512, failedJob: "deploy-staging" },
	{ id: 3300, provider: "gitlab", project: "payments/payments-gateway", name: "pipeline", branch: "main", status: "success", startedMinAgo: 1500, durationS: 498 },
];

export const ciLogs: Record<string, string> = {
	"github:9004:unit-tests": `> checkout-api@1.42.0 test
 FAIL  test/payment-client.test.ts
  ● payment client › retries on 503 › gives up after 3 attempts
    expect(received).toBe(expected)
    Expected: 3
    Received: 4
      at Object.<anonymous> (test/payment-client.test.ts:58:31)
Tests: 1 failed, 86 passed, 87 total
Process completed with exit code 1.`,
	"gitlab:3301:deploy-staging": `$ helm upgrade --install payments-gateway ./chart -n staging --wait --timeout 5m
Error: UPGRADE FAILED: timed out waiting for the condition
  deployment "payments-gateway" exceeded its progress deadline
ERROR: Job failed: exit code 1`,
};

type Mr = { project: string; iid: number; title: string; author: string; state: "opened" | "merged"; updated: string; pipeline: number };
export const gitlabMrs: Mr[] = [
	{ project: "payments/payments-gateway", iid: 57, title: "Increase gateway worker count", author: "jussi.aalto", state: "opened", updated: ago(100), pipeline: 3301 },
	{ project: "payments/payments-gateway", iid: 54, title: "Add /health readiness endpoint", author: "aino.virta", state: "merged", updated: ago(1500), pipeline: 3300 },
];

type Change = { id: number; subject: string; owner: string; status: "NEW" | "MERGED"; project: string; branch: string; updated: string; labels: Record<string, number>; comments: string[] };
export const gerritChanges: Change[] = [
	{ id: 12845, subject: "Increase db pool default to 20", owner: "mika.laine", status: "NEW", project: "infra/db-config", branch: "main", updated: ago(40), labels: { "Code-Review": 0, Verified: 1 }, comments: ["Needs a second reviewer from the DB team."] },
	{ id: 12860, subject: "Revert feature flag new-cart default", owner: "sara.niemi", status: "NEW", project: "infra/flags", branch: "main", updated: ago(120), labels: { "Code-Review": 1, Verified: -1 }, comments: ["Verified -1: flag service integration test failed."] },
	{ id: 12851, subject: "Add health endpoint to checkout-api", owner: "aino.virta", status: "MERGED", project: "acme/checkout-api", branch: "main", updated: ago(3000), labels: { "Code-Review": 2, Verified: 1 }, comments: [] },
];

// ------------------------------------------------------------------ Temporal

type Wf = {
	id: string; type: string; status: "Running" | "Completed" | "Failed"; taskQueue: string; startedMinAgo: number; closedMinAgo?: number;
	pending?: { activity: string; attempt: number; detail: string }; failure?: string;
	history: { minAgo: number; type: string; detail: string }[];
};
export const workflows: Wf[] = [
	{ id: "selfheal-checkout-api-0610", type: "SelfHealWorkflow", status: "Running", taskQueue: "agents", startedMinAgo: 38,
		pending: { activity: "waitForApproval", attempt: 1, detail: "Human approval requested: apply checkout-config from agent/fix-checkout-pool-size" },
		history: [
			{ minAgo: 38, type: "WorkflowExecutionStarted", detail: "trigger: alert HighErrorRate checkout-api" },
			{ minAgo: 38, type: "ActivityCompleted", detail: "askAgent(ops): diagnosis = POOL_SIZE=0 in checkout-config" },
			{ minAgo: 30, type: "ActivityCompleted", detail: "askAgent(developer): branch agent/fix-checkout-pool-size committed" },
			{ minAgo: 22, type: "ActivityCompleted", detail: "askAgent(reviewer): verdict APPROVE" },
			{ minAgo: 21, type: "ActivityScheduled", detail: "waitForApproval (signal: approval)" },
		] },
	{ id: "release-checkout-api-v142", type: "ReleaseWorkflow", status: "Failed", taskQueue: "release", startedMinAgo: 64, closedMinAgo: 58,
		failure: "ActivityFailure smokeTest after 3 attempts: GET /health -> 503 (timeout 30s)",
		history: [
			{ minAgo: 64, type: "WorkflowExecutionStarted", detail: "version v142 -> prod" },
			{ minAgo: 63, type: "ActivityCompleted", detail: "build image checkout-api:v142" },
			{ minAgo: 61, type: "ActivityCompleted", detail: "deploy staging" },
			{ minAgo: 60, type: "ActivityFailed", detail: "smokeTest attempt 1: GET /health 503" },
			{ minAgo: 59, type: "ActivityFailed", detail: "smokeTest attempt 2: GET /health 503" },
			{ minAgo: 58, type: "WorkflowExecutionFailed", detail: "smokeTest attempt 3: GET /health 503 (retries exhausted)" },
		] },
	{ id: "build-repair-payments-gateway-3301", type: "BuildRepairWorkflow", status: "Running", taskQueue: "coding", startedMinAgo: 88,
		pending: { activity: "runCodingTask", attempt: 1, detail: "executor=claude-code repo=payments/payments-gateway task=fix deploy-staging timeout" },
		history: [
			{ minAgo: 88, type: "WorkflowExecutionStarted", detail: "trigger: gitlab pipeline #3301 failed" },
			{ minAgo: 87, type: "ActivityCompleted", detail: "fetchJobLog deploy-staging" },
			{ minAgo: 86, type: "ActivityScheduled", detail: "runCodingTask (sandbox pod coding-7f9c)" },
		] },
	{ id: "nightly-dependency-update", type: "DependencyUpdateWorkflow", status: "Completed", taskQueue: "agents", startedMinAgo: 560, closedMinAgo: 540,
		history: [{ minAgo: 560, type: "WorkflowExecutionStarted", detail: "schedule: nightly" }, { minAgo: 540, type: "WorkflowExecutionCompleted", detail: "opened 2 PRs" }] },
	{ id: "capacity-report-weekly", type: "CapacityWorkflow", status: "Completed", taskQueue: "agents", startedMinAgo: 2900, closedMinAgo: 2895,
		history: [{ minAgo: 2900, type: "WorkflowExecutionStarted", detail: "schedule: weekly" }, { minAgo: 2895, type: "WorkflowExecutionCompleted", detail: "report posted to #insights" }] },
];

// ------------------------------------------------------------------ environments

export const environments = {
	prod: [
		{ service: "checkout-api", version: "v141", ready: "0/1", health: "CrashLoopBackOff", deployedMinAgo: 64, note: "incident PAY-412" },
		{ service: "payments-gateway", version: "v88", ready: "3/3", health: "Healthy", deployedMinAgo: 1500, note: "" },
		{ service: "orders-svc", version: "v57", ready: "2/2", health: "Healthy", deployedMinAgo: 4300, note: "" },
		{ service: "web-frontend", version: "v203", ready: "4/4", health: "Healthy", deployedMinAgo: 800, note: "" },
	],
	staging: [
		{ service: "checkout-api", version: "v142", ready: "1/1", health: "Healthy", deployedMinAgo: 61, note: "smoke test failed in release workflow" },
		{ service: "payments-gateway", version: "v89-rc1", ready: "1/2", health: "Degraded", deployedMinAgo: 95, note: "deploy-staging timed out (pipeline #3301)" },
		{ service: "orders-svc", version: "v58", ready: "1/1", health: "Healthy", deployedMinAgo: 700, note: "" },
	],
	dev: [
		{ service: "checkout-api", version: "v143-dev", ready: "1/1", health: "Healthy", deployedMinAgo: 20, note: "" },
		{ service: "orders-svc", version: "v58-dev", ready: "1/1", health: "Healthy", deployedMinAgo: 90, note: "" },
	],
} as const;

// ------------------------------------------------------------------ Grafana

export const dashboards = [
	{ uid: "checkout-overview", title: "Checkout overview", tags: ["checkout", "slo"], panels: ["checkout_5xx_rate", "checkout_latency_p95_ms", "checkout_requests_per_s"] },
	{ uid: "k8s-workloads", title: "Kubernetes workloads", tags: ["k8s"], panels: ["checkout_pod_restarts", "checkout_cpu_cores"] },
	{ uid: "queues", title: "Queues", tags: ["orders"], panels: ["orders_queue_depth"] },
];

export const METRICS: Record<string, { unit: string; title: string }> = {
	checkout_5xx_rate: { unit: "%", title: "checkout-api 5xx rate" },
	checkout_latency_p95_ms: { unit: "ms", title: "checkout-api latency p95" },
	checkout_requests_per_s: { unit: "req/s", title: "checkout-api requests" },
	checkout_pod_restarts: { unit: "restarts", title: "checkout-api pod restarts (cumulative)" },
	checkout_cpu_cores: { unit: "cores", title: "checkout-api CPU" },
	orders_queue_depth: { unit: "msgs", title: "orders queue depth" },
};

/** Injected anomalies by metric: start time in ms. Set by the demo controls, read by queryMetric. */
export const anomalies: Record<string, number> = {};
const INCIDENT_START_MIN_AGO = 42;
const hash = (s: string) => {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return ((h >>> 0) % 10000) / 10000; // 0..1, stable
};
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Evenly spaced points ending now. Stable for a given wall-clock minute (noise is seeded by metric+minute). */
export function queryMetric(metric: string, minutes: number, points = 24): { t: number; v: number }[] {
	if (!METRICS[metric]) throw new Error(`unknown metric "${metric}". Known: ${Object.keys(METRICS).join(", ")}`);
	const now = Math.floor(Date.now() / MIN);
	const out: { t: number; v: number }[] = [];
	for (let i = 0; i < points; i++) {
		const minAgo = minutes - (minutes * i) / (points - 1);
		const minute = now - Math.round(minAgo);
		const noise = hash(`${metric}:${minute}`) - 0.5;
		const t = Date.now() - Math.round(minAgo) * MIN;
		const inc = smooth((INCIDENT_START_MIN_AGO - minAgo) / 5);
		const ordersInc = anomalies.orders_queue_depth ? smooth((t - anomalies.orders_queue_depth) / MIN / 5) : 0;
		const v =
			metric === "checkout_5xx_rate" ? 0.2 + 14.6 * inc + noise * (0.2 + inc * 2.2)
			: metric === "checkout_latency_p95_ms" ? 180 + 720 * inc + noise * (30 + inc * 160)
			: metric === "checkout_requests_per_s" ? 120 - 45 * inc + noise * 14
			: metric === "checkout_pod_restarts" ? Math.max(0, Math.floor((INCIDENT_START_MIN_AGO - minAgo) / 4))
			: metric === "checkout_cpu_cores" ? 0.55 - 0.3 * inc + noise * 0.06
			: 40 + 170 * ordersInc + noise * 12; // orders_queue_depth backs up only while an injected anomaly is active
		out.push({ t, v: Math.round(Math.max(0, v) * 100) / 100 });
	}
	return out;
}

export const minutesAgo = ago;

// ------------------------------------------------------------------ cases: everything related to one ticket

export type CaseLinks = { prs?: string[]; runs?: string[]; workflows?: string[]; changes?: number[]; dashboards?: string[] };
export const caseLinks: Record<string, CaseLinks> = {
	"PAY-412": { prs: ["acme/platform-config#77"], runs: ["github:9002"], workflows: ["selfheal-checkout-api-0610"], dashboards: ["checkout-overview", "k8s-workloads"] },
	"PAY-407": { changes: [12845], dashboards: ["checkout-overview"] },
	"PAY-420": { prs: ["acme/checkout-api#218"], runs: ["github:9004"] },
	"PAY-398": { prs: ["acme/checkout-api#221"], runs: ["github:9003"] },
	"PAY-391": { workflows: ["release-checkout-api-v142"] },
};

export function caseContext(key: string) {
	const l = caseLinks[key] ?? {};
	return {
		prs: (l.prs ?? []).flatMap((ref) => {
			const p = githubPrs.find((x) => `${x.repo}#${x.number}` === ref);
			return p ? [{ label: ref, title: p.title, state: p.state, checks: p.checks.every((c) => c.status === "success") ? "passing" : "failing" }] : [];
		}),
		runs: (l.runs ?? []).flatMap((ref) => {
			const r = ciRuns.find((x) => `${x.provider}:${x.id}` === ref);
			return r ? [{ label: ref, title: `${r.project} ${r.name} (${r.branch})`, state: r.status }] : [];
		}),
		workflows: (l.workflows ?? []).flatMap((id) => {
			const w = workflows.find((x) => x.id === id);
			return w ? [{ label: id, title: w.type, state: w.status }] : [];
		}),
		changes: (l.changes ?? []).flatMap((id) => {
			const c = gerritChanges.find((x) => x.id === id);
			return c ? [{ label: String(id), title: c.subject, state: c.status }] : [];
		}),
		dashboards: (l.dashboards ?? []).flatMap((uid) => {
			const d = dashboards.find((x) => x.uid === uid);
			return d ? [{ label: uid, title: d.title }] : [];
		}),
	};
}

export function findIssue(key: string) {
	return jiraIssues.find((i) => i.key === key.toUpperCase());
}
