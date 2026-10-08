// The world in the Crew UI. A synthetic world's conversation is copied, in order and exactly once, into a read-only standing channel
// (#world-<name>) as ordinary message rows, so the workspace the people already use shows it with no new UI. The bridge reads the world
// (read-only) and writes only messages; nothing flows back into the world.
import { db, store } from "../db.ts";
import { hub } from "../hub.ts";
import { channelById } from "../channels.ts"; // also creates the channels table: the bridge must not depend on someone else having loaded it
import { Observer, type ChatMessage } from "./observe.ts";

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
export const worldChannelId = (name: string): string => {
	if (!NAME.test(name)) throw new Error("a world name is 1-40 letters, digits, - or _");
	return `world-${name.toLowerCase()}`;
};
export const isWorldChannel = (id: string): boolean => id.startsWith("world-");

const clock = (ms: number) => { const m = Math.floor(ms / 60_000); return `day ${Math.floor(m / 1440)} ${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

function textOf(m: ChatMessage): string {
	const body = m.kind === "request" || m.kind === "reply" ? (m.to ? `@${m.to} ${m.text}` : m.text) : m.text;
	return `${clock(m.vtime)} · ${body}`;
}

/** Copies what the world has said since the last sync into its channel. Returns how many messages were added. */
export function syncWorldChannel(path: string, name: string): { added: number } {
	const id = worldChannelId(name);
	const obs = new Observer(path); // throws "no such world file" before anything is created
	try {
		if (!channelById(id)) db.prepare("INSERT OR IGNORE INTO channels (id, name, topic, kind, agents, created_by, created_at) VALUES (?,?,?,?,?,?,?)").run(
			id, id, `Synthetic world "${name}": a simulated company. A read-only window: nothing said here is real, and nobody here answers.`, "standing", "[]", "system", Date.now(),
		);
		const last = db.prepare("SELECT meta FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT 1").get(id) as { meta: string } | undefined;
		let cursor = last ? Number(JSON.parse(last.meta)?.world?.seq ?? 0) : 0, added = 0;
		for (;;) {
			const page = obs.chat({ since: cursor, limit: 1000 });
			if (!page.length) break;
			for (const m of page) {
				const agent = m.kind === "request" || m.kind === "reply" || m.kind === "fix";
				const msg = store.addMessage({
					channelId: id, authorKind: agent ? "agent" : "system", authorId: m.from, authorName: m.from, text: textOf(m),
					meta: { kind: agent ? "agent" : "notice", status: "done", world: { seq: m.seq, vtime: m.vtime, kind: m.kind, ...(m.to ? { to: m.to } : {}) } },
				});
				hub.publish({ type: "message", message: msg });
				cursor = m.seq; added++;
			}
		}
		return { added };
	} finally {
		obs.close();
	}
}
