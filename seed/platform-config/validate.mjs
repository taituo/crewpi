// Checks every ConfigMap manifest under demo-apps/. Run it before committing a change: `node repo/validate.mjs`.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dir = join(root, "demo-apps");
const errors = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
	let m;
	try { m = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch (e) { errors.push(`${f}: invalid JSON (${e.message})`); continue; }
	if (m.kind !== "ConfigMap") { errors.push(`${f}: kind must be ConfigMap`); continue; }
	const d = m.data ?? {};
	for (const [k, v] of Object.entries(d)) if (typeof v !== "string") errors.push(`${f}: ${k} must be a string`);
	if ("POOL_SIZE" in d && !(/^\d+$/.test(d.POOL_SIZE) && Number(d.POOL_SIZE) >= 1 && Number(d.POOL_SIZE) <= 200)) errors.push(`${f}: POOL_SIZE must be an integer from 1 to 200, got "${d.POOL_SIZE}"`);
	if ("REGION" in d && !d.REGION) errors.push(`${f}: REGION must not be empty`);
}
if (errors.length) { console.error(`FAIL\n${errors.map((e) => " - " + e).join("\n")}`); process.exit(1); }
console.log("OK: all manifests valid");
