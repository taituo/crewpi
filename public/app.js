import { html, render, useState, useEffect, useRef, useMemo } from "/vendor/preact.js";

const api = async (path, opts = {}) => {
	const res = await fetch(path, {
		method: opts.body ? "POST" : "GET",
		headers: { "content-type": "application/json", "x-requested-with": "crew" },
		body: opts.body ? JSON.stringify(opts.body) : undefined,
	});
	if (res.status === 401) return (location.href = "/auth/login");
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || res.statusText);
	return data;
};

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const initials = (n) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const time = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Small, safe markdown: everything is escaped first, then fences, code, bold and mentions are added back. */
function md(src, agentIds) {
	const parts = esc(src).split(/```(?:\w*)\n?/);
	return parts
		.map((p, i) => {
			if (i % 2) {
				const lines = p.replace(/\n$/, "").split("\n").map((l) => (/^\+(?!\+)/.test(l) ? `<span class="add">${l}</span>` : /^-(?!-)/.test(l) ? `<span class="del">${l}</span>` : l));
				return `<pre>${lines.join("\n")}</pre>`;
			}
			return p
				.replace(/`([^`\n]+)`/g, "<code>$1</code>")
				.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
				.replace(/@([a-zA-Z][\w-]*)/g, (m, id) => (agentIds.has(id.toLowerCase()) ? `<span class="mention">${m}</span>` : m));
		})
		.join("");
}


const PALETTE = ["#6d5efc", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899"];
const fmtX = (x, timeAxis) => (timeAxis ? new Date(x).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : String(x));
const fmtY = (v) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "k" : Number.isInteger(v) ? String(v) : v.toFixed(1));

function Chart({ c }) {
	const [hover, setHover] = useState(null);
	const W = 640, H = 230, L = 46, R = 14, T = 12, B = 26;
	const first = c.series[0]?.points || [];
	if (!first.length) return html`<div class="card">${c.title}: no data</div>`;
	const timeAxis = first.every((p) => typeof p.x === "number");
	const cats = timeAxis ? null : [...new Set(c.series.flatMap((s) => s.points.map((p) => String(p.x))))];
	const xs = c.series.flatMap((s) => s.points.map((p) => p.x));
	const xmin = timeAxis ? Math.min(...xs) : 0, xmax = timeAxis ? Math.max(...xs) : cats.length;
	const bar = c.type === "bar";
	const xp = (x) => {
		if (timeAxis) return L + ((x - xmin) / (xmax - xmin || 1)) * (W - L - R);
		return L + ((cats.indexOf(String(x)) + 0.5) / cats.length) * (W - L - R);
	};
	const ys = c.series.flatMap((s) => s.points.map((p) => p.y));
	const ymin = bar || c.type === "area" ? Math.min(0, ...ys) : Math.min(...ys), yhi = Math.max(...ys);
	const ymax = yhi + (yhi - ymin || 1) * 0.08;
	const yp = (y) => T + (1 - (y - ymin) / (ymax - ymin || 1)) * (H - T - B);
	const ticks = Array.from({ length: 5 }, (_, i) => ymin + ((ymax - ymin) * i) / 4);
	const xTicks = timeAxis ? Array.from({ length: 5 }, (_, i) => xmin + ((xmax - xmin) * i) / 4) : cats.filter((_, i) => cats.length <= 8 || i % Math.ceil(cats.length / 8) === 0);
	const band = (W - L - R) / (timeAxis ? first.length : cats.length);
	const bw = Math.max(2, (band * 0.7) / c.series.length);
	const onMove = (e) => {
		const r = e.currentTarget.getBoundingClientRect();
		const px = ((e.clientX - r.left) / r.width) * W;
		let best = 0, bd = 1e9;
		first.forEach((p, i) => { const d = Math.abs(xp(p.x) - px); if (d < bd) { bd = d; best = i; } });
		setHover(best);
	};
	const hp = hover != null ? first[hover] : null;
	return html`<div class="chart">
		<div class="chart-title">${c.title}${c.unit ? html` <span class="unit">(${c.unit})</span>` : ""}</div>
		<svg viewBox=${`0 0 ${W} ${H}`} onMouseMove=${onMove} onMouseLeave=${() => setHover(null)}>
			${ticks.map((t) => html`<g><line x1=${L} x2=${W - R} y1=${yp(t)} y2=${yp(t)} class="grid" /><text x=${L - 6} y=${yp(t) + 4} text-anchor="end" class="axis">${fmtY(t)}</text></g>`)}
			${xTicks.map((t, i) => html`<text x=${xp(t)} y=${H - 8} text-anchor=${timeAxis && i === xTicks.length - 1 ? "end" : "middle"} class="axis">${fmtX(t, timeAxis)}</text>`)}
			${c.series.map((s, si) => {
				const col = PALETTE[si % PALETTE.length];
				if (bar) return s.points.map((p) => html`<rect x=${xp(p.x) - (bw * c.series.length) / 2 + si * bw} y=${yp(Math.max(p.y, 0))} width=${bw - 1} height=${Math.abs(yp(p.y) - yp(0))} fill=${col} rx="1.5" />`);
				const d = s.points.map((p, i) => `${i ? "L" : "M"}${xp(p.x).toFixed(1)},${yp(p.y).toFixed(1)}`).join("");
				return html`<g>${c.type === "area" && html`<path d=${`${d}L${xp(s.points[s.points.length - 1].x)},${yp(Math.max(ymin, 0))}L${xp(s.points[0].x)},${yp(Math.max(ymin, 0))}Z`} fill=${col} opacity="0.16" />`}<path d=${d} fill="none" stroke=${col} stroke-width="2" stroke-linejoin="round" /></g>`;
			})}
			${hp && html`<line x1=${xp(hp.x)} x2=${xp(hp.x)} y1=${T} y2=${H - B} class="cursor-line" />`}
			${hp && c.series.map((s, si) => s.points[hover] && !bar && html`<circle cx=${xp(s.points[hover].x)} cy=${yp(s.points[hover].y)} r="3.5" fill=${PALETTE[si % PALETTE.length]} />`)}
		</svg>
		<div class="legend">${c.series.map((s, si) => html`<span><i style=${{ background: PALETTE[si % PALETTE.length] }}></i>${s.name}${hp && s.points[hover] ? html`: <b>${fmtY(s.points[hover].y)}${c.unit ? " " + c.unit : ""}</b>` : ""}</span>`)}${hp && html`<span class="when">${fmtX(hp.x, timeAxis)}</span>`}</div>
	</div>`;
}


const TONE = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)", muted: "var(--muted)", accent: "var(--accent)" };
const tcol = (t) => (t ? TONE[t] : undefined);
const SB = { ok: "✓", warn: "!", bad: "✕", unknown: "?" };

/** Renders a validated json-render-style spec using only these components. */
function UiNode({ spec, id, onAction }) {
	const el = spec.elements[id];
	if (!el) return null;
	const p = el.props || {};
	const kids = (el.children || []).map((c) => html`<${UiNode} key=${c} spec=${spec} id=${c} onAction=${onAction} />`);
	switch (el.type) {
		case "Stack": return html`<div class=${"ui-stack " + (p.direction === "row" ? "row" : "")}>${kids}</div>`;
		case "Card": return html`<div class="ui-card">${p.title && html`<div class="ui-title">${p.title}</div>`}${p.subtitle && html`<div class="ui-sub">${p.subtitle}</div>`}${kids}</div>`;
		case "Text": return html`<div class="ui-text" style=${{ color: tcol(p.tone), fontWeight: p.bold ? 650 : 400 }}>${p.text}</div>`;
		case "Badge": return html`<span class="chip" style=${{ color: tcol(p.tone), borderColor: tcol(p.tone) }}>${p.text}</span>`;
		case "Stat": return html`<div class="ui-stat"><div class="ui-sub">${p.label}</div><div class="ui-big" style=${{ color: tcol(p.tone) }}>${p.value}${p.unit && html`<span class="ui-unit">${p.unit}</span>`}${p.trend && html`<span class="ui-trend">${{ up: "▲", down: "▼", flat: "■" }[p.trend]}</span>`}</div></div>`;
		case "KeyValue": return html`<dl class="kv ui-kv">${p.items.map((i) => html`<dt>${i.key}</dt><dd>${i.value}</dd>`)}</dl>`;
		case "Progress": return html`<div class="ui-progress">${p.label && html`<div class="ui-sub">${p.label} · ${p.value}/${p.max}</div>`}<div class="bar"><i style=${{ width: Math.max(0, Math.min(100, (p.value / (p.max || 100)) * 100)) + "%", background: tcol(p.tone) || "var(--accent)" }}></i></div></div>`;
		case "StatusBoard": return html`<div class="ui-sb">${p.items.map((i) => html`<div class=${"sbi " + i.status}><span class="sbdot">${SB[i.status]}</span><div><b>${i.name}</b>${i.detail && html`<div class="ui-sub">${i.detail}</div>`}</div></div>`)}</div>`;
		case "Timeline": return html`<div class="ui-tl">${p.events.map((e) => html`<div class="tle"><i style=${{ background: tcol(e.tone) || "var(--accent)" }}></i><div><span class="ui-sub">${e.time}</span> <b>${e.title}</b>${e.detail && html`<div class="ui-sub">${e.detail}</div>`}</div></div>`)}</div>`;
		case "Table": return html`<${DataTable} t=${{ title: "", columns: p.columns, rows: p.rows }} />`;
		case "Chart": return html`<${Chart} c=${{ kind: "chart", title: p.title || "", type: p.type, unit: p.unit, series: p.series }} />`;
		case "Button": return html`<button class="btn ui-btn" onClick=${() => onAction(p.action)}>${p.label}</button>`;
		default: return null;
	}
}
function UiView({ spec, onAction }) {
	return html`<div class="chart ui-root"><${UiNode} spec=${spec} id=${spec.root} onAction=${onAction} /></div>`;
}

function DataTable({ t }) {
	return html`<div class="chart"><div class="chart-title">${t.title}</div>
		<div class="tablewrap"><table><thead><tr>${t.columns.map((c) => html`<th>${c}</th>`)}</tr></thead>
		<tbody>${t.rows.map((r) => html`<tr>${r.map((v) => html`<td>${v}</td>`)}</tr>`)}</tbody></table></div></div>`;
}

function Avatar({ agent, name, human }) {
	return html`<div class=${"avatar" + (human ? " human" : "")} style=${{ background: human ? "#475069" : agent?.color || "#475069" }}>${initials(name)}</div>`;
}

function Activity({ items }) {
	if (!items?.length) return null;
	const running = items.filter((a) => a.status === "running").length;
	return html`<details class="activity" open=${running > 0}>
		<summary>${running ? `Working… ${items.length} step${items.length > 1 ? "s" : ""}` : `${items.length} step${items.length > 1 ? "s" : ""}`}</summary>
		${items.map(
			(a) => html`<div class="act" key=${a.id}>
				<div class="row">
					<span class=${"st-" + a.status}>${a.status === "running" ? "●" : a.status === "done" ? "✓" : "✕"}</span>
					<span class="name">${a.name}</span><span class="args">${a.args}</span>
				</div>
				${a.preview && html`<details><summary style="cursor:pointer;color:var(--muted);font-size:12px">result</summary><pre>${a.preview}</pre></details>`}
			</div>`,
		)}
	</details>`;
}

function ApprovalCard({ m, me, onDecide }) {
	const d = m.meta.detail || {};
	const status = m.meta.status;
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const decide = async (decision) => {
		setBusy(true);
		try { await onDecide(m.meta.approvalId, decision, note); } finally { setBusy(false); }
	};
	return html`<div class="msg"><${Avatar} name=${m.authorName} agent=${me.agentsById[m.authorId]} />
		<div class="body">
			<div class="meta"><b>${m.authorName}</b><span class="role">agent</span><time>${time(m.createdAt)}</time></div>
			<div class=${"card " + status}>
				<h5>Approval required</h5>
				<div class="title">${m.text}</div>
				<dl class="kv">
					${d.target && html`<dt>Target</dt><dd>${d.target}</dd>`}
					${d.ref && html`<dt>Source</dt><dd>${d.ref} · ${d.path}</dd>`}
					${d.restart && html`<dt>Then</dt><dd>restart ${d.restart}</dd>`}
					${d.reason && html`<dt>Reason</dt><dd>${d.reason}</dd>`}
					${d.changes?.length && html`<dt>Changes</dt><dd class="change">${d.changes.map((c) => html`<div>${c.key}: <span class="from">${String(c.from)}</span> → <span class="to">${String(c.to)}</span></div>`)}</dd>`}
				</dl>
				${status === "pending"
					? me.perms.approve
						? html`<input placeholder="Note (optional)" value=${note} onInput=${(e) => setNote(e.target.value)} style="width:100%;margin-bottom:8px;background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:6px 8px;color:var(--text)" />
							<div class="actions"><button class="btn approve" disabled=${busy} onClick=${() => decide("approve")}>Approve</button><button class="btn reject" disabled=${busy} onClick=${() => decide("reject")}>Reject</button></div>`
						: html`<div class="needs-approver">Waiting for an <b>approver</b>. You are signed in as <b>${me.perms.admin ? "admin" : me.perms.operate ? "operator" : "viewer"}</b>, which cannot decide. Ask an approver (e.g. alice) to open this channel.</div>`
					: html`<div class=${"verdict " + status}>${status === "approved" ? "Approved" : "Rejected"} by ${m.meta.decidedBy}${m.meta.note ? ` — ${m.meta.note}` : ""}</div>`}
			</div>
		</div></div>`;
}

function CaseCard({ m }) {
	const t = m.meta.ticket, r = m.meta.related || {};
	const groups = [["Pull requests", r.prs], ["CI runs", r.runs], ["Workflows", r.workflows], ["Gerrit", r.changes], ["Dashboards", r.dashboards]].filter(([, l]) => l?.length);
	const src = { alert: "Opened automatically by an alert", agent: "Opened by an agent", manual: "Opened by a person" }[m.meta.source] || "";
	return html`<div class="card case">
		<h5>Case${src ? ` · ${src}` : ""}</h5>
		<div class="title">${t ? html`<span class="tkey">${t.key}</span> ` : ""}${m.text}</div>
		${t && html`<div class="chips"><span class="chip">${t.status}</span><span class=${"chip prio-" + t.priority.toLowerCase()}>${t.priority}</span><span class="chip">${t.assignee}</span></div>`}
		${t?.description && html`<div class="text" style="margin:6px 0">${t.description}</div>`}
		${groups.map(([name, list]) => html`<div class="rel"><b>${name}</b>${list.map((x) => html`<div class="relrow"><code>${x.label}</code> <span>${x.title || ""}</span>${x.state && html`<span class=${"chip st-" + String(x.state).toLowerCase().replace(/[^a-z]/g, "")}>${x.state}${x.checks ? " · checks " + x.checks : ""}</span>`}</div>`)}</div>`)}
	</div>`;
}

function WorkflowCard({ m, me, wfs, onDecision }) {
	const wf = wfs[m.meta.workflowId];
	const waiting = !wf || wf.step === "await-human";
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const go = async (d) => { setBusy(true); try { await onDecision(m.meta.workflowId, d, note); } finally { setBusy(false); } };
	return html`<div class="msg" style="max-width:760px"><div class=${"card " + (waiting ? "pending" : "approved")}>
		<h5>Workflow · ${m.meta.workflowId}</h5>
		<div class="title">${waiting ? "Waiting for a decision" : wf?.status === "RUNNING" ? `Decision made, workflow is at step: ${wf.step || "…"}` : `Workflow ${String(wf?.status || "").toLowerCase()}`}</div>
		<div class="text" style="margin-bottom:8px"><b>Proposed next step</b><br />${m.meta.plan}</div>
		${waiting && (me.perms.approve
			? html`<input placeholder="Note (optional)" value=${note} onInput=${(e) => setNote(e.target.value)} style="width:100%;margin-bottom:8px;background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:6px 8px;color:var(--text)" />
				<div class="actions"><button class="btn approve" disabled=${busy} onClick=${() => go("continue")}>Continue</button><button class="btn" disabled=${busy} onClick=${() => go("close")}>Close case, no action</button><button class="btn reject" disabled=${busy} onClick=${() => go("abort")}>Abort</button></div>`
			: html`<div class="needs-approver">Waiting for an <b>approver</b> to decide. The workflow is paused (and survives restarts) until then.</div>`)}
	</div></div>`;
}

function Message({ m, me, agentIds, onDecide, onOpen, onAction, wfs, onDecision }) {
	const kind = m.meta.kind;
	if (kind === "case") return html`<div class="msg" style="max-width:760px"><${CaseCard} m=${m} /></div>`;
	if (kind === "workflow") return html`<${WorkflowCard} m=${m} me=${me} wfs=${wfs} onDecision=${onDecision} />`;
	if (m.authorKind === "system" && kind === "notice") return html`<div class="notice">${m.text}${m.meta.link ? html` <button class="linkbtn open" onClick=${() => onOpen(m.meta.link)}>Open #${m.meta.link} →</button>` : ""}</div>`;
	if (kind === "approval") return html`<${ApprovalCard} m=${m} me=${me} onDecide=${onDecide} />`;
	if (kind === "delegation")
		return html`<div class="deleg"><div class="head"><b>${m.authorName}</b> asked <b>@${m.meta.to}</b></div><div class="text" dangerouslySetInnerHTML=${{ __html: md(m.text, agentIds) }}></div></div>`;
	const agent = me.agentsById[m.authorId];
	const human = m.authorKind === "human";
	const working = m.meta.status === "working";
	const current = [...(m.meta.activity || [])].reverse().find((a) => a.status === "running");
	return html`<div class="msg"><${Avatar} agent=${agent} name=${m.authorName} human=${human} />
		<div class="body">
			<div class="meta"><b>${m.authorName}</b>${!human && html`<span class="role">agent</span>`}<time>${time(m.createdAt)}</time></div>
			${!human && html`<${Activity} items=${m.meta.activity} />`}
			${working && !m.text && html`<div class="status"><span class="dot working"></span> ${m.authorName} is working${current ? html` — running <code>${current.name}</code>` : ""}…</div>`}
			${(m.meta.attachments || []).length > 0 && html`<div class="atts">${m.meta.attachments.map((a) => html`<a href=${"/api/files/" + a.id} target="_blank" rel="noopener"><img class="att" src=${"/api/files/" + a.id} alt=${a.name} loading="lazy" /></a>`)}</div>`}
			${(m.meta.artifacts || []).map((a) => (a.kind === "chart" ? html`<${Chart} c=${a} />` : a.kind === "ui" ? html`<${UiView} spec=${a.spec} onAction=${onAction} />` : html`<${DataTable} t=${a} />`))}
			${m.text && html`<div class=${"text" + (working ? " cursor" : "")} dangerouslySetInnerHTML=${{ __html: md(m.text, agentIds) }}></div>`}
		</div></div>`;
}

function Composer({ channel, agents, canPost, onSend }) {
	const [text, setText] = useState("");
	const [sel, setSel] = useState(0);
	const [files, setFiles] = useState([]);
	const [busy, setBusy] = useState(0);
	const [err, setErr] = useState("");
	const ta = useRef();
	const picker = useRef();
	const m = /(?:^|\s)@([\w-]*)$/.exec(text);
	const options = m ? agents.filter((a) => a.id.startsWith(m[1].toLowerCase())) : [];
	const pick = (a) => { setText(text.replace(/@[\w-]*$/, `@${a.id} `)); setSel(0); ta.current?.focus(); };
	const upload = async (list) => {
		for (const f of [...list].filter((x) => x.type.startsWith("image/")).slice(0, 4 - files.length)) {
			setBusy((n) => n + 1); setErr("");
			try {
				const r = await fetch(`/api/channels/${channel.id}/upload?name=${encodeURIComponent(f.name || "pasted-image.png")}`, { method: "POST", headers: { "x-requested-with": "crew", "content-type": f.type }, body: f });
				const d = await r.json();
				if (!r.ok) throw new Error(d.error || r.statusText);
				setFiles((cur) => [...cur, d.attachment]);
			} catch (e) { setErr(e.message); }
			setBusy((n) => n - 1);
		}
	};
	const canSend = canPost && busy === 0 && (text.trim() || files.length);
	const send = () => { if (canSend) { onSend(text.trim(), files.map((f) => f.id)); setText(""); setFiles([]); } };
	useEffect(() => { const t = ta.current; if (t) { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; } }, [text]);
	useEffect(() => { setFiles([]); setErr(""); }, [channel.id]);
	return html`<div class="composer" onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { e.preventDefault(); if (canPost) upload(e.dataTransfer.files); }}>
		${options.length > 0 && html`<div class="suggest">${options.map((a, i) => html`<button class=${i === sel ? "sel" : ""} onMouseDown=${(e) => { e.preventDefault(); pick(a); }}><${Avatar} agent=${a} name=${a.name} /> <span><b>@${a.id}</b> <span style="color:var(--muted)">${a.title}</span></span></button>`)}</div>`}
		${(files.length > 0 || busy > 0) && html`<div class="previews">${files.map((f) => html`<div class="prev"><img src=${"/api/files/" + f.id} alt=${f.name} /><button title="Remove" onClick=${() => setFiles((c) => c.filter((x) => x.id !== f.id))}>×</button></div>`)}${busy > 0 && html`<div class="prev loading">…</div>`}</div>`}
		<div class="box">
			<button class="attach" title="Attach an image (or paste / drop one)" disabled=${!canPost} onClick=${() => picker.current.click()}>📎</button>
			<input ref=${picker} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange=${(e) => { upload(e.target.files); e.target.value = ""; }} />
			<textarea ref=${ta} rows="1" disabled=${!canPost} value=${text}
				placeholder=${canPost ? (channel.kind === "dm" ? `Message ${channel.name} privately` : `Message #${channel.name} — mention an agent with @`) : "Your role is view-only"}
				onInput=${(e) => setText(e.target.value)}
				onPaste=${(e) => { const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/")); if (imgs.length) { e.preventDefault(); upload(imgs); } }}
				onKeyDown=${(e) => {
					if (options.length && (e.key === "Tab" || e.key === "Enter")) { e.preventDefault(); return pick(options[sel % options.length]); }
					if (options.length && e.key === "ArrowDown") { e.preventDefault(); return setSel((sel + 1) % options.length); }
					if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
				}} />
			<button class="send" disabled=${!canSend} onClick=${send}>Send</button>
		</div>
		<div class="hint">${err ? html`<span style="color:var(--bad)">${err}</span>` : channel.kind === "dm" ? `Only you can see this chat. ${channel.name} answers every message.` : "Agents only act when mentioned. Shift+Enter for a new line. Paste or drop images to share them."}</div>
	</div>`;
}

function MemTree({ channelId, agentId, canOperate, onFlash }) {
	const [info, setInfo] = useState(null);
	const [busy, setBusy] = useState(false);
	const load = () => api(`/api/channels/${channelId}/agents/${agentId}/memtree`).then(setInfo).catch(() => {});
	const compact = async () => {
		setBusy(true);
		try {
			const r = await api(`/api/channels/${channelId}/agents/${agentId}/compact`, { body: {} });
			onFlash(r.compacted ? "Compacted: the agent's context now starts with the compressed memory view" : "Nothing to compact yet (the history is shorter than the kept tail)");
			load();
		} catch (e) { onFlash(e.message); }
		setBusy(false);
	};
	return html`<details class="mt" onToggle=${(e) => e.target.open && load()}>
		<summary>Memory tree</summary>
		${info && html`<div class="ui-sub">${info.leaves} messages · ${info.nodes} summaries (${info.llmNodes} by model, ${info.pending} pending) · view ${info.view.length} lines, ≤ ${info.viewBytes} B</div>
			<div class="mtview">${info.view.slice(-40).map((l) => html`<div class="mtl"><code>${l.id}</code> <span class="ui-sub">${l.msgs > 1 ? l.msgs + " msgs" : l.role}</span> ${l.text}</div>`)}</div>`}
		${canOperate && html`<button class="btn small" disabled=${busy} onClick=${compact}>${busy ? "Compacting…" : "Compact now"}</button>`}
	</details>`;
}

function AgentCard({ a, presence, channelId, canOperate, onStop, onFlash }) {
	const p = presence[a.id] || { status: "idle" };
	const label = { idle: "Idle", working: "Working", waiting_approval: "Waiting for approval" }[p.status];
	return html`<details class="agentcard">
		<summary><div class="top"><${Avatar} agent=${a} name=${a.name} /><div><b>${a.name}</b><span>${a.title} · <span class=${"dot " + p.status} style="display:inline-block"></span> ${label}</span></div></div></summary>
		<div class="model">${p.model || ""}</div>
		<ul>${a.can.map((c) => html`<li class="can">${c}</li>`)}${a.cannot.map((c) => html`<li class="cannot">${c}</li>`)}</ul>
		<${MemTree} channelId=${channelId} agentId=${a.id} canOperate=${canOperate} onFlash=${onFlash} />
		${canOperate && p.working?.includes(channelId) && html`<button class="btn stopbtn" onClick=${() => onStop(a.id)}>Stop</button>`}
	</details>`;
}

function App() {
	const [me, setMe] = useState(null);
	const [channelId, setChannelId] = useState(location.hash.slice(1) || "general");
	const [messages, setMessages] = useState([]);
	const [presence, setPresence] = useState({});
	const [approvals, setApprovals] = useState([]);
	const [integrations, setIntegrations] = useState([]);
	const [channels, setChannels] = useState([]);
	const [notes, setNotes] = useState([]);
	const [budget, setBudget] = useState(null);
	const [sandboxes, setSandboxes] = useState([]);
	const [wf, setWf] = useState({ available: false, workflows: [] });
	const [newCase, setNewCase] = useState(null);
	const [showArchived, setShowArchived] = useState(false);
	const [toast, setToast] = useState("");
	const tl = useRef();
	const stick = useRef(true);
	const channelRef = useRef(channelId);
	channelRef.current = channelId;

	const flash = (t) => { setToast(t); setTimeout(() => setToast(""), 3500); };

	const loadMessages = (id) => api(`/api/channels/${id}/messages`).then((d) => channelRef.current === id && setMessages(d.messages));
	const loadApprovals = () => api("/api/approvals?status=pending").then((d) => setApprovals(d.approvals));

	useEffect(() => {
		api("/api/me").then((d) => {
			d.agentsById = Object.fromEntries(d.agents.map((a) => [a.id, a]));
			setMe(d);
			setPresence(Object.fromEntries(d.presence.map((p) => [p.agentId, p])));
			setIntegrations(d.integrations);
			setChannels(d.channels);
			setBudget(d.inference.budget || null);
			document.title = d.brand.name;
			document.documentElement.style.setProperty("--accent", d.brand.accent);
			loadApprovals();
		});
	}, []);

	useEffect(() => {
		location.hash = channelId;
		loadMessages(channelId);
		stick.current = true;
	}, [channelId]);

	useEffect(() => {
		const es = new EventSource("/api/events");
		es.addEventListener("message", (e) => {
			const { message } = JSON.parse(e.data);
			if (message.channelId !== channelRef.current) return;
			setMessages((cur) => {
				const i = cur.findIndex((x) => x.id === message.id);
				if (i < 0) return [...cur, message];
				const next = cur.slice(); next[i] = message; return next;
			});
		});
		es.addEventListener("presence", (e) => setPresence(Object.fromEntries(JSON.parse(e.data).presence.map((p) => [p.agentId, p]))));
		es.addEventListener("approval", () => loadApprovals());
		es.addEventListener("channels", (e) => setChannels(JSON.parse(e.data).channels));
		es.addEventListener("integrations", (e) => setIntegrations(JSON.parse(e.data).integrations));
		es.addEventListener("hello", () => { loadMessages(channelRef.current); loadApprovals(); });
		return () => es.close();
	}, []);

	useEffect(() => {
		const t = setInterval(() => {
			if (document.hidden) return;
			api(`/api/channels/${channelRef.current}/messages`).then((d) => d.messages.forEach((m) => setMessages((cur) => {
				if (m.channelId !== channelRef.current) return cur;
				const i = cur.findIndex((x) => x.id === m.id);
				if (i < 0) return [...cur, m].sort((a, b) => a.id - b.id);
				if (cur[i].updatedAt >= m.updatedAt) return cur;
				const next = cur.slice(); next[i] = m; return next;
			}))).catch(() => {});
			loadApprovals().catch(() => {});
		}, 2500);
		return () => clearInterval(t);
	}, []);

	useEffect(() => {
		const load = () => { if (document.hidden) return; api("/api/budget").then((d) => setBudget(d.budget)).catch(() => {}); api("/api/sandboxes").then((d) => setSandboxes(d.sandboxes)).catch(() => {}); };
		load();
		const t = setInterval(load, 20000);
		return () => clearInterval(t);
	}, []);

	useEffect(() => {
		const load = () => !document.hidden && api("/api/workflows").then(setWf).catch(() => {});
		load();
		const t = setInterval(load, 4000);
		return () => clearInterval(t);
	}, []);

	useEffect(() => {
		const load = () => !document.hidden && api("/api/memory").then((d) => setNotes(d.notes)).catch(() => {});
		load();
		const t = setInterval(load, 6000);
		return () => clearInterval(t);
	}, []);

	useEffect(() => { if (stick.current && tl.current) tl.current.scrollTop = tl.current.scrollHeight; }, [messages]);

	const agentIds = useMemo(() => new Set((me?.agents || []).map((a) => a.id)), [me]);
	if (!me) return html`<div style="padding:40px;color:var(--muted)">Loading…</div>`;

	const open = channels.filter((c) => c.status === "open");
	const channel = channels.find((c) => c.id === channelId) || open[0] || { id: "general", name: "general", topic: "", agents: [], kind: "standing", status: "open" };
	const chAgents = channel.agents.map((id) => me.agentsById[id]).filter(Boolean);
	const createCase = async (e) => {
		e.preventDefault();
		const v = (newCase || "").trim();
		if (!v) return;
		try {
			const d = await api("/api/channels", { body: { ticket: v, from: channel.id } });
			setNewCase(null);
			setChannels((cur) => (cur.some((c) => c.id === d.channel.id) ? cur : [...cur, d.channel]));
			setChannelId(d.channel.id);
		} catch (err) { flash(err.message); }
	};
	const openDm = async (agentId) => {
		try {
			const d = await api("/api/dms", { body: { agent: agentId } });
			setChannels((cur) => (cur.some((c) => c.id === d.channel.id) ? cur : [...cur, d.channel]));
			setChannelId(d.channel.id);
		} catch (err) { flash(err.message); }
	};
	const onAction = async (a) => {
		if (a.type === "message") return send(a.text);
		try {
			const d = await api("/api/channels", { body: { ticket: a.ticket, from: channel.id } });
			setChannels((cur) => (cur.some((c) => c.id === d.channel.id) ? cur : [...cur, d.channel]));
			setChannelId(d.channel.id);
		} catch (err) { flash(err.message); }
	};
	const wfMap = Object.fromEntries(wf.workflows.map((w) => [w.id, w]));
	const decideWf = (id, decision, note) => api(`/api/workflows/${id}/decision`, { body: { decision, note } }).then(() => api("/api/workflows").then(setWf)).catch((e) => flash(e.message));
	const startWf = () => api("/api/workflows/incident", { body: { channel: channel.id } }).then((r) => flash(r.started ? "Workflow started" : "A workflow already exists for this case")).then(() => api("/api/workflows").then(setWf)).catch((e) => flash(e.message));
	const archive = (id, on) => api(`/api/channels/${id}/${on ? "archive" : "reopen"}`, { body: {} }).catch((err) => flash(err.message));
	const anomaly = (active) => api("/api/demo/anomaly", { body: { metric: "orders_queue_depth", active } }).then(() => flash(active ? "Anomaly injected — the watcher notices within ~20 s" : "Anomaly cleared")).catch((err) => flash(err.message));
	const pendingByChannel = approvals.reduce((m, a) => ((m[a.channelId] = (m[a.channelId] || 0) + 1), m), {});
	const roleLabel = me.perms.admin ? "admin" : me.perms.approve ? "approver" : me.perms.operate ? "operator" : "viewer";

	const upsert = (message) =>
		setMessages((cur) => {
			if (message.channelId !== channelRef.current) return cur;
			const i = cur.findIndex((x) => x.id === message.id);
			if (i < 0) return [...cur, message];
			if (cur[i].updatedAt > message.updatedAt) return cur;
			const next = cur.slice(); next[i] = message; return next;
		});
	const send = (text, attachments = []) => {
		stick.current = true;
		return api(`/api/channels/${channel.id}/messages`, { body: { text, attachments } }).then((d) => upsert(d.message)).catch((e) => flash(e.message));
	};
	const decide = (id, decision, note) => api(`/api/approvals/${id}/decide`, { body: { decision, note } }).catch((e) => flash(e.message));
	const toggle = (id, enabled) => api(`/api/integrations/${id}`, { body: { enabled } }).then((d) => setIntegrations(d.integrations)).catch((e) => flash(e.message));
	const stop = (agentId) => api(`/api/channels/${channel.id}/agents/${agentId}/stop`, { body: {} }).catch((e) => flash(e.message));

	return html`<div class="shell">
		<aside class="side">
			<div class="brand">
				<div class="logo"><div class="mark">◆</div>${me.brand.name}</div>
				<div class="ws">${me.brand.workspace}</div>
			</div>
			<div class="side-scroll">
			<div class="section"><h4>Channels</h4>
				${open.filter((c) => c.kind === "standing").map((c) => html`<button class=${"item" + (c.id === channel.id ? " active" : "")} onClick=${() => setChannelId(c.id)}>
					<span class="hash">#</span>${c.name}${pendingByChannel[c.id] ? html`<span class="badge">${pendingByChannel[c.id]}</span>` : ""}</button>`)}
			</div>
			<div class="section"><h4>Cases <button class="plus" title="New case from a ticket or topic" onClick=${() => setNewCase(newCase === null ? "" : null)}>＋</button></h4>
				${newCase !== null && html`<form class="newcase" onSubmit=${createCase}><input autofocus placeholder="Ticket (PAY-412) or topic" value=${newCase} onInput=${(e) => setNewCase(e.target.value)} /></form>`}
				${open.filter((c) => c.kind === "issue").map((c) => html`<button class=${"item" + (c.id === channel.id ? " active" : "")} onClick=${() => setChannelId(c.id)} title=${c.topic}>
					<span class="hash">◆</span><span class="cname">${c.ticket || c.name}</span><span class="sub">${c.ticket ? c.topic : ""}</span>${pendingByChannel[c.id] ? html`<span class="badge">${pendingByChannel[c.id]}</span>` : ""}</button>`)}
				${open.filter((c) => c.kind === "issue").length === 0 && newCase === null && html`<div class="empty" style="padding:2px 10px">No open cases.</div>`}
				${channels.some((c) => c.status === "archived") && html`<button class="item muted" onClick=${() => setShowArchived(!showArchived)}>${showArchived ? "▾" : "▸"} Archived (${channels.filter((c) => c.status === "archived").length})</button>`}
				${showArchived && channels.filter((c) => c.status === "archived").map((c) => html`<button class=${"item muted" + (c.id === channel.id ? " active" : "")} onClick=${() => setChannelId(c.id)}><span class="hash">◇</span><span class="cname">${c.ticket || c.name}</span></button>`)}
			</div>
			<div class="section"><h4>Direct messages</h4>
				${open.filter((c) => c.kind === "dm").map((c) => html`<button class=${"item" + (c.id === channel.id ? " active" : "")} onClick=${() => setChannelId(c.id)}><span class="hash">🔒</span>${c.name}</button>`)}
				${open.filter((c) => c.kind === "dm").length === 0 && html`<div class="empty" style="padding:2px 10px">Click an agent below to chat privately.</div>`}
			</div>
			<div class="section"><h4>Agents</h4>
				${me.agents.map((a) => html`<button class="item" title=${"Private chat with " + a.name + " — " + a.title} onClick=${() => me.perms.operate && openDm(a.id)}><span class=${"dot " + (presence[a.id]?.status || "idle")}></span>${a.name}<span class="sub">${{ idle: "idle", working: "working", waiting_approval: "needs approval" }[presence[a.id]?.status || "idle"]}</span></button>`)}
			</div>
			</div>
			<div class="me">
				<${Avatar} name=${me.user.name} human=${true} />
				<div class="who"><b>${me.user.name}</b><span>${roleLabel}</span></div>
				<a class="linkbtn" href="/auth/logout" title="Sign out">Sign out</a>
			</div>
		</aside>
		<main class="main">
			<div class="header">
				<h2>${channel.kind === "dm" ? "🔒 " + channel.name : "# " + channel.name}</h2>${channel.ticket && html`<span class="tkey">${channel.ticket}</span>`}<span class="topic">${channel.topic}</span>
				${sandboxes.find((x) => x.key === channel.id) && html`<span class="chip sbx" title="An isolated pod where agents run commands. Deleted after 30 min idle.">🧪 sandbox · idle ${Math.max(0, Math.round((Date.now() - sandboxes.find((x) => x.key === channel.id).lastUsed) / 60000))}m ${me.perms.operate ? html`<button class="linkbtn" onClick=${() => api(`/api/sandboxes/${channel.id}/stop`, { body: {} }).then(() => setSandboxes((c) => c.filter((x) => x.key !== channel.id))).catch((e) => flash(e.message))}>stop</button>` : ""}</span>`}
				${channel.kind === "issue" && me.perms.operate && html`<button class="btn small" onClick=${() => archive(channel.id, channel.status === "open")}>${channel.status === "open" ? "Archive case" : "Reopen"}</button>`}
				<span class=${"pill" + (me.inference.demo ? " demo" : "") + (budget?.blocked ? " over" : "")} title=${budget ? `OpenRouter spend. Soft cap $${budget.softCap}, key hard limit $${budget.hardLimit ?? "?"}` : ""}>${me.inference.demo ? "demo inference (scripted)" : "inference: " + me.inference.providers.filter((p) => p !== "demo").join(", ")}${budget ? ` · $${budget.spent.toFixed(2)} / $${budget.softCap}` : ""}</span>
			</div>
			${approvals.some((a) => a.channelId === channel.id) && html`<div class="banner">⚠ ${approvals.filter((a) => a.channelId === channel.id).length} approval waiting: <b>${approvals.find((a) => a.channelId === channel.id).title}</b> — ${me.perms.approve ? "scroll down to the card and approve or reject." : "only an approver can decide; sign in as one."}</div>`}
			<div class="timeline" ref=${tl} onScroll=${(e) => { const t = e.target; stick.current = t.scrollHeight - t.scrollTop - t.clientHeight < 80; }}>
				${messages.map((m) => html`<${Message} key=${m.id} m=${m} me=${me} agentIds=${agentIds} onDecide=${decide} onOpen=${setChannelId} onAction=${onAction} wfs=${wfMap} onDecision=${decideWf} />`)}
			</div>
			<${Composer} channel=${channel} agents=${channel.kind === "dm" ? [] : chAgents} canPost=${me.perms.post && channel.status === "open"} onSend=${send} />
		</main>
		<aside class="ctx">
			<div class="ctx-pin">
				<h3>Pending approvals ${approvals.length ? html`<span class="badge">${approvals.length}</span>` : ""}</h3>
				${approvals.length === 0 ? html`<div class="empty">Nothing waiting.</div>` : approvals.map((a) => html`<div class="apitem" key=${a.id}><b>${a.title}</b><div style="color:var(--muted)">#${a.channelId} · ${me.agentsById[a.agentId]?.name}</div>
					<button class="btn" onClick=${() => setChannelId(a.channelId)}>${a.channelId === channel.id ? "Show in chat" : "Open #" + a.channelId}</button></div>`)}
			</div>
			<div class="ctx-scroll">
				<h3>Agents in #${channel.name}</h3>
				${chAgents.map((a) => html`<${AgentCard} key=${a.id} a=${a} presence=${presence} channelId=${channel.id} canOperate=${me.perms.operate} onStop=${stop} onFlash=${flash} />`)}
				<h3>Workflows <span style="text-transform:none;letter-spacing:0;font-weight:400">(Temporal)</span></h3>
				<div class="notes">
					${!wf.available && html`<div class="empty" style="padding:0">Temporal is not connected.</div>`}
					${wf.available && wf.workflows.length === 0 && html`<div class="empty" style="padding:0">No workflows yet. They start when the watcher opens a case, or from a case channel.</div>`}
					${wf.workflows.slice(0, 8).map((w) => html`<div class="note" key=${w.id}><span class=${"chip st-" + w.status.toLowerCase()}>${w.status.toLowerCase()}</span> ${w.step && html`<span class="chip">${w.step}</span>`}
						<div><button class="linkbtn" style="padding:0;color:var(--text)" onClick=${() => w.channelId && setChannelId(w.channelId)}>${w.id}</button></div></div>`)}
					${wf.available && channel.kind === "issue" && channel.status === "open" && me.perms.operate && !wfMap["incident-" + channel.id] && html`<button class="btn small" onClick=${startWf}>Start incident workflow here</button>`}
				</div>
				<h3>Memory <span style="text-transform:none;letter-spacing:0;font-weight:400">(what agents remember)</span></h3>
				<div class="notes">${(() => {
					const ids = new Set(channel.agents);
					const mine = notes.filter((n) => ids.has(n.agentId) && (n.scope === "agent" || n.scope === "channel:" + channel.id)).slice(0, 25);
					if (!mine.length) return html`<div class="empty" style="padding:0">No notes yet. Agents save durable facts here as they work.</div>`;
					return mine.map((n) => html`<div class="note" key=${n.id}><span class="chip" style=${{ color: me.agentsById[n.agentId]?.color, borderColor: me.agentsById[n.agentId]?.color }}>${me.agentsById[n.agentId]?.name}</span>${n.scope !== "agent" && html`<span class="chip">this channel</span>`}${n.source === "system" && html`<span class="chip">auto</span>`}
						<div>${n.text}</div><div class="ui-sub">${new Date(n.createdAt).toLocaleDateString()}${me.perms.admin ? html` · <button class="linkbtn" onClick=${() => api(`/api/memory/${n.id}/delete`, { body: {} }).then(() => setNotes((c) => c.filter((x) => x.id !== n.id))).catch((e) => flash(e.message))}>delete</button>` : ""}</div></div>`);
				})()}</div>
				<h3>Integrations <span style="text-transform:none;letter-spacing:0;font-weight:400">(mostly demo fakes)</span></h3>
				<div class="integrations">${integrations.map((i) => html`<label class=${"integ" + (me.perms.admin ? "" : " ro")} title=${i.description}>
					<input type="checkbox" checked=${i.enabled} disabled=${!me.perms.admin} onChange=${(e) => toggle(i.id, e.target.checked)} /><span class="sw"></span><span>${i.name}</span></label>`)}
					${!me.perms.admin && html`<div class="empty" style="padding:4px 0 0">Only an admin can switch these.</div>`}</div>
				${me.perms.admin && html`<h3>Demo controls</h3><div class="integrations"><div class="empty" style="padding:0 0 6px">Make orders queue depth spike. The watcher then opens a ticket and a case channel by itself.</div>
					<button class="btn small" onClick=${() => anomaly(true)}>Inject anomaly</button> <button class="btn small" onClick=${() => anomaly(false)}>Clear</button></div>`}
			</div>
		</aside>
		${toast && html`<div class="toast">${toast}</div>`}
	</div>`;
}

render(html`<${App} />`, document.getElementById("app"));
