#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";

/**
 * crew - drive Crew without the browser. The UI is one surface of the same operations.
 *   send      talks to a running server over HTTP (agents are dispatched by it); dev logins only for now
 *   the rest  act on the local data directory as its operator (like kubectl on a node): they go through the same
 *             Registry service and checks as the HTTP API, never straight into tables, and write an audit entry.
 */
const HELP = `crew - command line for Crew

  crew send <channel> <text...> --as <user> [--url http://localhost:8080] [--wait 60]
  crew --send '#insights' -m "how is checkout?" --as alice          (quote '#': shells treat it as a comment)

  crew replay [--start <when>] [--end <when>] [--channel <name>] [--kind message,approval,decision,audit] [--json] [--include-dm]
      Read what happened, in order. This does not re-run anything.
      <when>: 2026-10-08T10:00 | today | now | -90m | -2h | -3d

  crew create-realm <name> [--entity <name>]       (or: crew --create-realm <name>)
  crew apply -f <file.yaml|json> [--dry-run] [--no-adopt]
  crew validate -f <file>                           same as apply --dry-run
  crew export [<organization name or id>] [--format yaml|json] [-o file]
  crew orgs                                         list organizations
  crew world new <name> [--spec ticker] [--seed <text>]     a synthetic world (one SQLite file under DATA_DIR/worlds)
  crew world run <name> (--days N | --until DAY) [--slice D] [--max-steps N]
  crew world new <name> --spec itops:none --team ops=3,dev=2 [--faults none|light|heavy]   a world with a team of agents
  crew world watch <name> [--port 8810]   the god eye: a read-only web view of the world (conversation, services, charts, time slider)
  crew world status <name>      |      crew world list
  crew handoffs [--channel <name>] [--status requested,accepted,...] [--json]
  crew case <channel> [--json]                      the shared case picture: who waits for whom, facts, conflicts, decisions
  crew events [--channel <name>] [--correlation <id>] [--limit 100] [--json]   domain events (what happened to the work)

Environment: DATA_DIR (default ./data), CREW_URL (default http://localhost:8080), CREW_USER (audit name).
`;

const { values: v, positionals: pos } = parseArgs({
	allowPositionals: true,
	options: {
		send: { type: "string" }, message: { type: "string", short: "m" }, as: { type: "string" }, url: { type: "string" }, wait: { type: "string" },
		replay: { type: "boolean" }, start: { type: "string" }, end: { type: "string" }, channel: { type: "string" }, kind: { type: "string" }, json: { type: "boolean" }, "include-dm": { type: "boolean" }, limit: { type: "string" },
		"create-realm": { type: "string" }, entity: { type: "string" },
		file: { type: "string", short: "f" }, "dry-run": { type: "boolean" }, "no-adopt": { type: "boolean" },
		format: { type: "string" }, status: { type: "string" }, correlation: { type: "string" },
		seed: { type: "string" }, spec: { type: "string" }, team: { type: "string" }, faults: { type: "string" }, port: { type: "string" }, host: { type: "string" }, days: { type: "string" }, until: { type: "string" }, slice: { type: "string" }, "max-steps": { type: "string" }, output: { type: "string", short: "o" }, help: { type: "boolean", short: "h" },
	},
});

const die = (msg: string, code = 1): never => {
	console.error(`crew: ${msg}`);
	process.exit(code);
};

const COMMANDS = ["send", "replay", "create-realm", "apply", "validate", "export", "orgs", "handoffs", "case", "events", "world", "help"];
const cmd = pos[0] && COMMANDS.includes(pos[0]) ? pos[0] : v.send !== undefined ? "send" : v.replay ? "replay" : v["create-realm"] !== undefined ? "create-realm" : v.help || !pos.length ? "help" : die(`unknown command "${pos[0]}"\n\n${HELP}`);
const rest = pos[0] === cmd ? pos.slice(1) : pos;

async function send() {
	const channel = String(v.send ?? rest.shift() ?? "").replace(/^#/, "");
	const text = (v.message ?? rest.join(" ")).trim();
	const as = v.as ?? die("send needs --as <user> (a dev login such as alice, bob, carol, root)");
	if (!channel || !text) die("usage: crew send <channel> <text...> --as <user>");
	const base = (v.url ?? process.env.CREW_URL ?? "http://localhost:8080").replace(/\/$/, "");
	const login = await fetch(`${base}/auth/login?as=${encodeURIComponent(as)}`, { redirect: "manual" }).catch((e) => die(`cannot reach ${base}: ${e.message}`));
	const cookie = (login as Response).headers.getSetCookie?.().map((c) => c.split(";")[0]).join("; ");
	if (!cookie) die(`login as "${as}" failed: the server is not in AUTH_MODE=dev or has no such dev user. Token login for real accounts is not built yet.`);
	const api = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { cookie, "x-requested-with": "crew", "content-type": "application/json" } });
	const res = await api(`/api/channels/${encodeURIComponent(channel)}/messages`, { method: "POST", body: JSON.stringify({ text }) });
	const body: any = await res.json().catch(() => ({}));
	if (!res.ok) die(`${res.status}: ${body.error ?? "request failed"}`);
	console.log(`sent to #${channel} as ${as}; dispatched to: ${body.dispatchedTo?.join(", ") || "nobody (no @mention)"}`);
	const waitS = Number(v.wait ?? 0);
	if (waitS > 0 && body.dispatchedTo?.length) {
		const seen = new Set<number>([body.message.id]);
		const until = Date.now() + waitS * 1000;
		let quietSince = Date.now();
		while (Date.now() < until) {
			await new Promise((r) => setTimeout(r, 1000));
			const list: any = await (await api(`/api/channels/${encodeURIComponent(channel)}/messages`)).json();
			let working = false;
			for (const m of list.messages as any[]) {
				if (m.id <= body.message.id || m.authorKind === "human") continue;
				if (m.meta?.status === "working") working = true;
				else if (!seen.has(m.id) && m.text) { seen.add(m.id); console.log(`\n${m.authorName}: ${m.text}`); quietSince = Date.now(); }
			}
			if (!working && Date.now() - quietSince > 4000 && seen.size > 1) break;
		}
	}
}

async function localContext() {
	const { Registry } = await import("./org/registry.ts");
	const { store } = await import("./db.ts");
	const reg = new Registry();
	const who = process.env.CREW_USER ?? userInfo().username;
	const actor = { tenantId: "default", participantId: reg.ensureParticipant("default", "human", `cli:${who}`, `cli:${who}`), platformRoles: ["admin"], operator: true };
	return { reg, store, actor, who };
}

async function replay() {
	const { history, formatEntry, parseWhen } = await import("./cli/history.ts");
	const entries = history({
		start: parseWhen(v.start), end: parseWhen(v.end), channel: v.channel, includeDm: v["include-dm"],
		kinds: v.kind?.split(",").map((s) => s.trim()).filter(Boolean), limit: v.limit ? Number(v.limit) : undefined,
	});
	if (v.json) console.log(JSON.stringify(entries, null, 2));
	else {
		for (const e of entries) console.log(formatEntry(e));
		console.error(`${entries.length} event(s)${v["include-dm"] ? "" : "; private chats hidden"}`);
	}
}

async function manifestApply(dry: boolean) {
	const file = v.file ?? rest[0] ?? die("needs -f <file>");
	const { parseManifest, applyManifest } = await import("./cli/manifest.ts");
	const { reg, store, actor, who } = await localContext();
	let plan;
	try {
		plan = applyManifest(reg, actor, parseManifest(readFileSync(file, "utf8"), file), { dryRun: dry, adopt: !v["no-adopt"] });
	} catch (e: any) {
		for (const f of e.findings ?? []) console.error(`  ${f.severity}: ${f.message}`);
		die(e.message);
	}
	if (plan!.realm) console.log(`realm ${plan!.realm}${dry ? " (dry run)" : ""}`);
	for (const o of plan!.organizations) {
		console.log(`organization "${o.name}": ${o.action}${o.adopted ? ", adopted" : ""}${dry && o.action !== "unchanged" ? " (dry run, nothing written)" : ""}`);
		for (const f of o.findings) console.log(`  ${f.severity}: ${f.message}`);
	}
	if (!dry) store.audit(`cli:${who}`, "config.apply", { file, organizations: plan!.organizations.map((o) => `${o.name}:${o.action}`) }, `cli:${who}`);
	if (plan!.organizations.some((o) => o.findings.some((f) => f.severity === "error"))) process.exit(1);
}

async function main() {
	switch (cmd) {
		case "help": return console.log(HELP);
		case "send": return send();
		case "replay": return replay();
		case "validate": return manifestApply(true);
		case "apply": return manifestApply(!!v["dry-run"]);
		case "create-realm": {
			const name = (v["create-realm"] || rest.join(" ")).trim() || die("usage: crew create-realm <name> [--entity <name>]");
			const { applyManifest } = await import("./cli/manifest.ts");
			const { reg, store, actor, who } = await localContext();
			const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
			applyManifest(reg, actor, { realm: { name }, entities: v.entity ? [{ id: slug(v.entity), name: v.entity }] : [] });
			store.audit(`cli:${who}`, "realm.create", { realm: slug(name), entity: v.entity ?? null }, `cli:${who}`);
			return console.log(`realm ${slug(name)} ready${v.entity ? `, entity ${slug(v.entity)}` : ""}`);
		}
		case "world": {
			const { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = await import("node:fs");
			const { join } = await import("node:path");
			const { config } = await import("./config.ts");
			const { World, DAY } = await import("./world/engine.ts");
			const { SPECS } = await import("./world/specs/index.ts");
			const { seededRng } = await import("./world/rng.ts");
			const dir = join(config.dataDir, "worlds");
			const sub = rest[0] ?? die("usage: crew world new|run|status|list");
			if (sub === "list") {
				if (!existsSync(dir)) return console.log("no worlds yet");
				for (const f of readdirSync(dir).filter((f) => f.endsWith(".sqlite"))) console.log(f.replace(/\.sqlite$/, ""));
				return;
			}
			const name = rest[1] ?? die(`usage: crew world ${sub} <name>`);
			if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(name)) die("a world name is 1-40 letters, digits, - or _");
			const path = join(dir, `${name}.sqlite`);
			if (sub === "new") {
				const spec = v.spec ?? "ticker";
				if (!SPECS[spec]) die(`unknown spec "${spec}" (available: ${Object.keys(SPECS).join(", ")})`);
				if (existsSync(path)) die(`world "${name}" already exists`);
				mkdirSync(dir, { recursive: true });
				let team: import("./world/team.ts").TeamFile | undefined;
				if (v.team) {
					const tm = await import("./world/team.ts");
					if (!spec.startsWith("itops")) die("a team needs the IT-ops world (--spec itops:none)");
					try { team = tm.parseTeam(v.team, v.faults ?? "none"); } catch (e) { die((e as Error).message); }
					writeFileSync(join(dir, `${name}.team.json`), JSON.stringify(team));
				}
				const tm = team ? await import("./world/team.ts") : undefined;
				const w = World.open(path, { spec: team ? tm!.teamSpec(SPECS[spec], team) : SPECS[spec], seed: v.seed ?? name, rng: seededRng, name });
				const st = w.status(); w.close();
				return console.log(`world ${name} created (spec ${st.spec}, seed ${st.seed}, ${st.pending} wake-ups scheduled${team ? `; ${tm!.teamIds(team).length} agents: ${tm!.teamIds(team).join(", ")}; tools: ${team.faults}` : ""})`);
			}
			const known = existsSync(path) ? World.describe(path) : undefined;
			if (!known) die(`no world "${name}" (create it with: crew world new ${name})`);
			if (sub === "watch") {
				const { startWatch } = await import("./world/watch-server.ts");
				const port = v.port === undefined ? 8810 : Number(v.port);
				if (!Number.isInteger(port) || port < 0 || port > 65535) die("--port must be a port number");
				const srv = await startWatch({ path, port, host: v.host ?? "127.0.0.1" }).catch((e) => die((e as Error).message));
				console.log(`god eye on ${name}: ${srv.url}   (read-only; Ctrl-C to stop)`);
				return new Promise<void>(() => {});
			}
			const teamPath = join(dir, `${name}.team.json`);
			const teamFile: import("./world/team.ts").TeamFile | undefined = existsSync(teamPath) ? JSON.parse(readFileSync(teamPath, "utf8")) : undefined;
			const teamMod = teamFile ? await import("./world/team.ts") : undefined;
			const baseSpec = SPECS[known!.spec.split("+")[0]] ?? die(`this build does not know the spec "${known!.spec}"`);
			const open = () => World.open(path, { spec: teamFile ? teamMod!.teamSpec(baseSpec, teamFile) : baseSpec, seed: known!.seed, rng: seededRng, name });
			if (sub === "status") {
				const w = open(); const st = w.status(); w.close();
				for (const [k, val] of Object.entries(st)) console.log(`${k}: ${val}`);
				return;
			}
			if (sub === "run") {
				if (v.days === undefined && v.until === undefined) die("run needs --days N or --until DAY");
				const { announceSlice } = await import("./world/report.ts");
				const { bus } = await import("./work/index.ts");
				const w = open();
				const slice = v.slice ? Number(v.slice) : Infinity;
				if (!(slice > 0)) die("--slice must be a positive number of days");
				const maxSteps = v["max-steps"] ? Number(v["max-steps"]) : undefined;
				let remaining = v.days !== undefined ? Number(v.days) : 0, i = 0;
				const target = v.until !== undefined ? Number(v.until) : 0;
				if (v.days !== undefined && !(remaining > 0)) die("--days must be a positive number");
				for (;;) {
					const day = Math.floor(w.status().vtime / DAY);
					const step = v.until !== undefined ? Math.min(slice, target - day) : Math.min(slice, remaining);
					if (!(step > 0)) break;
					let rep: import("./world/types.ts").RunReport, extra = "";
					if (teamFile) {
						// a team world: the agents' shifts are done outside the engine loop (they may be slow, and they may be models)
						const { runAgents } = await import("./world/agents.ts");
						const t0 = Date.now(), ev0 = w.status().events;
						const tr = await runAgents(w, { agents: teamMod!.teamAgents(teamFile), untilDay: day + step, faults: teamMod!.FAULT_PRESETS[teamFile.faults], maxShifts: maxSteps });
						rep = { fromDay: day, toDay: Math.floor(w.status().vtime / DAY), steps: tr.shifts, events: w.status().events - ev0, wallMs: Date.now() - t0, stopped: maxSteps !== undefined && tr.shifts >= maxSteps ? "max-steps" : "done" };
						extra = `, ${tr.shifts} shifts, ${tr.calls} tool calls${tr.errors ? `, ${tr.errors} failed` : ""}${tr.degraded ? `, ${tr.degraded} degraded` : ""}`;
					} else rep = v.until !== undefined ? w.run({ untilDay: day + step, maxSteps }) : w.run({ days: step, maxSteps });
					announceSlice(bus, w, rep);
					console.log(`slice ${++i}: day ${rep.fromDay} -> ${rep.toDay}, ${rep.steps} steps, ${rep.events} events${extra}, ${rep.wallMs} ms, hash ${w.hash().slice(0, 12)}${rep.stopped !== "done" ? `  (stopped: ${rep.stopped})` : ""}`);
					if (rep.stopped !== "done") break;
					remaining -= step;
				}
				w.close();
				return;
			}
			die(`unknown world command "${sub}" (new, run, status, list)`);
		}
		case "handoffs": {
			const { handoffs } = await import("./work/index.ts");
			const list = handoffs.list({ channelId: v.channel?.replace(/^#/, ""), statuses: v.status?.split(",") as any, limit: v.limit ? Number(v.limit) : 100 });
			if (v.json) return console.log(JSON.stringify(list, null, 2));
			for (const h of list.reverse()) console.log(`${new Date(h.createdAt).toISOString().slice(0, 19).replace("T", " ")}  #${h.channelId}  ${h.from} -> ${h.to}  ${h.status}${h.reason ? ` (${h.reason})` : ""}  ${h.text.replace(/\s+/g, " ").slice(0, 70)}`);
			return console.error(`${list.length} handoff(s)`);
		}
		case "case": {
			const { cases } = await import("./work/index.ts");
			const channel = (rest[0] ?? v.channel ?? die("usage: crew case <channel>")).replace(/^#/, "");
			const c = cases.context(channel);
			if (v.json) return console.log(JSON.stringify(c, null, 2));
			console.log(`case #${channel}   responsible: ${c.responsible ?? "nobody"}`);
			for (const a of c.awaiting) console.log(`  waiting: ${a.from} -> ${a.to}  ${a.acknowledged ? a.status : "sent, NOT acknowledged"}${a.overdue ? "  OVERDUE" : ""}  ${a.text}`);
			for (const k of c.conflicts) console.log(`  CONFLICT ${k.key}: ${k.facts.map((f) => `"${f.statement}" (${f.addedBy})`).join("  vs  ")}`);
			for (const t of c.orphanTasks) console.log(`  nobody is on: ${t.title}`);
			for (const f of c.facts.current) console.log(`  fact [${f.confidence}] ${f.key}: ${f.statement}  <- ${f.sourceRefs.join(", ")}`);
			console.log(`  ${c.facts.stale.length} stale, ${c.facts.unverified.length} unverified, ${c.decisions.all.length} decision(s)`);
			return;
		}
		case "events": {
			const { bus } = await import("./work/index.ts");
			const list = bus.list({ channelId: v.channel?.replace(/^#/, ""), correlationId: v.correlation, limit: v.limit ? Number(v.limit) : 100 });
			if (v.json) return console.log(JSON.stringify(list, null, 2));
			for (const e of list) console.log(`${new Date(e.occurredAt).toISOString().slice(0, 19).replace("T", " ")}  #${String(e.channelId ?? "-").padEnd(12)} ${e.type.padEnd(20)} ${e.actorId}  ${e.correlationId.slice(0, 14)}`);
			return console.error(`${list.length} event(s)`);
		}
		case "orgs": {
			const { reg, actor } = await localContext();
			for (const o of reg.listOrgs(actor)) console.log(`${o.id}\t${o.name}\t${o.currentVersionId ? "adopted" : "draft only"}`);
			return;
		}
		case "export": {
			const { exportManifest } = await import("./cli/manifest.ts");
			const { reg, actor } = await localContext();
			const all = reg.listOrgs(actor);
			const want = rest[0];
			const picked = want ? all.filter((o) => o.id === want || o.name === want) : all;
			if (!picked.length) die(want ? `no organization "${want}"` : "no organizations");
			const text = exportManifest(reg, actor, picked.map((o) => o.id), v.format === "json" ? "json" : "yaml");
			if (v.output) { writeFileSync(v.output, text); return console.log(`wrote ${v.output}`); }
			return process.stdout.write(text);
		}
	}
}

main().catch((e) => die(e.message ?? String(e)));
