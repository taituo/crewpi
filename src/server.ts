import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS, agentById } from "./agents.ts";
import { agentsInChannel, canSeeChannel, channelById, createDm, listChannels, parseMentions } from "./channels.ts";
import { callback, login, logout, permsOf, userFrom, type User } from "./auth.ts";
import { assertSafeConfig, config } from "./config.ts";
import { store } from "./db.ts";
import { approvalBus, hub } from "./hub.ts";
import { initRepo } from "./repo.ts";
import { listIntegrations, setEnabled } from "./integrations.ts";
import { isTicketKey, loadExtraTickets, openCase } from "./cases.ts";
import { setAnomaly, startWatcher } from "./watch.ts";
import { deleteNote, saveNote, visibleNotes } from "./memory.ts";
import { MAX_UPLOAD, readImage, saveImage } from "./uploads.ts";
import { budgetState, startBudgetWatch } from "./budget.ts";
import { listSandboxes, startSandboxSweeper, stopSandbox } from "./sandbox.ts";
import { Registry } from "./org/registry.ts";
import { seedDefaultOrg } from "./org/seed.ts";
import { rulePlanner } from "./org/propose.ts";
import { bus } from "./work/index.ts";
import { registerWorkConsumers } from "./work/consumers.ts";
import { DEFAULT_TENANT } from "./migrations.ts";
import { getClient, listLive, signalDecision, startIncident } from "./temporal-client.ts";
import { startTemporalWorker } from "./temporal.ts";
import { setChannelStatus } from "./channels.ts";
import { compactAgent, inferenceInfo, memtreeInfo, presence, presenceChanged, startRuntime, stopAgent, stopRuntime, submitToAgent } from "./runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(here, "..", "public");
const NODE_MODULES = resolve(here, "..", "node_modules");
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
	".ico": "image/x-icon",
};
const VENDOR: Record<string, string> = {
	"/vendor/preact.js": join(NODE_MODULES, "htm/preact/standalone.module.js"),
};

const json = (res: ServerResponse, code: number, body: unknown) =>
	res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));

async function readBody(req: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const c of req) {
		size += c.length;
		if (size > 64_000) throw Object.assign(new Error("body too large"), { status: 413 });
		chunks.push(c);
	}
	try {
		return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
	} catch {
		throw Object.assign(new Error("invalid JSON"), { status: 400 });
	}
}

async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const c of req) {
		size += c.length;
		if (size <= max) chunks.push(c);
		// Keep draining (and discarding) a bounded amount so the client can read our 413 instead of a reset.
		else if (size > max * 4) {
			req.destroy();
			break;
		}
	}
	if (size > max) throw Object.assign(new Error(`file too large (max ${Math.round(max / 1048576)} MB)`), { status: 413 });
	return Buffer.concat(chunks);
}

const auditAs = (user: User, action: string, detail: Record<string, unknown> = {}) => store.audit(`user:${user.name}`, action, detail, user.sub);

const registry = new Registry();
const err = (status: number, message: string) => Object.assign(new Error(message), { status });

async function serveStatic(res: ServerResponse, pathname: string) {
	const file = VENDOR[pathname] ?? resolve(PUBLIC, `.${normalize(pathname === "/" ? "/index.html" : pathname)}`);
	if (!VENDOR[pathname] && !file.startsWith(PUBLIC)) return json(res, 403, { error: "forbidden" });
	try {
		const data = await readFile(file);
		res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" }).end(data);
	} catch {
		json(res, 404, { error: "not found" });
	}
}

function publicState(user: User) {
	return {
		user: { sub: user.sub, name: user.name, roles: user.roles },
		perms: permsOf(user),
		brand: config.brand,
		channels: listChannels(true, user.sub),
		agents: AGENTS.map(({ instructions: _i, ...a }) => a),
		presence: presence(),
		inference: { ...inferenceInfo(), budget: budgetState() },
		integrations: listIntegrations(),
	};
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL, user: User) {
	const perms = permsOf(user);
	const path = url.pathname;
	const m = req.method ?? "GET";

	if (m !== "GET" && req.headers["x-requested-with"] !== "crew") throw err(403, "missing X-Requested-With");

	if (m === "GET" && path === "/api/me") return json(res, 200, publicState(user));

	if (m === "GET" && path === "/api/events") {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
		res.write(`event: hello\ndata: {}\n\n`);
		hub.add(res, user.sub);
		return;
	}

	let mm: RegExpExecArray | null;

	if (m === "POST" && (mm = /^\/api\/channels\/([\w-]+)\/upload$/.exec(path))) {
		if (!perms.post) throw err(403, "your role is view-only");
		const chan = canSeeChannel(user.sub, mm[1]) ? channelById(mm[1]) : undefined;
		if (!chan || chan.status !== "open") throw err(404, "no such channel");
		const bytes = await readRaw(req, MAX_UPLOAD);
		try {
			const { id, mime } = await saveImage(bytes);
			const name = (url.searchParams.get("name") ?? "image").replace(/[^\w.\- ]/g, "_").slice(0, 80) || "image";
			store.addAttachment({ id, channelId: chan.id, name, mime, size: bytes.length, owner: user.sub });
			return json(res, 200, { attachment: { id, name, mime, size: bytes.length } });
		} catch (e: any) {
			throw err(415, e.message);
		}
	}

	if (m === "GET" && (mm = /^\/api\/files\/([a-f0-9]{32})$/.exec(path))) {
		const att = store.getAttachment(mm[1]);
		if (!att || !canSeeChannel(user.sub, att.channelId)) throw err(404, "not found");
		const data = await readImage(att.id, att.mime);
		res.writeHead(200, { "content-type": att.mime, "content-length": data.length, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" }).end(data);
		return;
	}
	if (m === "GET" && (mm = /^\/api\/channels\/([\w-]+)\/messages$/.exec(path))) {
		if (!canSeeChannel(user.sub, mm[1])) throw err(404, "no such channel");
		return json(res, 200, { messages: store.listMessages(mm[1]) });
	}

	if (m === "POST" && (mm = /^\/api\/channels\/([\w-]+)\/messages$/.exec(path))) {
		const channelId = mm[1];
		const chan = canSeeChannel(user.sub, channelId) ? channelById(channelId) : undefined;
		if (!chan) throw err(404, "no such channel");
		if (chan.status === "archived") throw err(409, "this case channel is archived; reopen it to continue");
		if (!perms.post) throw err(403, "your role is view-only");
		const body = await readBody(req);
		const attIds: string[] = Array.isArray(body.attachments) ? body.attachments.map(String).slice(0, 4) : [];
		const atts = attIds.map((id) => store.getAttachment(id, channelId));
		if (atts.some((a) => !a || a.owner !== user.sub)) throw err(400, "unknown attachment");
		const text = String(body.text ?? "").trim() || (atts.length ? "(image)" : "");
		if (!text || text.length > 4000) throw err(400, "message must be 1-4000 characters");
		const msg = store.addMessage({ channelId, authorKind: "human", authorId: user.sub, authorName: user.name, text, meta: atts.length ? { attachments: atts.map((a) => ({ id: a!.id, name: a!.name, mime: a!.mime })) } : {} });
		const images = await Promise.all(atts.map(async (a) => ({ data: (await readImage(a!.id, a!.mime)).toString("base64"), mimeType: a!.mime, name: a!.name })));
		hub.publish({ type: "message", message: msg });
		const mentioned = chan.kind === "dm" ? chan.agents : parseMentions(channelId, text); // a private chat answers every message
		const absent = [...text.matchAll(/@([a-zA-Z][\w-]*)/g)].map((x) => x[1].toLowerCase()).filter((id) => agentById(id) && !mentioned.includes(id));
		for (const id of new Set(absent)) {
			hub.publish({
				type: "message",
				message: store.addMessage({
					channelId,
					authorKind: "system",
					authorId: "system",
					authorName: "System",
					text: `${agentById(id)!.name} is not in #${channelId}. Agents here: ${agentsInChannel(channelId).map((a) => a.name).join(", ")}.`,
					meta: { kind: "notice" },
				}),
			});
		}
		for (const agentId of mentioned) {
			submitToAgent({ channelId, agentId, text, images, from: { kind: "human", id: user.sub, name: user.name } }).catch((e) => {
				console.error("dispatch failed", e);
				hub.publish({
					type: "message",
					message: store.addMessage({ channelId, authorKind: "system", authorId: "system", authorName: "System", text: `Could not reach ${agentId}: ${e.message}`, meta: { kind: "notice" } }),
				});
			});
		}
		return json(res, 200, { message: msg, dispatchedTo: mentioned });
	}

	if (m === "POST" && (mm = /^\/api\/channels\/([\w-]+)\/agents\/([\w-]+)\/stop$/.exec(path))) {
		if (!perms.operate) throw err(403, "operators only");
		if (!canSeeChannel(user.sub, mm[1])) throw err(404, "no such channel");
		await stopAgent(mm[1], mm[2]);
		auditAs(user, "agent.stop", { channel: mm[1], agent: mm[2] });
		return json(res, 200, { ok: true });
	}

	if (m === "GET" && (mm = /^\/api\/channels\/([\w-]+)\/agents\/([\w-]+)\/memtree$/.exec(path))) {
		if (!canSeeChannel(user.sub, mm[1])) throw err(404, "no such channel");
		return json(res, 200, memtreeInfo(mm[1], mm[2]));
	}

	if (m === "POST" && (mm = /^\/api\/channels\/([\w-]+)\/agents\/([\w-]+)\/compact$/.exec(path))) {
		if (!perms.operate) throw err(403, "operators only");
		if (!canSeeChannel(user.sub, mm[1]) || !channelById(mm[1])?.agents.includes(mm[2])) throw err(404, "no such channel or agent");
		const r = await compactAgent(mm[1], mm[2]);
		auditAs(user, "memory.compact", { channel: mm[1], agent: mm[2], ...r });
		return json(res, 200, r);
	}

	if (m === "GET" && path === "/api/approvals") {
		return json(res, 200, { approvals: store.listApprovals(url.searchParams.get("status") === "pending" ? "pending" : undefined).filter((a) => canSeeChannel(user.sub, a.channelId)) });
	}

	if (m === "POST" && (mm = /^\/api\/approvals\/(\d+)\/decide$/.exec(path))) {
		if (!perms.approve) throw err(403, "only approvers can decide");
		const body = await readBody(req);
		const decision = body.decision === "approve" ? "approved" : body.decision === "reject" ? "rejected" : undefined;
		if (!decision) throw err(400, "decision must be approve or reject");
		const note = body.note ? String(body.note).slice(0, 300) : null;
		const target = store.getApproval(Number(mm[1]));
		if (!target || !canSeeChannel(user.sub, target.channelId)) throw err(404, "approval not found");
		// Separation of duties: whoever started the chain that asks for this change cannot be the one who approves it.
		if (config.policy.separationOfDuties && target.requestedBySub && target.requestedBySub === user.sub) throw err(403, "you started the request this approval is for; another approver has to decide (separation of duties)");
		const a = store.decideApproval(Number(mm[1]), decision, user.name, note, user.sub);
		if (!a) throw err(409, "already decided or not found");
		const mid = a.detail.messageId as number | undefined;
		if (mid) {
			const cur = store.getMessage(mid);
			const updated = cur && store.updateMessage(mid, { meta: { ...cur.meta, status: a.status, decidedBy: a.decidedBy, note: a.note } });
			if (updated) hub.publish({ type: "message", message: updated });
		}
		auditAs(user, `approval.${decision}`, { approvalId: a.id, title: a.title });
		try {
			saveNote({ agentId: a.agentId, channelId: a.channelId, text: `${a.status === "approved" ? "Approved" : "Rejected"} by ${user.name}${note ? ` ("${note}")` : ""}: ${a.title}`, source: "system" });
		} catch { /* a note is a convenience, never a reason to fail the decision */ }
		hub.publish({ type: "approval", approval: a });
		approvalBus.emit("decided", a.id);
		presenceChanged();
		return json(res, 200, { approval: a });
	}

	if (m === "POST" && (mm = /^\/api\/integrations\/([\w-]+)$/.exec(path))) {
		if (!perms.admin) throw err(403, "admins only");
		const body = await readBody(req);
		if (!setEnabled(mm[1], !!body.enabled, `user:${user.name}`)) throw err(404, "no such integration");
		return json(res, 200, { integrations: listIntegrations() });
	}

	if (m === "GET" && path === "/api/channels") return json(res, 200, { channels: listChannels(true, user.sub) });

	if (m === "POST" && path === "/api/dms") {
		if (!perms.operate) throw err(403, "operators only");
		const body = await readBody(req);
		try {
			const { channel, created } = createDm({ sub: user.sub, userName: user.name, agentId: String(body.agent ?? "") });
			if (created) {
				hub.publish({
					type: "message",
					message: store.addMessage({
						channelId: channel.id, authorKind: "system", authorId: "system", authorName: "System",
						text: `Private chat with ${channel.name}. Only you can see it, and ${channel.name} answers every message (no @ needed). It cannot hand work to other agents or open shared channels from here.`,
						meta: { kind: "notice" },
					}),
				});
			}
			return json(res, 200, { channel, created });
		} catch (e: any) {
			throw err(400, e.message);
		}
	}

	if (m === "POST" && path === "/api/channels") {
		if (!perms.operate) throw err(403, "operators only");
		const body = await readBody(req);
		const input = String(body.ticket ?? body.topic ?? "").trim();
		if (!input) throw err(400, "give a ticket key or a topic");
		try {
			const { channel, created } = await openCase({
				...(isTicketKey(input) ? { ticket: input.toUpperCase() } : { topic: input }),
				createdBy: user.name, source: "manual", notifyIn: body.from ? String(body.from) : undefined,
				lead: body.lead ? String(body.lead) : undefined, brief: body.brief ? String(body.brief).slice(0, 1000) : undefined,
			});
			return json(res, 200, { channel, created });
		} catch (e: any) {
			throw err(400, e.message);
		}
	}

	if (m === "POST" && (mm = /^\/api\/channels\/([\w-]+)\/(archive|reopen)$/.exec(path))) {
		if (!perms.operate) throw err(403, "operators only");
		if (!canSeeChannel(user.sub, mm[1])) throw err(404, "no such channel");
		const ch = setChannelStatus(mm[1], mm[2] === "archive" ? "archived" : "open");
		if (!ch) throw err(400, "only case channels can be archived");
		auditAs(user, `channel.${mm[2]}`, { channel: ch.id });
		if (mm[2] === "archive") {
			void stopSandbox(ch.id).catch(() => undefined);
			for (const agentId of ch.agents) {
				try { saveNote({ agentId, channelId: ch.id, scope: "agent", text: `Case ${ch.ticket ?? "#" + ch.id} archived by ${user.name}: ${ch.topic}`, source: "system" }); } catch { /* ignore */ }
			}
		}
		return json(res, 200, { channel: ch });
	}

	if (m === "POST" && path === "/api/demo/anomaly") {
		if (!perms.admin) throw err(403, "admins only");
		const body = await readBody(req);
		try { setAnomaly(String(body.metric ?? "orders_queue_depth"), body.active !== false); } catch (e: any) { throw err(400, e.message); }
		auditAs(user, "demo.anomaly", { metric: body.metric ?? "orders_queue_depth", active: body.active !== false });
		return json(res, 200, { ok: true });
	}

	if (m === "GET" && path === "/api/workflows") {
		const all = await listLive(20).catch(() => []);
		return json(res, 200, { available: !!(await getClient()), workflows: all.filter((w) => !w.channelId || canSeeChannel(user.sub, w.channelId)) });
	}

	if (m === "POST" && path === "/api/workflows/incident") {
		if (!perms.operate) throw err(403, "operators only");
		const body = await readBody(req);
		const ch = canSeeChannel(user.sub, String(body.channel)) ? channelById(String(body.channel)) : undefined;
		if (!ch || ch.kind !== "issue" || ch.status !== "open") throw err(400, "start it from an open case channel");
		try {
			const r = await startIncident({ channelId: ch.id, ticket: ch.ticket, brief: `${ch.ticket ?? ch.name}: ${ch.topic}`, lead: body.lead ? String(body.lead) : undefined, monitorSeconds: 45 });
			auditAs(user, "workflow.start", { channel: ch.id, ...r });
			return json(res, 200, r);
		} catch (e: any) { throw err(503, e.message); }
	}

	if (m === "POST" && (mm = /^\/api\/workflows\/([\w-]+)\/decision$/.exec(path))) {
		if (!perms.approve) throw err(403, "only approvers can decide");
		const body = await readBody(req);
		const decision = ["continue", "close", "abort"].includes(body.decision) ? body.decision : undefined;
		if (!decision) throw err(400, "decision must be continue, close or abort");
		const channelId = mm[1].replace(/^incident-/, "");
		if (!canSeeChannel(user.sub, channelId)) throw err(404, "no such workflow");
		await signalDecision(mm[1], { decision, by: user.name, note: body.note ? String(body.note).slice(0, 300) : undefined }).catch((e) => { throw err(409, e.message); });
		auditAs(user, "workflow.decision", { workflow: mm[1], decision });
		return json(res, 200, { ok: true });
	}

	if (m === "GET" && path === "/api/sandboxes") return json(res, 200, { sandboxes: listSandboxes().filter((s) => canSeeChannel(user.sub, s.key)) });

	if (m === "POST" && (mm = /^\/api\/sandboxes\/([\w-]+)\/stop$/.exec(path))) {
		if (!perms.operate || !canSeeChannel(user.sub, mm[1])) throw err(403, "operators only");
		const stopped = await stopSandbox(mm[1]);
		auditAs(user, "sandbox.stop", { channel: mm[1] });
		return json(res, 200, { stopped });
	}

	if (path.startsWith("/api/orgs")) {
		if (!config.features.orgModel) throw err(404, "no such endpoint");
		const reg = registry;
		const actor = { tenantId: DEFAULT_TENANT, participantId: reg.ensureParticipant(DEFAULT_TENANT, "human", user.sub, user.name), platformRoles: user.roles };
		const body = m === "GET" ? {} : await readBody(req);
		if (m === "GET" && path === "/api/orgs") return json(res, 200, { organizations: reg.listOrgs(actor) });
		if (m === "POST" && path === "/api/orgs") {
			const r = reg.createOrg(actor, { name: String(body.name ?? "") });
			auditAs(user, "org.create", r);
			return json(res, 200, r);
		}
		if ((mm = /^\/api\/orgs\/([\w-]+)$/.exec(path)) && m === "GET") return json(res, 200, reg.describe(actor, mm[1], url.searchParams.get("version") ?? undefined));
		if ((mm = /^\/api\/orgs\/([\w-]+)\/versions$/.exec(path))) {
			if (m === "GET") return json(res, 200, { versions: reg.listVersions(actor, mm[1]) });
			if (m === "POST") {
				const r = reg.createDraft(actor, mm[1], body.from ? String(body.from) : undefined, String(body.note ?? "").slice(0, 200));
				auditAs(user, "org.draft", { org: mm[1], ...r });
				return json(res, 200, r);
			}
		}
		if ((mm = /^\/api\/orgs\/([\w-]+)\/versions\/([\w-]+)\/(ops|validate|adopt|propose)$/.exec(path)) && m !== "GET") {
			if (mm[3] === "ops") {
				if (!Array.isArray(body.ops)) throw err(400, "ops must be an array");
				const r = reg.applyOps(actor, mm[1], mm[2], body.ops);
				auditAs(user, "org.edit", { org: mm[1], version: mm[2], ops: body.ops.length });
				return json(res, 200, r);
			}
			if (mm[3] === "propose") {
				// A proposal is only a preview of operations; applying them is a separate, authorized call.
				if (!reg.can(actor, mm[1], "org.edit")) throw err(403, "requires org.edit");
				return json(res, 200, rulePlanner(String(body.text ?? "").slice(0, 2000)));
			}
			if (mm[3] === "validate") return json(res, 200, { findings: reg.validate(actor, mm[1], mm[2]) });
			try {
				const r = reg.adopt(actor, mm[1], mm[2]);
				auditAs(user, "org.adopt", { org: mm[1], version: mm[2] });
				return json(res, 200, r);
			} catch (e: any) {
				if (e.findings) return json(res, 409, { error: e.message, findings: e.findings });
				throw e;
			}
		}
		throw err(404, "no such endpoint");
	}

	if (m === "GET" && path === "/api/budget") return json(res, 200, { budget: budgetState() ?? null });

	if (m === "GET" && path === "/api/memory") return json(res, 200, { notes: visibleNotes(user.sub) });

	if (m === "POST" && (mm = /^\/api\/memory\/(\d+)\/delete$/.exec(path))) {
		if (!deleteNote(Number(mm[1]), user.sub, perms.admin)) throw err(404, "no such note, or not yours to delete");
		auditAs(user, "memory.delete", { id: Number(mm[1]) });
		return json(res, 200, { ok: true });
	}

	if (m === "GET" && path === "/api/audit") {
		if (!perms.approve) throw err(403, "approvers only");
		return json(res, 200, { audit: store.listAudit() });
	}

	throw err(404, "no such endpoint");
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", config.publicUrl);
	try {
		if (url.pathname === "/healthz") return json(res, 200, { ok: true });
		if (url.pathname === "/auth/login") return login(req, res, url);
		if (url.pathname === "/auth/callback") return await callback(req, res, url);
		if (url.pathname === "/auth/logout") return logout(req, res);

		const user = userFrom(req);
		if (url.pathname.startsWith("/api/")) {
			if (!user) return json(res, 401, { error: "not signed in" });
			return await api(req, res, url, user);
		}
		if (!user && (url.pathname === "/" || url.pathname === "/index.html")) {
			res.writeHead(302, { location: "/auth/login" }).end();
			return;
		}
		return await serveStatic(res, url.pathname);
	} catch (e: any) {
		if (!res.headersSent) json(res, e.status ?? 500, { error: e.message ?? "internal error" });
		else res.end();
		if (!e.status) console.error(e);
	}
});

async function seedChannels() {
	for (const c of listChannels(true).filter((c) => c.kind === "standing")) {
		if (store.listMessages(c.id, 1).length) continue;
		const names = agentsInChannel(c.id).map((a) => `@${a.id}`).join(", ");
		store.addMessage({
			channelId: c.id,
			authorKind: "system",
			authorId: "system",
			authorName: "System",
			text: `Welcome to #${c.name} — ${c.topic}. Agents here: ${names}. Mention one to give it work.`,
			meta: { kind: "notice" },
		});
	}
}

assertSafeConfig();
await initRepo();
if (config.features.orgModel) seedDefaultOrg(registry);
await seedChannels();
await startRuntime();
startBudgetWatch();
registerWorkConsumers();
bus.start();
startSandboxSweeper();
void startTemporalWorker();
loadExtraTickets();
startWatcher();
server.listen(config.port, () => console.log(`${config.brand.name} listening on :${config.port} (auth=${config.auth.mode})`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, async () => {
		server.close();
		bus.stop();
		await stopRuntime().catch(() => undefined);
		process.exit(0);
	});
}
