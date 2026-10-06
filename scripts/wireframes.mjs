// Regenerates the monochrome wireframe screenshots in docs/img from a running deployment.
//
//   cd /tmp && npm i playwright-core && cp <repo>/scripts/wireframes.mjs .
//   BASE_URL=http://crew.<BASE_DOMAIN> PW_ALICE=... PW_BOB=... PW_DAVE=... OUT=<repo>/docs/img \
//     CHROMIUM=/path/to/chrome node wireframes.mjs
//
// (The Playwright container image works well: mcr.microsoft.com/playwright, with --network=host.)
// It drives the real UI and injects a stylesheet that removes colour, shadows and animation, so what you
// see is the structure of the product, not its theme. Passwords come from ./show-credentials.sh.
import { chromium } from "playwright-core";
import { readdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const OUT = process.env.OUT ?? "docs/img";
const exe = process.env.CHROMIUM ?? (() => {
	try { return readdirSync("/ms-playwright").filter((d) => d.startsWith("chromium-")).map((d) => `/ms-playwright/${d}/chrome-linux/chrome`)[0]; } catch { return undefined; }
})();

const WIREFRAME = `
:root, :root[data-theme] { --accent:#111; --bg:#fff; --panel:#fff; --panel-2:#f2f2f2; --line:#222; --text:#111; --muted:#666; --ok:#111; --warn:#111; --bad:#111; color-scheme: light !important; }
html { filter: grayscale(1) contrast(1.05); }
*, *::before, *::after { box-shadow:none !important; text-shadow:none !important; animation:none !important; transition:none !important; }
body { background:#fff !important; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif !important; }
.side, .ctx { background:#fafafa !important; border-color:#222 !important; }
.header, .composer .box, .card, .agentcard, .chart, .ui-card, .sbi, .activity, .apitem, .prev, .mtview, .banner { background:#fff !important; border:1.5px solid #222 !important; border-radius:4px !important; }
.header { border-width:0 0 1.5px 0 !important; border-radius:0 !important; } .banner { border-width:0 0 1.5px 0 !important; border-radius:0 !important; }
.avatar, .mark { background:#fff !important; color:#111 !important; border:1.5px solid #111 !important; border-radius:4px !important; }
.avatar.human { border-radius:50% !important; }
.dot { background:#fff !important; border:1.5px solid #111 !important; } .dot.working, .dot.waiting_approval { background:#111 !important; }
.item.active { background:#e8e8e8 !important; outline:1.5px solid #111; }
.btn, .send, .linkbtn.open { background:#fff !important; color:#111 !important; border:1.5px solid #111 !important; border-radius:4px !important; }
.btn.approve { background:#111 !important; color:#fff !important; }
.chip, .tkey, .pill { background:#fff !important; color:#111 !important; border:1.2px solid #111 !important; border-radius:4px !important; }
.badge { background:#111 !important; color:#fff !important; }
.mention { background:#eee !important; color:#111 !important; font-weight:700; border-radius:3px; }
.card.pending { border-style:dashed !important; border-width:2px !important; } .card.approved, .card.rejected { border-style:solid !important; }
.sbdot { background:#fff !important; color:#111 !important; border:1.5px solid #111 !important; } .sbi.bad .sbdot { background:#111 !important; color:#fff !important; }
.chart svg path[stroke]:not([stroke="none"]) { stroke:#111 !important; stroke-width:2 !important; }
.chart svg path[fill]:not([fill="none"]) { fill:#9a9a9a !important; }
.chart svg rect { fill:#777 !important; } .chart svg circle { fill:#111 !important; } .legend i { background:#111 !important; }
.ui-big, .ui-text, .chip, .st-running, .st-done, .st-error, .unit, .verdict { color:#111 !important; }
.integ .sw { background:#ccc !important; } .integ input:checked + .sw { background:#111 !important; }
.header .pill, .toast { display:none !important; }
`;

const SCENES = [
	{ file: "01-incident-approval.png", user: "bob", channel: "incidents", note: "agents investigate, hand over, and ask for approval" },
	{ file: "02-approver-view.png", user: "alice", channel: "incidents", note: "an approver sees Approve / Reject; others only see that it is waiting" },
	{ file: "03-insights-view.png", user: "bob", channel: "insights", note: "agents answer with generated views and charts" },
	{ file: "04-case-and-workflow.png", user: "alice", channel: "CASE", note: "an alert opens a case channel; a workflow waits for a person" },
	{ file: "05-private-chat.png", user: "bob", channel: "DM", note: "a private chat: only its owner can see it" },
];

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const sessions = {};
async function page(user) {
	if (sessions[user]) return sessions[user];
	const pw = process.env[`PW_${user.toUpperCase()}`];
	if (!pw) throw new Error(`set PW_${user.toUpperCase()}`);
	const p = await (await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: "light" })).newPage();
	await p.goto(BASE + "/");
	await p.fill("#username", user); await p.fill("#password", pw); await p.click("#kc-login");
	await p.waitForSelector(".shell", { timeout: 60000 });
	sessions[user] = p;
	return p;
}

for (const s of SCENES) {
	const p = await page(s.user);
	let channel = s.channel;
	if (channel === "CASE") channel = (await p.evaluate(async () => (await (await fetch("/api/channels")).json()).channels.find((c) => c.kind === "issue")?.id));
	if (channel === "DM") channel = (await p.evaluate(async () => (await (await fetch("/api/channels")).json()).channels.find((c) => c.kind === "dm")?.id));
	if (!channel) { console.log("skip (no such channel):", s.file); continue; }
	await p.goto(`${BASE}/#${channel}`); await p.reload();
	await p.waitForSelector(".timeline .msg, .timeline .notice, .timeline .card", { timeout: 30000 });
	await p.addStyleTag({ content: WIREFRAME });
	await p.waitForTimeout(1500);
	await p.screenshot({ path: `${OUT}/${s.file}` });
	console.log("wrote", s.file, "-", s.note);
}
await browser.close();
