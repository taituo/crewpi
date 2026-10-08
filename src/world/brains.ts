// Tier 1 brains: rules, no model. They read the world the way a model would, as text from the tools, and act with the tools.
import type { Brain, Session } from "./agents.ts";

const NS = { namespace: "prod" };
type Act = [tool: string, args: Record<string, unknown>];

/** The runbook: from a service's logs (and sometimes its ticket text) to a fix, or nothing when the evidence does not say. */
async function diagnose(s: Session, service: string, summary = ""): Promise<{ act?: Act; readable: boolean }> {
	const logs = await s.call("k8s_logs", { ...NS, pod: service, tail: 40 });
	if (logs.isError) return { readable: false };
	const text = logs.text;
	let m: RegExpExecArray | null;
	if (/POOL_SIZE=0/.test(text)) {
		// the pool size a healthy service uses is the value to restore
		const ref = await s.call("k8s_configmap", { ...NS, name: "api-config" });
		const pool = Number(/POOL_SIZE=(\d+)/.exec(ref.text)?.[1] ?? 20) || 20;
		return { readable: true, act: ["k8s_set_config", { ...NS, name: `${service}-config`, key: "POOL_SIZE", value: pool }] };
	}
	if ((m = /connection refused: ([a-z]+):\d+/.exec(text))) return { readable: true, act: ["db_failover", { service: m[1] }] };
	if (/x509|certificate has expired/.test(text)) return { readable: true, act: ["cert_rotate", { service }] };
	if (/panic:|nil pointer|GC pressure|OOMKilled/.test(text)) return { readable: true, act: ["k8s_rollback", { ...NS, deployment: service }] };
	if (/queue full|shedding load/.test(text)) {
		const d = await s.call("k8s_deployments", NS);
		const have = Number(new RegExp(`^${service}\\s+ready=\\d+/(\\d+)`, "m").exec(d.text)?.[1] ?? 2);
		return { readable: true, act: ["k8s_scale", { ...NS, deployment: service, replicas: Math.min(20, have + 1) }] };
	}
	if (/single sample/.test(summary)) return { readable: true, act: ["alert_dismiss", { service }] };
	return { readable: true };
}

const hours = (age: string) => { const m = /^(\d+)([smhd])$/.exec(age); return m ? Number(m[1]) * { s: 1 / 3600, m: 1 / 60, h: 1, d: 24 }[m[2] as "s"] : 0; };

/**
 * An on-call operator following a runbook: tickets -> logs -> a fix. Each fix is read back from the world on the next ticket,
 * so one outage behind two tickets is fixed once. A ticket the runbook cannot explain for two hours goes to a developer
 * (chosen by ticket number, so work is spread), unless somebody already asked about that ticket.
 */
export function opsBrain(o: { devs: string[] }): Brain {
	return {
		tier: 1,
		name: "rules-ops",
		async shift(s: Session) {
			const list = await s.call("jira_search", { status: "Open" });
			if (list.isError) return;
			const tickets = [...list.text.matchAll(/^(OPS-\d+)\s+\[Open\].*?Unassigned\s+(\S+) ago\s+([a-z]+): (.*)$/gm)].map((m) => ({ key: m[1], age: hours(m[2]), service: m[3], summary: m[4] }));
			for (const t of tickets) {
				const d = await diagnose(s, t.service, t.summary);
				if (d.act) { await s.call(d.act[0], d.act[1]); continue; }
				// at most three questions per ticket, none while one is open, at least eight hours apart: after that it is the developers' ticket
				if (t.age >= 2 && o.devs.length) {
					const asked = s.requests().filter((r) => r.task.includes(t.key + " "));
					const last = asked.reduce((m, r) => Math.max(m, r.at), -Infinity);
					if (asked.length < 3 && !asked.some((r) => r.open) && s.now() - last >= 8 * 3_600_000) {
						const dev = o.devs[Number(t.key.slice(4)) % o.devs.length];
						await s.call("ask_agent", { agent: dev, request: `Ticket ${t.key} on service ${t.service}: ${t.summary}. I could not find the cause from the logs. Please look at service ${t.service} and fix it if you can.` });
					}
				}
			}
		},
	};
}
export const rulesOps: Brain = opsBrain({ devs: ["dev-1"] });

/** A developer who answers requests: looks at the service itself, fixes what the evidence supports, and says what it did. */
export const rulesDev: Brain = {
	tier: 1,
	name: "rules-dev",
	async shift(s: Session) {
		for (const h of s.inbox()) {
			const service = /service ([a-z]+)/.exec(h.task)?.[1];
			if (!service) { s.reply(h.id, "I could not tell which service you mean."); continue; }
			const d = await diagnose(s, service, h.task);
			if (d.act) { await s.call(d.act[0], d.act[1]); s.reply(h.id, `I found the cause and applied ${d.act[0]}.`); }
			else s.reply(h.id, d.readable ? `I looked at ${service} and found no clear cause.` : `I could not read the logs of ${service}.`);
		}
	},
};
