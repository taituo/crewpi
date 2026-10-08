// Privacy of private chats (DMs): owner-only across REST, SSE, presence, memory, approvals, audit.
// Real server on port 18150, AUTH_MODE=dev, DEMO_MODE=true, temp DATA_DIR.
// Every negative check has a positive control: the owner can read the same thing others get 404 for.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = 18150;
const base = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
after(() => server?.kill());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Session = {
  cookie: string;
  raw: (p: string, init?: RequestInit) => Promise<Response>;
  getJson: (p: string) => Promise<any>;
};

async function session(as: string): Promise<Session> {
  const res = await fetch(`${base}/auth/login?as=${as}`, { redirect: "manual" });
  const cookie = (res.headers.getSetCookie()[0] ?? "").split(";")[0];
  assert.ok(cookie.length > 0, `login as ${as} sets a cookie`);
  const raw = (p: string, init: RequestInit = {}) =>
    fetch(`${base}${p}`, {
      ...init,
      headers: { cookie, "content-type": "application/json", "x-requested-with": "crew", ...(init.headers ?? {}) },
    });
  const getJson = async (p: string) => (await raw(p)).json() as Promise<any>;
  return { cookie, raw, getJson };
}

async function collectStream(cookie: string, ms: number): Promise<string> {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: ctrl.signal });
  assert.equal(res.status, 200, "SSE connects");
  const reader = res.body!.getReader();
  let text = "";
  const decoder = new TextDecoder();
  const done = (async () => {
    try {
      for (;;) {
        const { done: d, value } = await reader.read();
        if (d) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // abort is expected
    }
  })();
  await sleep(ms);
  ctrl.abort();
  try {
    await reader.cancel();
  } catch {
    // ignore
  }
  await done;
  return text;
}

test("private chats belong to their owner only", { timeout: 240_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "crew-dmpriv-"));
  server = spawn(process.execPath, ["src/server.ts"], {
    env: { ...process.env, PORT: String(PORT), PUBLIC_URL: base, AUTH_MODE: "dev", DEMO_MODE: "true", DATA_DIR: dataDir },
    stdio: "ignore",
  });
  for (let i = 0; i < 80 && !(await fetch(`${base}/healthz`).then((r) => r.ok, () => false)); i++) await sleep(200);
  const bob = await session("bob");
  const alice = await session("alice");
  const carol = await session("carol");
  const root = await session("root");

  // 1. Creation: idempotent, same channel id.
  const first = await (await bob.raw("/api/dms", { method: "POST", body: JSON.stringify({ agent: "ops" }) })).json() as any;
  assert.equal(first.created, true, "first DM creation reports created:true");
  const second = await (await bob.raw("/api/dms", { method: "POST", body: JSON.stringify({ agent: "ops" }) })).json() as any;
  assert.equal(second.created, false, "second DM creation reports created:false");
  assert.equal(first.channel.id, second.channel.id, "same channel id both times");
  const C: string = first.channel.id;
  assert.match(C, /^dm-ops-/);

  // 2. Lists: owner sees C, nobody else does (both /api/me and /api/channels).
  const bobMe = await bob.getJson("/api/me");
  assert.ok((bobMe.channels as any[]).some((c) => c.id === C), "C is in owner's /api/me channels");
  for (const [name, s] of [["alice", alice], ["carol", carol], ["root", root]] as const) {
    const me = await s.getJson("/api/me");
    assert.ok(!(me.channels as any[]).some((c) => c.id === C), `${name} /api/me hides C`);
    const all = await (await s.raw("/api/channels")).json() as any;
    assert.ok(!(all.channels as any[]).some((c: any) => c.id === C), `${name} /api/channels hides C`);
  }

  // 3. Messages: owner posts (DM answers without @mention) and reads; others get 404 both ways.
  const uniq3 = `tealdeal-${Date.now()}`;
  const posted = await bob.raw(`/api/channels/${C}/messages`, { method: "POST", body: JSON.stringify({ text: `hello ops ${uniq3}` }) });
  assert.equal(posted.status, 200, "owner can post to own DM");
  const pj = await posted.json() as any;
  assert.deepEqual(pj.dispatchedTo, ["ops"], "DM agent answers every message without @mention");
  const read = await bob.raw(`/api/channels/${C}/messages`);
  assert.equal(read.status, 200, "owner can read own DM messages");
  const msgs = ((await read.json()) as any).messages as any[];
  assert.ok(msgs.some((m) => m.text.includes(uniq3)), "owner reads back the posted text");
  for (const [name, s] of [["alice", alice], ["carol", carol], ["root", root]] as const) {
    assert.equal((await s.raw(`/api/channels/${C}/messages`)).status, 404, `${name} GET messages 404`);
    assert.equal((await s.raw(`/api/channels/${C}/messages`, { method: "POST", body: JSON.stringify({ text: "intrude" }) })).status, 404, `${name} POST messages 404`);
  }

  // 4. Other channel-scoped routes: 404 (refused) for non-owners, not-404 for the owner.
  // /case: DM has no shared case picture, so the owner gets 403 (not 404); others get 404.
  const ownerCase = await bob.raw(`/api/channels/${C}/case`);
  assert.notEqual(ownerCase.status, 404, "owner /case does not 404");
  assert.equal(ownerCase.status, 403, "owner /case is 403 (private chat has no shared case picture)");
  for (const [name, s] of [["alice", alice], ["carol", carol], ["root", root]] as const) {
    assert.equal((await s.raw(`/api/channels/${C}/case`)).status, 404, `${name} /case 404`);
  }
  // /domain-events?channel=C
  const ownerEv = await bob.raw(`/api/domain-events?channel=${C}`);
  assert.equal(ownerEv.status, 200, "owner domain-events 200");
  assert.ok(Array.isArray((await ownerEv.json() as any).events), "owner events is a list");
  for (const [name, s] of [["alice", alice], ["carol", carol], ["root", root]] as const) {
    assert.equal((await s.raw(`/api/domain-events?channel=${C}`)).status, 404, `${name} domain-events 404`);
  }
  // /memtree
  const ownerMem = await bob.raw(`/api/channels/${C}/agents/ops/memtree`);
  assert.equal(ownerMem.status, 200, "owner memtree 200");
  for (const [name, s] of [["alice", alice], ["carol", carol], ["root", root]] as const) {
    assert.equal((await s.raw(`/api/channels/${C}/agents/ops/memtree`)).status, 404, `${name} memtree 404`);
  }
  // POST /stop: owner 200; approver/admin non-owners 404; viewer non-owner refused (403, no operate perm).
  assert.equal((await bob.raw(`/api/channels/${C}/agents/ops/stop`, { method: "POST", body: JSON.stringify({}) })).status, 200, "owner stop 200");
  assert.equal((await alice.raw(`/api/channels/${C}/agents/ops/stop`, { method: "POST", body: JSON.stringify({}) })).status, 404, "alice stop 404");
  assert.equal((await root.raw(`/api/channels/${C}/agents/ops/stop`, { method: "POST", body: JSON.stringify({}) })).status, 404, "root stop 404");
  const carolStop = (await carol.raw(`/api/channels/${C}/agents/ops/stop`, { method: "POST", body: JSON.stringify({}) })).status;
  assert.ok(carolStop === 403 || carolStop === 404, `carol stop refused (got ${carolStop})`);

  // 5. Live stream: owner's SSE carries the DM id + marker, others' carry neither.
  const marker = `quetzalwhistle-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const windowMs = 6000;
  const streams = Promise.all([
    collectStream(bob.cookie, windowMs),
    collectStream(alice.cookie, windowMs),
    collectStream(carol.cookie, windowMs),
    collectStream(root.cookie, windowMs),
  ]);
  await sleep(800); // let all four SSE connections establish
  const live = await bob.raw(`/api/channels/${C}/messages`, { method: "POST", body: JSON.stringify({ text: `stream probe ${marker}` }) });
  assert.equal(live.status, 200, "owner live-stream probe post accepted");
  const [bobSse, aliceSse, carolSse, rootSse] = await streams;
  assert.ok(bobSse.includes(C), "owner stream contains the DM id");
  assert.ok(bobSse.includes(marker), "owner stream contains the marker");
  for (const [name, sse] of [["alice", aliceSse], ["carol", carolSse], ["root", rootSse]] as const) {
    assert.ok(!sse.includes(C), `${name} stream has no DM id`);
    assert.ok(!sse.includes(marker), `${name} stream has no marker`);
  }

  // 6. Presence: carol's /api/me lists no working entry with C.
  const carolMe = await carol.getJson("/api/me");
  for (const p of carolMe.presence as any[]) {
    assert.ok(!(p.working as string[]).includes(C), `presence of ${p.agentId} hides C`);
  }

  // 7. Memory notes: channel-scoped note visible to owner only.
  const memMarker = `tealmemory-${Date.now()}-${Math.floor(Math.random() * 1e6)} this note lives in the private chat`;
  {
    const db = new DatabaseSync(join(dataDir, "workspace.sqlite"));
    db.prepare("INSERT INTO memories (agent_id, scope, text, source, created_at) VALUES (?,?,?,?,?)").run("ops", `channel:${C}`, memMarker, "test", Date.now());
    db.close();
  }
  const bobMem = ((await bob.getJson("/api/memory")).notes as any[]).map((n) => n.text);
  assert.ok(bobMem.some((t) => t.includes(memMarker)), "owner memory shows the DM note");
  for (const [name, s] of [["alice", alice], ["carol", carol], ["root", root]] as const) {
    const notes = ((await s.getJson("/api/memory")).notes as any[]).map((n) => n.text);
    assert.ok(!notes.some((t) => t.includes(memMarker)), `${name} memory hides the DM note`);
  }

  // 8. Approvals: DM approval visible to owner only; decide refused correctly.
  const apMarker = `tealapproval-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const taskId = `t-dmpriv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let approvalId = 0;
  {
    const db = new DatabaseSync(join(dataDir, "workspace.sqlite"));
    const r = db.prepare("INSERT INTO approvals (channel_id, agent_id, task_id, title, detail, status, created_at, requested_by_sub) VALUES (?,?,?,?,?,?,?,?)").run(C, "ops", taskId, apMarker, "{}", "pending", Date.now(), "dev-bob");
    approvalId = Number(r.lastInsertRowid);
    db.close();
  }
  assert.ok(approvalId > 0, "approval row inserted");
  const bobAp = ((await bob.getJson("/api/approvals?status=pending")).approvals as any[]).map((a) => a.title);
  assert.ok(bobAp.some((t) => t.includes(apMarker)), "owner sees the DM approval");
  const aliceAp = ((await alice.getJson("/api/approvals?status=pending")).approvals as any[]).map((a) => a.title);
  assert.ok(!aliceAp.some((t) => t.includes(apMarker)), "approver alice does not see the DM approval");
  assert.equal((await alice.raw(`/api/approvals/${approvalId}/decide`, { method: "POST", body: JSON.stringify({ decision: "approve" }) })).status, 404, "alice decide on DM approval 404");
  assert.equal((await bob.raw(`/api/approvals/${approvalId}/decide`, { method: "POST", body: JSON.stringify({ decision: "approve" }) })).status, 403, "owner bob decide 403 (operator, not approver)");

  // Stash ids for the audit probe below (separate todo test reuses this server + DB).
  (globalThis as any).__dmpriv = { C, dataDir, approvalId, apMarker };
});

test(
  "audit does not leak private approval titles to people who cannot see the chat",
  {
    timeout: 60_000,
  },
  async () => {
    const stash = (globalThis as any).__dmpriv as { C: string; dataDir: string };
    assert.ok(stash?.C, "main test ran first and created a DM");
    const { C, dataDir } = stash;
    void C;
    const alice = await session("alice");
    const root = await session("root");
    // C is owned by bob (operator, cannot approve), so no API caller can both see C and
    // decide an approval in it. Probe the documented leak with real product writes+reads:
    // a DM owned by an approver (alice) whose approval alice decides; root cannot see
    // that DM but reads the audit.
    const created = (await (await alice.raw("/api/dms", { method: "POST", body: JSON.stringify({ agent: "ops" }) })).json()) as any;
    const Ca: string = created.channel.id;
    assert.match(Ca, /^dm-ops-/);
    assert.notEqual(Ca, C, "second DM is a different chat");
    const auditMarker = `tealaudit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const taskId = `t-dmaudit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    let auditApprovalId = 0;
    {
      const db = new DatabaseSync(join(dataDir, "workspace.sqlite"));
      // requested by bob so alice (not the requester) may decide it.
      const r = db.prepare("INSERT INTO approvals (channel_id, agent_id, task_id, title, detail, status, created_at, requested_by_sub) VALUES (?,?,?,?,?,?,?,?)").run(Ca, "ops", taskId, auditMarker, "{}", "pending", Date.now(), "dev-bob");
      auditApprovalId = Number(r.lastInsertRowid);
      db.close();
    }
    const decided = await alice.raw(`/api/approvals/${auditApprovalId}/decide`, { method: "POST", body: JSON.stringify({ decision: "approve", note: "probe" }) });
    assert.equal(decided.status, 200, "approver-owner can decide her own DM approval (real product audit write)");
    const aliceAudit = ((await alice.getJson("/api/audit")).audit as any[]).map((e) => JSON.stringify(e.detail));
    const rootAudit = ((await root.getJson("/api/audit")).audit as any[]).map((e) => JSON.stringify(e.detail));
    // The leak: root cannot see Ca (positive control: 404 on its messages) yet its audit carries the title.
    assert.equal((await root.raw(`/api/channels/${Ca}/messages`)).status, 404, "positive control: root cannot see the private chat");
    assert.ok(aliceAudit.some((d) => d.includes(auditMarker)), "control: the decide wrote an audit entry with the title");
    assert.ok(!rootAudit.some((d) => d.includes(auditMarker)), "root audit hides the private title");
  },
);
