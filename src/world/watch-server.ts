// The observer's web server: JSON routes over a read-only Observer and one self-contained page. Local by default (127.0.0.1), no writes at all.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Observer } from "./observe.ts";

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "ui", "world.html");

export async function startWatch(o: { path: string; port?: number; host?: string }): Promise<{ url: string; close(): Promise<void> }> {
	const obs = new Observer(o.path); // throws if the file is missing or not a world
	const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(JSON.stringify(body));
	};
	const int = (v: string | null, dflt: number) => (v === null || v === "" ? dflt : /^\d+$/.test(v) ? Number(v) : NaN);
	const srv = createServer((req, res) => {
		try {
			if (req.method !== "GET") return json(res, 405, { error: "this server is read-only" });
			const u = new URL(req.url ?? "/", "http://x");
			const q = u.searchParams;
			if (u.pathname === "/") {
				res.writeHead(200, {
					"content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
					"content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
				}).end(readFileSync(PAGE));
				return;
			}
			const limit = Math.min(int(q.get("limit"), 200), 2000), since = int(q.get("since"), 0);
			switch (u.pathname) {
				case "/api/info": return json(res, 200, obs.info());
				case "/api/view": {
					const seq = q.get("seq") === null ? undefined : int(q.get("seq"), NaN);
					if (seq !== undefined && Number.isNaN(seq)) return json(res, 400, { error: "seq must be a whole number" });
					return json(res, 200, obs.view(seq, { god: q.get("god") === "1" }));
				}
				case "/api/events": {
					if (Number.isNaN(limit) || Number.isNaN(since)) return json(res, 400, { error: "since and limit must be whole numbers" });
					return json(res, 200, { events: obs.events({ since, limit, type: q.get("type") ?? undefined, actor: q.get("actor") ?? undefined }) });
				}
				case "/api/chat": {
					if (Number.isNaN(limit) || Number.isNaN(since)) return json(res, 400, { error: "since and limit must be whole numbers" });
					return json(res, 200, { messages: obs.chat({ since, limit }) });
				}
				case "/api/series": return json(res, 200, obs.series());
				default: return json(res, 404, { error: "not found" });
			}
		} catch (e) {
			json(res, 500, { error: (e as Error).message });
		}
	});
	await new Promise<void>((r) => srv.listen(o.port ?? 8810, o.host ?? "127.0.0.1", r));
	const port = (srv.address() as { port: number }).port;
	return { url: `http://${o.host ?? "127.0.0.1"}:${port}`, close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => { obs.close(); r(); }); }) };
}
