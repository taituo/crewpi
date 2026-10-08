// Tier 1 brains: rules, no model. They read the world the way a model would, as text from the tools, and act with the tools.
import type { Brain, Session } from "./agents.ts";

const NS = { namespace: "prod" };

/** An on-call operator following a runbook: tickets -> logs -> a fix. Each fix is read back from the world on the next ticket, so one outage behind two tickets is fixed once. */
export const rulesOps: Brain = {
	tier: 1,
	name: "rules-ops",
	async shift(s: Session) {
		const list = await s.call("jira_search", { status: "Open" });
		if (list.isError) return;
		const tickets = [...list.text.matchAll(/^OPS-\d+\s+\[Open\].*?ago\s+([a-z]+): (.*)$/gm)].map((m) => ({ service: m[1], summary: m[2] }));
		for (const t of tickets) {
			const logs = await s.call("k8s_logs", { namespace: NS.namespace, pod: t.service, tail: 40 });
			if (logs.isError) continue;
			const text = logs.text;
			let act: [string, Record<string, unknown>] | undefined;
			let m: RegExpExecArray | null;
			if (/POOL_SIZE=0/.test(text)) {
				// the pool size a healthy service uses is the value to restore
				const ref = await s.call("k8s_configmap", { ...NS, name: "api-config" });
				const pool = Number(/POOL_SIZE=(\d+)/.exec(ref.text)?.[1] ?? 20) || 20;
				act = ["k8s_set_config", { ...NS, name: `${t.service}-config`, key: "POOL_SIZE", value: pool }];
			} else if ((m = /connection refused: ([a-z]+):\d+/.exec(text))) act = ["db_failover", { service: m[1] }];
			else if (/x509|certificate has expired/.test(text)) act = ["cert_rotate", { service: t.service }];
			else if (/panic:|nil pointer|GC pressure|OOMKilled/.test(text)) act = ["k8s_rollback", { ...NS, deployment: t.service }];
			else if (/queue full|shedding load/.test(text)) {
				const d = await s.call("k8s_deployments", NS);
				const have = Number(new RegExp(`^${t.service}\\s+ready=\\d+/(\\d+)`, "m").exec(d.text)?.[1] ?? 2);
				act = ["k8s_scale", { ...NS, deployment: t.service, replicas: Math.min(20, have + 1) }];
			} else if (/single sample/.test(t.summary)) act = ["alert_dismiss", { service: t.service }];
			if (!act) continue;
			await s.call(act[0], act[1]);
		}
	},
};
