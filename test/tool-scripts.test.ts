import { beforeAll, describe, expect, it } from "vitest";
import { registerAllTools } from "../src/tools/index.js";
import { type RenderedScript, collectScripts, testConfig } from "./helpers/harness.js";
import { PYTHON, type PythonCheck, checkPython } from "./helpers/python.js";

/**
 * Runs every tool with generated arguments and checks the Python it would send to the editor.
 * No Unreal install is needed: this catches syntax errors, JavaScript values leaking into the
 * script (true, undefined, NaN) and arguments that could break out of their string literal.
 * It cannot tell whether an Unreal API exists; see docs/ue-compat.md for how that is checked.
 */

const id = (s: RenderedScript, index: number) => `${s.tool}__${s.variant}__${index}`;

/** These tools run the caller's own Python, so their argument is code rather than data. */
const RUNS_CALLERS_CODE = new Set(["execute_python"]);

describe.skipIf(!PYTHON)("generated Python", () => {
	let plain: RenderedScript[];
	let hostile: RenderedScript[];
	let plainChecks: Map<string, PythonCheck>;
	let hostileChecks: Map<string, PythonCheck>;

	beforeAll(async () => {
		const [a, b] = await Promise.all([
			collectScripts(registerAllTools as never, testConfig(), "plain"),
			collectScripts(registerAllTools as never, testConfig(), "hostile"),
		]);
		expect(a.errors).toEqual([]);
		expect(b.errors).toEqual([]);
		plain = a.scripts.filter((s) => !RUNS_CALLERS_CODE.has(s.tool));
		hostile = b.scripts.filter((s) => !RUNS_CALLERS_CODE.has(s.tool));
		const run = (scripts: RenderedScript[]) =>
			new Map(
				checkPython(scripts.map((s, i) => ({ id: id(s, i), source: s.python }))).map((c) => [
					c.id,
					c,
				]),
			);
		plainChecks = run(plain);
		hostileChecks = run(hostile);
	});

	it("produces scripts for the tools that talk to the editor", () => {
		expect(new Set(plain.map((s) => s.tool)).size).toBeGreaterThan(90);
	});

	it("parses as Python", () => {
		const broken = [...plainChecks.values(), ...hostileChecks.values()]
			.filter((c) => c.syntax)
			.map((c) => `${c.id}: ${c.syntax}`);
		expect(broken).toEqual([]);
	});

	it("only reads names that exist", () => {
		const bad = [...plainChecks.values(), ...hostileChecks.values()]
			.filter((c) => c.undefined?.length)
			.map((c) => `${c.id}: ${c.undefined?.join(", ")}`);
		expect(bad).toEqual([]);
	});

	it("leaves no placeholder or JavaScript value behind", () => {
		const leaks: string[] = [];
		plain.forEach((s, i) => {
			for (const [label, pattern] of [
				["unreplaced {{placeholder}}", /\{\{\w+\}\}/],
				["JavaScript ${...}", /\$\{/],
				["[object Object]", /\[object Object\]/],
				["undefined", /(^|[^"'\w])undefined([^"'\w]|$)/],
				["NaN", /(^|[^"'\w])NaN([^"'\w]|$)/],
			] as const) {
				if (pattern.test(s.python)) leaks.push(`${id(s, i)}: ${label}`);
			}
		});
		expect(leaks).toEqual([]);
	});

	it("keeps quotes, backslashes and code in arguments inside their string literals", () => {
		expect(hostile.length).toBe(plain.length);
		const different: string[] = [];
		plain.forEach((s, i) => {
			const a = plainChecks.get(id(s, i));
			const b = hostileChecks.get(id(hostile[i], i));
			if (JSON.stringify(a?.shape) !== JSON.stringify(b?.shape)) {
				different.push(`${s.tool} [${s.variant}]`);
			}
		});
		expect(different).toEqual([]);
	});
});
