// End-to-end through a real provider path: the server talks to a fake OpenAI-compatible endpoint
// (what vLLM/Ollama expose) instead of the scripted demo brains.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seen: any[] = [];
const sse = (res: any, delta: any, finish: string | null = null) =>
	res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);

const mock = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const r = JSON.parse(body);
		seen.push(r);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const last = r.messages[r.messages.length - 1];
		if (last.role === "tool") {
			sse(res, { role: "assistant", content: "The repo has " });
			sse(res, { content: "demo-apps/checkout-config.json." });
			sse(res, {}, "stop");
		} else {
			sse(res, { role: "assistant", content: "Let me look. " });
			sse(res, { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "repo_list", arguments: "{}" } }] });
			sse(res, {}, "tool_calls");
		}
		res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "mock", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
});
await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
const mockPort = (mock.address() as any).port;

let child: ChildProcess;
const PORT = 18123;
const base = `http://127.0.0.1:${PORT}`;
after(() => {
	child?.kill();
	mock.close();
});

test("agent answers through an OpenAI-compatible endpoint, calling a real tool", async () => {
	child = spawn("node", ["src/server.ts"], {
		env: {
			...process.env,
			PORT: String(PORT),
			PUBLIC_URL: base,
			AUTH_MODE: "dev",
			DATA_DIR: mkdtempSync(join(tmpdir(), "crew-e2e-")),
			LOCAL_LLM_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
			LOCAL_LLM_MODEL: "mock",
			AGENT_DEVELOPER_MODEL: "local/mock",
		},
		stdio: ["ignore", "inherit", "inherit"],
	});
	for (let i = 0; i < 50; i++) {
		if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) break;
		await new Promise((r) => setTimeout(r, 200));
	}
	const login = await fetch(`${base}/auth/login?as=alice`, { redirect: "manual" });
	const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
	assert.ok(cookie.startsWith("session="));
	const h = { cookie, "content-type": "application/json", "x-requested-with": "crew" };

	const noHeader = await fetch(`${base}/api/channels/development/messages`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
	assert.equal(noHeader.status, 403, "CSRF header required on writes");
	const anon = await fetch(`${base}/api/me`);
	assert.equal(anon.status, 401);

	const post = await fetch(`${base}/api/channels/development/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "@developer what is in the repo?" }) });
	assert.deepEqual((await post.json()).dispatchedTo, ["developer"]);

	let agentMsg: any;
	for (let i = 0; i < 60 && !(agentMsg?.meta.status === "done"); i++) {
		await new Promise((r) => setTimeout(r, 250));
		const { messages } = await (await fetch(`${base}/api/channels/development/messages`, { headers: h })).json();
		agentMsg = messages.find((m: any) => m.authorKind === "agent");
	}
	assert.equal(agentMsg?.meta.status, "done", JSON.stringify(agentMsg));
	assert.match(agentMsg.text, /demo-apps\/checkout-config\.json/);
	assert.ok(agentMsg.meta.activity.some((a: any) => a.name === "repo_list" && a.status === "done"));

	// What the model was actually sent
	const first = seen[0];
	assert.equal(first.model, "mock");
	assert.ok(first.tools.some((t: any) => t.function.name === "repo_write"), "developer is offered write tools");
	assert.ok(!first.tools.some((t: any) => t.function.name.startsWith("k8s_")), "developer is NOT offered cluster tools");
	assert.match(JSON.stringify(first.messages[0]), /Developer/);
	assert.match(JSON.stringify(first.messages), /\[#development\] Alice/);
});

test("a viewer cannot post", async () => {
	const login = await fetch(`${base}/auth/login?as=carol`, { redirect: "manual" });
	const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
	const res = await fetch(`${base}/api/channels/general/messages`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-requested-with": "crew" }, body: JSON.stringify({ text: "hi" }) });
	assert.equal(res.status, 403);
});

test("private chats: owner-only, auto-answered, filtered from lists, messages and the live stream", async () => {
	const sess = async (as: string) => {
		const l = await fetch(`${base}/auth/login?as=${as}`, { redirect: "manual" });
		const cookie = (l.headers.getSetCookie()[0] ?? "").split(";")[0];
		return { cookie, h: { cookie, "content-type": "application/json", "x-requested-with": "crew" } };
	};
	const alice = await sess("alice");
	const bob = await sess("bob");

	// Bob listens to the live stream while Alice talks privately.
	const seen: string[] = [];
	const ac = new AbortController();
	const stream = fetch(`${base}/api/events`, { headers: { cookie: bob.cookie }, signal: ac.signal }).then(async (r) => {
		const reader = r.body!.getReader();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			seen.push(Buffer.from(value).toString());
		}
	}).catch(() => undefined);
	await new Promise((r) => setTimeout(r, 300));

	const created = await (await fetch(`${base}/api/dms`, { method: "POST", headers: alice.h, body: JSON.stringify({ agent: "ops" }) })).json();
	const dm = created.channel.id as string;
	assert.match(dm, /^dm-ops-/);
	assert.equal((await (await fetch(`${base}/api/dms`, { method: "POST", headers: alice.h, body: JSON.stringify({ agent: "ops" }) })).json()).created, false, "idempotent");

	await fetch(`${base}/api/channels/${dm}/messages`, { method: "POST", headers: alice.h, body: JSON.stringify({ text: "secret plan: no mention needed" }) });
	let reply: any;
	for (let i = 0; i < 60 && reply?.meta.status !== "done"; i++) {
		await new Promise((r) => setTimeout(r, 250));
		const { messages } = await (await fetch(`${base}/api/channels/${dm}/messages`, { headers: alice.h })).json();
		reply = messages.find((m: any) => m.authorKind === "agent");
	}
	assert.equal(reply?.meta.status, "done", "the agent answers a private message without an @mention");

	assert.equal((await fetch(`${base}/api/channels/${dm}/messages`, { headers: bob.h })).status, 404, "other users cannot read it");
	assert.equal((await fetch(`${base}/api/channels/${dm}/messages`, { method: "POST", headers: bob.h, body: JSON.stringify({ text: "hi" }) })).status, 404, "or write to it");
	const bobMe = await (await fetch(`${base}/api/me`, { headers: bob.h })).json();
	assert.ok(!bobMe.channels.some((c: any) => c.id === dm), "not listed for others");
	const aliceMe = await (await fetch(`${base}/api/me`, { headers: alice.h })).json();
	assert.ok(aliceMe.channels.some((c: any) => c.id === dm), "listed for the owner");

	await new Promise((r) => setTimeout(r, 500));
	ac.abort();
	await stream;
	const wire = seen.join("");
	assert.ok(!wire.includes(dm) && !wire.includes("secret plan"), "nothing of the private chat reaches another user's live stream");
});

test("images: validated by content, delivered to a vision-capable model, private chats protect files", async () => {
	// A second server whose local model is declared vision-capable.
	const port2 = 18124, base2 = `http://127.0.0.1:${port2}`;
	const before = seen.length;
	const child2 = spawn("node", ["src/server.ts"], {
		env: { ...process.env, PORT: String(port2), PUBLIC_URL: base2, AUTH_MODE: "dev", DATA_DIR: mkdtempSync(join(tmpdir(), "crew-img-")), LOCAL_LLM_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, LOCAL_LLM_MODEL: "mock", LOCAL_LLM_VISION: "true", AGENT_DEVELOPER_MODEL: "local/mock" },
		stdio: ["ignore", "inherit", "inherit"],
	});
	try {
		for (let i = 0; i < 50; i++) { if (await fetch(`${base2}/healthz`).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 200)); }
		const sess = async (as: string) => {
			const l = await fetch(`${base2}/auth/login?as=${as}`, { redirect: "manual" });
			const cookie = (l.headers.getSetCookie()[0] ?? "").split(";")[0];
			return { cookie, json: { cookie, "content-type": "application/json", "x-requested-with": "crew" } };
		};
		const alice = await sess("alice"), bob = await sess("bob");
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

		const bad = await fetch(`${base2}/api/channels/development/upload?name=x.png`, { method: "POST", headers: { cookie: alice.cookie, "x-requested-with": "crew", "content-type": "image/png" }, body: Buffer.from("<svg onload=alert(1)>") });
		assert.equal(bad.status, 415, "not an image by content, whatever the declared type");
		const big = await fetch(`${base2}/api/channels/development/upload`, { method: "POST", headers: { cookie: alice.cookie, "x-requested-with": "crew", "content-type": "image/png" }, body: Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]) });
		assert.equal(big.status, 413);

		const up = await fetch(`${base2}/api/channels/development/upload?name=shot.png`, { method: "POST", headers: { cookie: alice.cookie, "x-requested-with": "crew", "content-type": "image/png" }, body: png });
		const att = (await up.json()).attachment;
		assert.equal(att.mime, "image/png");
		const stolen = await fetch(`${base2}/api/messages`, { headers: bob.json }); void stolen;
		await fetch(`${base2}/api/channels/development/messages`, { method: "POST", headers: alice.json, body: JSON.stringify({ text: "@developer what is in this screenshot?", attachments: [att.id] }) });
		for (let i = 0; i < 40 && seen.length === before; i++) await new Promise((r) => setTimeout(r, 250));
		const sent = JSON.stringify(seen[before]?.messages ?? []);
		assert.match(sent, /image_url/, "the image reached the model as an image part");
		assert.match(sent, /data:image\/png;base64,/);

		// Another user's attachment ids are refused, and a private chat's files are not readable by others.
		const foreign = await fetch(`${base2}/api/channels/development/messages`, { method: "POST", headers: bob.json, body: JSON.stringify({ text: "x", attachments: [att.id] }) });
		assert.equal(foreign.status, 400, "cannot attach someone else's upload");
		const dm = (await (await fetch(`${base2}/api/dms`, { method: "POST", headers: alice.json, body: JSON.stringify({ agent: "ops" }) })).json()).channel.id;
		const dmUp = await fetch(`${base2}/api/channels/${dm}/upload?name=p.png`, { method: "POST", headers: { cookie: alice.cookie, "x-requested-with": "crew", "content-type": "image/png" }, body: Buffer.concat([png, Buffer.from([1, 2, 3])]) });
		const dmId = (await dmUp.json()).attachment.id;
		assert.equal((await fetch(`${base2}/api/files/${dmId}`, { headers: { cookie: alice.cookie } })).status, 200);
		assert.equal((await fetch(`${base2}/api/files/${dmId}`, { headers: { cookie: bob.cookie } })).status, 404, "private image is invisible to others");
		const served = await fetch(`${base2}/api/files/${att.id}`, { headers: { cookie: bob.cookie } });
		assert.equal(served.headers.get("x-content-type-options"), "nosniff");
	} finally {
		child2.kill();
	}
});

test("compaction replaces old history with the compressed memory view, which reaches the model", async () => {
	const port3 = 18125, base3 = `http://127.0.0.1:${port3}`;
	const child3 = spawn("node", ["src/server.ts"], {
		env: { ...process.env, PORT: String(port3), PUBLIC_URL: base3, AUTH_MODE: "dev", DATA_DIR: mkdtempSync(join(tmpdir(), "crew-compact-")), LOCAL_LLM_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, LOCAL_LLM_MODEL: "mock", AGENT_DEVELOPER_MODEL: "local/mock", COMPACT_KEEP_RECENT_TOKENS: "80", OPTCHAT_VIEW_BYTES: "3000" },
		stdio: ["ignore", "inherit", "inherit"],
	});
	try {
		for (let i = 0; i < 50; i++) { if (await fetch(`${base3}/healthz`).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 200)); }
		const l = await fetch(`${base3}/auth/login?as=alice`, { redirect: "manual" });
		const cookie = (l.headers.getSetCookie()[0] ?? "").split(";")[0];
		const h = { cookie, "content-type": "application/json", "x-requested-with": "crew" };
		const say = async (text: string) => {
			const before = (await (await fetch(`${base3}/api/channels/development/messages`, { headers: h })).json()).messages.filter((m: any) => m.authorKind === "agent" && m.meta.status === "done").length;
			await fetch(`${base3}/api/channels/development/messages`, { method: "POST", headers: h, body: JSON.stringify({ text }) });
			for (let i = 0; i < 80; i++) {
				await new Promise((r) => setTimeout(r, 200));
				const ms = (await (await fetch(`${base3}/api/channels/development/messages`, { headers: h })).json()).messages;
				if (ms.filter((m: any) => m.authorKind === "agent" && m.meta.status === "done").length > before) return;
			}
			throw new Error("agent did not answer");
		};
		for (let i = 0; i < 5; i++) await say(`@developer note ${i}: the staging password rotation happens on day ${i + 10}, remember it`);
		const info = await (await fetch(`${base3}/api/channels/development/agents/developer/memtree`, { headers: h })).json();
		assert.ok(info.leaves >= 20, `leaves were recorded (${info.leaves})`);
		const r = await (await fetch(`${base3}/api/channels/development/agents/developer/compact`, { method: "POST", headers: h, body: "{}" })).json();
		assert.equal(r.compacted, true, "Pi compacted the conversation");
		const mark = seen.length;
		await say("@developer what did I tell you about password rotation?");
		const sent = JSON.stringify(seen.slice(mark).map((x) => x.messages));
		assert.match(sent, /Compressed memory of the earlier conversation/, "the OptChat view replaced the old history");
		assert.match(sent, /memory_zoom/);
		assert.match(sent, /#0\.\d+ user/, "recent-enough lines are addressable");
		assert.ok(!/note 0: the staging password rotation happens on day 10, remember it/.test(sent) || /#\d\.\d+ /.test(sent), "old messages are only present through the view");
		assert.ok(seen.slice(mark).some((x) => x.tools.some((t: any) => t.function.name === "memory_zoom")), "the model can call memory_zoom");
	} finally {
		child3.kill();
	}
});
