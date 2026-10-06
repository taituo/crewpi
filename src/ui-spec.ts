import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { bridge } from "./hub.ts";

/**
 * Generative UI with guardrails (the json-render idea): agents describe a UI as a flat JSON spec
 * { root, elements: { id: { type, props, children } } } made only of components from this catalog.
 * The spec is validated and sanitised here, rendered by the browser from a fixed set of components,
 * and its buttons can only do what the clicking person could do by typing (send a message / open a case).
 */

const TONES = ["ok", "warn", "bad", "muted", "accent"] as const;
const MAX_ELEMENTS = 60;
const MAX_DEPTH = 6;

const str = (v: unknown, max = 300, what = "string"): string => {
	if (typeof v !== "string") throw new Error(`${what} must be a string`);
	return v.slice(0, max);
};
const optStr = (v: unknown, max = 300) => (v === undefined || v === null ? undefined : str(v, max));
const num = (v: unknown, what: string): number => {
	if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} must be a number`);
	return v;
};
const oneOf = <T extends string>(v: unknown, opts: readonly T[], what: string, dflt?: T): T => {
	if (v === undefined && dflt) return dflt;
	if (!opts.includes(v as T)) throw new Error(`${what} must be one of ${opts.join(" | ")}`);
	return v as T;
};
const list = <T>(v: unknown, max: number, what: string, fn: (x: any, i: number) => T): T[] => {
	if (!Array.isArray(v)) throw new Error(`${what} must be an array`);
	return v.slice(0, max).map(fn);
};
const tone = (v: unknown) => (v === undefined ? undefined : oneOf(v, TONES, "tone"));

type Def = { container?: boolean; props: (p: any) => Record<string, unknown> };
export const CATALOG: Record<string, Def & { doc: string }> = {
	Stack: { container: true, doc: "layout. props: direction ('row'|'column', default column), gap?", props: (p) => ({ direction: oneOf(p.direction, ["row", "column"] as const, "direction", "column") }) },
	Card: { container: true, doc: "bordered panel. props: title?, subtitle?", props: (p) => ({ title: optStr(p.title, 120), subtitle: optStr(p.subtitle, 200) }) },
	Text: { doc: "paragraph. props: text, tone?, bold?", props: (p) => ({ text: str(p.text, 1200, "text"), tone: tone(p.tone), bold: !!p.bold }) },
	Badge: { doc: "small label. props: text, tone?", props: (p) => ({ text: str(p.text, 60, "text"), tone: tone(p.tone) }) },
	Stat: { doc: "big number. props: label, value (string|number), unit?, trend? ('up'|'down'|'flat'), tone?", props: (p) => ({ label: str(p.label, 80, "label"), value: typeof p.value === "number" ? p.value : str(p.value, 40, "value"), unit: optStr(p.unit, 20), trend: p.trend === undefined ? undefined : oneOf(p.trend, ["up", "down", "flat"] as const, "trend"), tone: tone(p.tone) }) },
	KeyValue: { doc: "label/value rows. props: items [{key, value}]", props: (p) => ({ items: list(p.items, 30, "items", (i) => ({ key: str(i.key, 60, "key"), value: str(String(i.value ?? ""), 200, "value") })) }) },
	Progress: { doc: "progress bar. props: value, max?, label?, tone?", props: (p) => ({ value: num(p.value, "value"), max: p.max === undefined ? 100 : num(p.max, "max"), label: optStr(p.label, 80), tone: tone(p.tone) }) },
	StatusBoard: { doc: "grid of statuses. props: items [{name, status ('ok'|'warn'|'bad'|'unknown'), detail?}]", props: (p) => ({ items: list(p.items, 40, "items", (i) => ({ name: str(i.name, 60, "name"), status: oneOf(i.status, ["ok", "warn", "bad", "unknown"] as const, "status"), detail: optStr(i.detail, 120) })) }) },
	Timeline: { doc: "events in order. props: events [{time, title, detail?, tone?}]", props: (p) => ({ events: list(p.events, 40, "events", (e) => ({ time: str(e.time, 40, "time"), title: str(e.title, 120, "title"), detail: optStr(e.detail, 240), tone: tone(e.tone) })) }) },
	Table: { doc: "table. props: columns [string], rows [[string|number]]", props: (p) => ({ columns: list(p.columns, 10, "columns", (c) => str(c, 60)), rows: list(p.rows, 100, "rows", (r) => list(r, 10, "row", (c) => (typeof c === "number" ? c : str(String(c), 200)))) }) },
	Chart: { doc: "chart. props: type ('line'|'area'|'bar'), unit?, series [{name, points [{x, y}]}] (x = ms timestamp or label)", props: (p) => ({ type: oneOf(p.type, ["line", "area", "bar"] as const, "type"), unit: optStr(p.unit, 20), title: optStr(p.title, 120), series: list(p.series, 6, "series", (s) => ({ name: str(s.name, 60, "name"), points: list(s.points, 400, "points", (pt) => ({ x: typeof pt.x === "number" ? pt.x : str(String(pt.x), 60), y: num(pt.y, "y") })) })) }) },
	Button: {
		doc: "button the person can click. props: label, action: {type:'message', text} sends that text to the channel as the person (e.g. \"@ops restart checkout-api\"), or {type:'open_case', ticket} opens the case channel for a ticket",
		props: (p) => {
			const a = p.action ?? {};
			const type = oneOf(a.type, ["message", "open_case"] as const, "action.type");
			return { label: str(p.label, 60, "label"), action: type === "message" ? { type, text: str(a.text, 500, "action.text") } : { type, ticket: str(a.ticket, 30, "action.ticket") } };
		},
	},
};

export type UiSpec = { root: string; elements: Record<string, { type: string; props: Record<string, unknown>; children: string[] }> };

/** Validates against the catalog and returns a clean copy. Throws errors the model can act on. */
export function validateSpec(input: any): UiSpec {
	if (!input || typeof input.root !== "string" || typeof input.elements !== "object" || !input.elements) throw new Error('spec must be { "root": "<id>", "elements": { "<id>": { "type", "props", "children": ["<id>"] } } }');
	const ids = Object.keys(input.elements);
	if (ids.length === 0 || ids.length > MAX_ELEMENTS) throw new Error(`spec must have 1-${MAX_ELEMENTS} elements`);
	if (!input.elements[input.root]) throw new Error(`root "${input.root}" is not in elements`);
	const out: UiSpec = { root: input.root, elements: {} };
	for (const id of ids) {
		const el = input.elements[id];
		const def = CATALOG[el?.type];
		if (!def) throw new Error(`element "${id}": unknown component "${el?.type}". Allowed: ${Object.keys(CATALOG).join(", ")}`);
		const children = el.children === undefined ? [] : list(el.children, 40, `${id}.children`, (c) => str(c, 60));
		if (children.length && !def.container) throw new Error(`element "${id}": ${el.type} cannot have children`);
		for (const c of children) if (!input.elements[c]) throw new Error(`element "${id}": child "${c}" does not exist`);
		try {
			out.elements[id] = { type: el.type, props: def.props(el.props ?? {}), children };
		} catch (e) {
			throw new Error(`element "${id}" (${el.type}): ${(e as Error).message}`);
		}
	}
	// no cycles, bounded depth
	const walk = (id: string, depth: number, seen: Set<string>) => {
		if (depth > MAX_DEPTH) throw new Error(`nesting deeper than ${MAX_DEPTH}`);
		if (seen.has(id)) throw new Error(`element "${id}" is used twice or forms a cycle`);
		seen.add(id);
		for (const c of out.elements[id].children) walk(c, depth + 1, seen);
	};
	walk(out.root, 1, new Set());
	return out;
}

const docs = Object.entries(CATALOG).map(([k, v]) => `- ${k}: ${v.doc}`).join("\n");

export const renderUi = defineTool({
	name: "render_ui",
	description:
		"Show a rich, structured view in the channel instead of a wall of text: status overviews, dashboards, summaries with numbers, timelines, tables, charts and buttons. " +
		'Pass spec = { "root": "id", "elements": { "id": { "type": "Card", "props": {...}, "children": ["id2"] } } } using ONLY these components:\n' + docs +
		"\nExample: {\"root\":\"c\",\"elements\":{\"c\":{\"type\":\"Card\",\"props\":{\"title\":\"Prod\"},\"children\":[\"s\"]},\"s\":{\"type\":\"StatusBoard\",\"props\":{\"items\":[{\"name\":\"checkout-api\",\"status\":\"bad\",\"detail\":\"CrashLoopBackOff\"}]}}}}. " +
		"Use real data you fetched; never invent numbers. Add one or two sentences of text after it saying what matters.",
	parameters: Type.Object({ spec: Type.Any({ description: "The UI spec" }) }),
	replay: "safe",
	execute: async (args: any, api: any) => {
		try {
			const spec = validateSpec(typeof args.spec === "string" ? JSON.parse(args.spec) : args.spec);
			bridge.attachArtifact?.(api.conversationId, { kind: "ui", spec });
			return { content: [{ type: "text" as const, text: `View shown to the user (${Object.keys(spec.elements).length} elements).` }] };
		} catch (e) {
			return { isError: true, content: [{ type: "text" as const, text: `Invalid spec: ${(e as Error).message}. Fix it and call render_ui again.` }] };
		}
	},
} as any);
