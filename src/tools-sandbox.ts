import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { offResult } from "./integrations.ts";
import { bridge } from "./hub.ts";
import { repo } from "./repo.ts";
import { ensureSandbox, runner } from "./sandbox.ts";
import { store } from "./db.ts";

const clip = (s: string, n = 7000) => (s.length > n ? `${s.slice(0, n)}\n... [truncated ${s.length - n} chars]` : s);
const text = (t: string) => ({ content: [{ type: "text" as const, text: clip(t) }] });
const fail = (t: string) => ({ isError: true, content: [{ type: "text" as const, text: t }] });

/** The sandbox belongs to the channel the agent is working in (a private chat gets its own). */
function ctx(api: any) {
	const loc = bridge.locate?.(api.conversationId);
	if (!loc) throw new Error("conversation is not attached to a channel");
	return loc;
}

function sbxTool(name: string, description: string, parameters: any, run: (args: any, sb: Awaited<ReturnType<typeof ensureSandbox>>, who: { channelId: string; agentId: string }) => Promise<string>, replay: "safe" | "unsafe") {
	return defineTool({
		name,
		description,
		parameters,
		replay,
		executionMode: "sequential", // one runner, one command at a time
		execute: async (args: any, api: any) => {
			const off = offResult("sandbox");
			if (off) return off;
			try {
				const who = ctx(api);
				const sb = await ensureSandbox(who.channelId);
				return text(await run(args, sb, who));
			} catch (e) {
				return fail(`Error: ${(e as Error).message}`);
			}
		},
	} as any);
}

const sbxExec = sbxTool(
	"sbx_exec",
	"Run a shell command in this channel's sandbox pod (working dir /work, files persist between calls until the sandbox expires, ~30 min idle). The sandbox has node 22, npm, python3, git, jq and curl, no secrets and no access to the cluster; the public web (80/443) is reachable. Returns exit code, stdout and stderr. Not for anything that must survive: results you want to keep go to the repo.",
	Type.Object({ command: Type.String({ description: "Shell command (sh -c)" }), timeout_s: Type.Optional(Type.Number({ description: "Seconds, default 60, max 300" })), cwd: Type.Optional(Type.String({ description: "Directory under /work" })) }),
	async (a, sb, who) => {
		const r = await runner<any>(sb, "POST", "/exec", { command: a.command, cwd: a.cwd, timeoutS: a.timeout_s }, ((a.timeout_s ?? 60) + 15) * 1000);
		store.audit(`agent:${who.agentId}`, "sandbox.exec", { channel: who.channelId, command: String(a.command).slice(0, 200), code: r.code });
		return `exit ${r.code}${r.timedOut ? " (TIMED OUT and killed)" : ""}${r.signal ? ` signal ${r.signal}` : ""} in ${r.ms} ms${r.truncated ? " (output truncated)" : ""}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
	},
	"unsafe", // a command is not idempotent: after a crash the model is told it was interrupted
);

const sbxWrite = sbxTool(
	"sbx_write", "Write a file in the sandbox (path under /work; creates directories).",
	Type.Object({ path: Type.String(), content: Type.String() }),
	async (a, sb) => {
		const r = await runner<any>(sb, "PUT", `/file?path=${encodeURIComponent(a.path)}`, a.content);
		return `Wrote ${a.path} (${r.bytes} bytes).`;
	},
	"safe",
);

const sbxRead = sbxTool(
	"sbx_read", "Read a text file from the sandbox (path under /work).",
	Type.Object({ path: Type.String() }),
	async (a, sb) => (await runner<any>(sb, "GET", `/file?path=${encodeURIComponent(a.path)}`)).content,
	"safe",
);

const sbxLs = sbxTool(
	"sbx_ls", "List a sandbox directory (default /work).",
	Type.Object({ path: Type.Optional(Type.String()) }),
	async (a, sb) => (await runner<any>(sb, "GET", `/ls?path=${encodeURIComponent(a.path ?? ".")}`)).entries.map((e: any) => `${e.type === "dir" ? "d" : "-"} ${String(e.size).padStart(8)} ${e.name}`).join("\n") || "(empty)",
	"safe",
);

const sbxImport = sbxTool(
	"sbx_import_repo",
	"Copy the platform-config repository at a ref (main or an agent/* branch) into the sandbox, by default under /work/repo, so you can run its checks (for example `node repo/validate.mjs`).",
	Type.Object({ ref: Type.Optional(Type.String()), dir: Type.Optional(Type.String()) }),
	async (a, sb) => {
		const ref = a.ref ?? "main", dir = (a.dir ?? "repo").replace(/\.\./g, "").replace(/^\/?work(\/|$)/, "").replace(/^\/+/, "") || "repo";
		const files = (await repo.list(ref)).slice(0, 200);
		for (const f of files) await runner(sb, "PUT", `/file?path=${encodeURIComponent(`${dir}/${f}`)}`, await repo.read(f, ref));
		return `Imported ${files.length} files from ${ref} into /work/${dir}.`;
	},
	"safe",
);

export const SandboxExtension = defineExtension({ name: "sandbox", tools: [sbxExec, sbxWrite, sbxRead, sbxLs, sbxImport] as any });
