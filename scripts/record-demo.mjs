// Records the whole demo story as one video, with on-screen captions and a visible cursor.
//
//   cd /tmp && npm i playwright-core && cp <repo>/scripts/record-demo.mjs .
//   BASE_URL=http://crew.<BASE_DOMAIN> PW_DAVE=<admin password> OUT=/out node record-demo.mjs
//
// Needs a freshly reset demo (RESET=1 ./deploy.sh) and an admin user (dave). Writes OUT/raw.webm and
// OUT/segments.json (stretches that are just waiting for agents and can be sped up); scripts/make-mp4.sh
// turns them into a compact mp4. The story: a person asks Ops for help, agents hand work to each other and use a
// sandbox, a human approves the change; later a metric breach opens a case and a workflow waits for a decision.
import { chromium } from "playwright-core";
import { readdirSync, writeFileSync, renameSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const OUT = process.env.OUT ?? ".";
const PW = process.env.PW_DAVE;
if (!PW) throw new Error("set PW_DAVE");
const exe = process.env.CHROMIUM ?? readdirSync("/ms-playwright").filter((d) => d.startsWith("chromium-")).map((d) => `/ms-playwright/${d}/chrome-linux/chrome`)[0];

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });

// 1. log in once, without recording, and keep the session
const login = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const lp = await login.newPage();
await lp.goto(BASE + "/");
await lp.fill("#username", "dave"); await lp.fill("#password", PW); await lp.click("#kc-login");
await lp.waitForSelector(".shell", { timeout: 60000 });
const state = await login.storageState();
await login.close();

// 2. record the story
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: "dark", storageState: state, recordVideo: { dir: OUT, size: { width: 1280, height: 720 } } });
await ctx.addInitScript(() => {
	// caption bar + cursor, re-created on every load from sessionStorage
	const css = `
	#cap{pointer-events:none;position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:980px;background:rgba(10,10,14,.88);color:#fff;font:600 21px/1.35 system-ui,sans-serif;padding:12px 22px;border-radius:12px;z-index:99999;text-align:center;border:1px solid #ffffff30}
	#cap small{display:block;font-weight:500;font-size:14px;opacity:.7;margin-top:2px}
	#cur{position:fixed;width:18px;height:18px;border-radius:50%;background:#fff;border:2px solid #111;z-index:100000;pointer-events:none;transform:translate(-50%,-50%);box-shadow:0 0 0 2px #ffffff80}
	#cur.down{transform:translate(-50%,-50%) scale(.6);background:#f5a623}
	`;
	const mount = () => {
		if (document.getElementById("cap")) return;
		const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
		const c = document.createElement("div"); c.id = "cap"; document.body.appendChild(c);
		const cur = document.createElement("div"); cur.id = "cur"; cur.style.left = "-50px"; cur.style.top = "-50px"; document.body.appendChild(cur);
		window.__setCap = (text, fast) => { c.innerHTML = text ? `${text}${fast ? "<small>⏩ sped up while the agents work</small>" : ""}` : ""; c.style.display = text ? "block" : "none"; sessionStorage.setItem("cap", JSON.stringify({ text, fast })); };
		const saved = JSON.parse(sessionStorage.getItem("cap") || "null"); if (saved) window.__setCap(saved.text, saved.fast); else c.style.display = "none";
		document.addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; }, true);
		document.addEventListener("mousedown", () => cur.classList.add("down"), true);
		document.addEventListener("mouseup", () => cur.classList.remove("down"), true);
	};
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
});
const page = await ctx.newPage();
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const segments = [];
const sleep = (ms) => page.waitForTimeout(ms);

const caption = (text, fast = false) => page.evaluate(([t, f]) => window.__setCap?.(t, f), [text, fast]);
/** Runs `fn` while the video shows a "sped up" tag; the interval is later played fast. */
async function fast(text, fn, speed = 6) {
	await caption(text, true);
	const a = now();
	await fn();
	const b = now();
	if (b - a > 2.5) segments.push({ from: +(a + 1).toFixed(2), to: +(b - 0.6).toFixed(2), speed });
	await caption(text, false);
}
async function click(loc, { dwell = 350 } = {}) {
	await loc.scrollIntoViewIfNeeded();
	const box = await loc.boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 28 });
	await sleep(dwell);
	await page.mouse.down(); await sleep(90); await page.mouse.up();
}
const api = async (path) => {
	for (let i = 0; ; i++) {
		try { return await page.evaluate(async (p) => (await (await fetch(p)).json()), path); }
		catch (e) { if (i >= 4) throw e; await sleep(1500); }
	}
};
async function say(text, to = null) {
	await click(page.locator(".composer textarea"));
	if (to) { await page.keyboard.type(`@${to.slice(0, 2)}`, { delay: 120 }); await sleep(500); await page.keyboard.press("Tab"); }
	await page.keyboard.type(text, { delay: 28 });
	await sleep(600);
	await page.keyboard.press("Enter");
	// fail fast if the message did not land in the channel (a lost click would otherwise waste minutes)
	await page.waitForSelector(`.timeline .msg:has-text("${text.trim().slice(0, 18).replace(/"/g, "")}")`, { timeout: 15000 });
}
/** Waits until this agent's latest message is finished (other agents may still be busy or blocked on an approval). */
const agentDone = (channel, agent) => async () => {
	for (let i = 0; i < 300; i++) {
		const { messages } = await api(`/api/channels/${channel}/messages`);
		const ms = messages.filter((m) => m.authorKind === "agent" && m.authorId === agent);
		if (ms.length && ms.at(-1).meta.status === "done") return;
		await sleep(1500);
	}
	throw new Error(`${agent} did not finish in ${channel}`);
};
const APPROVAL = ".card.pending:has(h5:text-is('Approval required'))";

// ---- the story ----------------------------------------------------------------------------------
const PART = process.env.PART ?? "AB";
async function partA() {
await page.goto(BASE + "/#general");
await page.waitForSelector(".shell");
await sleep(800);
await caption("Crew: people and durable agents share channels. Every agent has a visible role and visible limits.");
await sleep(4500);

// Part A: a person asks, agents work, a human approves
await click(page.locator(".side button.item", { hasText: "incidents" }).first());
await caption("A person asks an agent for help in a channel");
await sleep(1500);
await say(" investigate why checkout-api keeps crash-looping and get it fixed.", "ops");
await fast("Ops finds the root cause and hands the fix to Developer, who validates it in a sandbox pod and asks Reviewer", () => Promise.race([agentDone("incidents", "reviewer")(), page.waitForSelector(APPROVAL, { timeout: 280000 }).catch(() => {})]));
await caption("Reviewer approves the change");
await sleep(1500);
await page.waitForSelector(APPROVAL, { timeout: 30000 }).catch(() => {});
if ((await page.locator(APPROVAL).count()) === 0) {
	await caption("A person tells Ops to apply it");
// the branch name is the Developer's choice: read it from the conversation instead of assuming it
const { messages: seen } = await api("/api/channels/incidents/messages");
const branch = seen.map((m) => /agent\/[\w.-]+/.exec(m.text)?.[0]).find(Boolean) ?? "agent/fix-checkout-pool-size";
	await say(` the reviewer approved branch ${branch}. Apply demo-apps/checkout-config.json from that branch with k8s_apply_from_repo and restart checkout-api.`, "ops");
}
await fast("Changing a live system needs a human approval", async () => { await page.waitForSelector(APPROVAL, { timeout: 300000 }); });
await caption("The approval card shows exactly what will change. Only an approver can decide");
const card = page.locator(APPROVAL).last();
await card.scrollIntoViewIfNeeded();
await sleep(5500);
await click(card.locator("input"));
await page.keyboard.type("reviewed, go ahead", { delay: 45 });
await sleep(500);
await click(card.locator(".btn.approve"));
await fast("Approved. Ops applies the change, restarts the service and verifies", async () => {
	await page.waitForSelector(".card.approved", { timeout: 60000 });
	await sleep(1500);
	await agentDone("incidents", "ops")();
});
await caption("The service is healthy again. Every step, the approval and who decided are in the channel");
await sleep(5000);

}

async function partB() {
if (PART === "B") {
	await page.goto(BASE + "/#incidents");
	await page.waitForSelector(".shell");
	await sleep(800);
}
// Part B: an alert opens a case, a workflow runs
await caption("Later: a metric crosses a threshold…");
const inject = page.locator("button:has-text('Inject anomaly')");
await sleep(1500);
await click(inject);
await fast("The watcher opens a ticket and a case channel by itself", async () => { await page.waitForSelector(".side button.item:has-text('OPS-')", { timeout: 120000 }); });
await click(page.locator(".side button.item:has-text('OPS-')").first());
await sleep(800);
await caption("The case channel carries the ticket and everything related to it");
await sleep(4500);
await fast("A Temporal workflow starts: Insight diagnoses, Ops proposes a plan", async () => { await page.waitForSelector(".card.pending:has(h5:text-matches('Workflow'))", { timeout: 300000 }); });
await caption("The workflow pauses for a person. It survives restarts and can wait as long as it must");
const wf = page.locator(".card.pending:has(h5:text-matches('Workflow'))").last();
await wf.scrollIntoViewIfNeeded();
await sleep(5500);
await click(wf.locator("input"));
await page.keyboard.type("go ahead, report only, change nothing", { delay: 45 });
await sleep(500);
await click(wf.locator(".btn.approve"));
const labels = { execute: "Ops carries out the plan", monitor: "Monitoring: a durable timer, not a sleeping thread", verify: "Insight verifies with a chart" };
let last = "";
await fast("Continue → execute → monitor → verify → close", async () => {
	for (let i = 0; i < 300; i++) {
		const { workflows } = await api("/api/workflows");
		const w = workflows.find((x) => x.id.startsWith("incident-ops-"));
		if (w && w.step && w.step !== last && labels[w.step]) { last = w.step; await caption(labels[w.step], true); }
		if (w && w.status !== "RUNNING") return;
		await sleep(1500);
	}
}, 5);
await caption("Case closed by the workflow. The whole story stays in the channel: steps, charts, approvals");
await sleep(6500);
await caption("");
await sleep(500);

}

let failure;
try {
	if (PART.includes("A")) await partA();
	if (PART.includes("B")) await partB();
} catch (e) {
	failure = e;
} finally {
	await caption("");
	const videoPath = await page.video().path();
	await ctx.close();
	renameSync(videoPath, `${OUT}/raw-${PART}.webm`);
	writeFileSync(`${OUT}/segments-${PART}.json`, JSON.stringify({ duration: +now().toFixed(2), segments }, null, 1));
	console.log(`recorded part ${PART}: ${now().toFixed(0)} s; ${segments.length} speed-up segments${failure ? " (stopped early: " + String(failure.message).split("\n")[0] + ")" : ""}`);
	await browser.close();
	if (failure) process.exit(1);
}
