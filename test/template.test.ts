import { describe, expect, it } from "vitest";
import { escapePythonString, inlineScript, substituteVars } from "../src/utils/template.js";

describe("substituteVars", () => {
	it("escapes strings for a Python literal", () => {
		expect(substituteVars("x = '{{v}}'", { v: "it's" })).toBe("x = 'it\\'s'");
		expect(substituteVars('x = "{{v}}"', { v: 'say "hi"' })).toBe('x = "say \\"hi\\""');
		expect(substituteVars("x = '{{v}}'", { v: "a\\b" })).toBe("x = 'a\\\\b'");
		expect(substituteVars("x = '{{v}}'", { v: "a\nb" })).toBe("x = 'a\\nb'");
	});

	it("writes booleans as Python literals", () => {
		expect(substituteVars("a={{on}} b={{off}}", { on: true, off: false })).toBe(
			"a=True b=False",
		);
	});

	it("writes numbers as numeric literals", () => {
		expect(substituteVars("n={{n}} f={{f}} neg={{neg}}", { n: 3, f: 0.5, neg: -2 })).toBe(
			"n=3 f=0.5 neg=-2",
		);
	});

	it("refuses numbers Python cannot read", () => {
		expect(() => substituteVars("{{n}}", { n: Number.NaN })).toThrow(/finite/);
		expect(() => substituteVars("{{n}}", { n: Number.POSITIVE_INFINITY })).toThrow(/finite/);
	});

	it("leaves unknown placeholders alone", () => {
		expect(substituteVars("{{known}} {{unknown}}", { known: "a" })).toBe("a {{unknown}}");
	});

	it("does not re-expand placeholders found inside values", () => {
		expect(substituteVars("{{a}}", { a: "{{b}}", b: "boom" })).toBe("{{b}}");
	});

	it("keeps a value that looks like code inside its string literal", () => {
		const out = substituteVars("x = '{{v}}'", { v: "'; import os; os.system('x') #" });
		expect(out).toBe("x = '\\'; import os; os.system(\\'x\\') #'");
	});
});

describe("escapePythonString", () => {
	it("keeps non-ASCII text and escapes control characters", () => {
		expect(escapePythonString("Größe")).toBe("Größe");
		expect(escapePythonString("a\0b")).toBe("a\\x00b");
		expect(escapePythonString("a\u0007b")).toBe("a\\x07b");
	});
});

describe("inlineScript", () => {
	it("substitutes in a script body", () => {
		expect(inlineScript("print('{{msg}}', {{count}})", { msg: "hi", count: 2 })).toBe(
			"print('hi', 2)",
		);
	});
});
