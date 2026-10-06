import { test } from "node:test";
import assert from "node:assert/strict";
const { validateSpec } = await import("../src/ui-spec.ts");

const ok = { root: "c", elements: { c: { type: "Card", props: { title: "Prod" }, children: ["s", "b"] }, s: { type: "StatusBoard", props: { items: [{ name: "api", status: "bad", detail: "x" }] } }, b: { type: "Button", props: { label: "Ask", action: { type: "message", text: "@ops hi" } } } } };

test("a valid spec passes and is copied clean", () => {
	const v = validateSpec({ ...ok, extra: "ignored" });
	assert.equal(v.root, "c");
	assert.deepEqual(Object.keys(v.elements).sort(), ["b", "c", "s"]);
});

test("unknown components, bad props, dangling children, cycles and wrong actions are rejected", () => {
	assert.throws(() => validateSpec({ root: "a", elements: { a: { type: "Script", props: {} } } }), /unknown component/);
	assert.throws(() => validateSpec({ root: "a", elements: { a: { type: "Stat", props: { label: "x" } } } }), /value/);
	assert.throws(() => validateSpec({ root: "a", elements: { a: { type: "Card", props: {}, children: ["zzz"] } } }), /does not exist/);
	assert.throws(() => validateSpec({ root: "a", elements: { a: { type: "Card", props: {}, children: ["b"] }, b: { type: "Card", props: {}, children: ["a"] } } }), /twice or forms a cycle/);
	assert.throws(() => validateSpec({ root: "a", elements: { a: { type: "Text", props: { text: "x" }, children: ["b"] }, b: { type: "Text", props: { text: "y" } } } }), /cannot have children/);
	assert.throws(() => validateSpec({ root: "a", elements: { a: { type: "Button", props: { label: "x", action: { type: "http", url: "https://evil" } } } } }), /action.type/);
	assert.throws(() => validateSpec({ root: "a" }), /spec must be/);
});

test("limits: element count and string length", () => {
	const many: any = { root: "e0", elements: {} };
	for (let i = 0; i < 70; i++) many.elements[`e${i}`] = { type: "Text", props: { text: "x" } };
	assert.throws(() => validateSpec(many), /1-60 elements/);
	const long = validateSpec({ root: "a", elements: { a: { type: "Text", props: { text: "x".repeat(5000) } } } });
	assert.equal((long.elements.a.props.text as string).length, 1200);
});
