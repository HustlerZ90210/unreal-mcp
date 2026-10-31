import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { registerAllTools } from "../src/tools/index.js";
import { API_MANIFEST } from "../src/tools/api-manifest.js";
import { registerDiagnosticsTools } from "../src/tools/diagnostics.js";
import { collectScripts, createFakeManager, createFakeServer, testConfig } from "./helpers/harness.js";
import { PYTHON } from "./helpers/python.js";

describe("api manifest", () => {
	it("lists every unreal.* name the tools use (regenerate with npm run api:manifest)", async () => {
		const { scripts } = await collectScripts(registerAllTools as never, testConfig(), "plain");
		const used = new Map<string, Set<string>>();
		for (const s of scripts) {
			if (s.tool === "execute_python") continue;
			for (const m of s.python.matchAll(/\bunreal\.([A-Za-z_]\w*)/g)) {
				if (!used.has(s.tool)) used.set(s.tool, new Set());
				used.get(s.tool)?.add(m[1]);
			}
		}
		const stale: string[] = [];
		for (const [tool, names] of used) {
			const known = new Set(API_MANIFEST.symbols[tool] ?? []);
			for (const name of names) {
				if (!known.has(name)) stale.push(`${tool}: unreal.${name}`);
			}
		}
		expect(stale).toEqual([]);
	});

	it("only names tools that exist", async () => {
		const { scripts } = await collectScripts(registerAllTools as never, testConfig(), "plain");
		const tools = new Set(scripts.map((s) => s.tool));
		const unknown = [...Object.keys(API_MANIFEST.tools), ...Object.keys(API_MANIFEST.symbols)].filter(
			(t) => !tools.has(t),
		);
		expect(unknown).toEqual([]);
	});

	it("only gates APIs the tool is known to use", () => {
		for (const [tool, apis] of Object.entries(API_MANIFEST.gated)) {
			const pairs = new Set((API_MANIFEST.tools[tool] ?? []).map(([c, m]) => `${c}.${m}`));
			for (const api of apis) expect(pairs.has(api), `${tool} ${api}`).toBe(true);
		}
	});
});

/** Run the check_ue_compat script in plain Python against a fake `unreal` module. */
function runCompatCheck(options: { remove: string[] }): Record<string, unknown> {
	const { server, tools } = createFakeServer();
	const recorded: string[] = [];
	const manager = createFakeManager({ python: recorded, calls: [] });
	registerDiagnosticsTools(server as never, manager as never, testConfig());
	const tool = tools.get("check_ue_compat");
	if (!tool) throw new Error("check_ue_compat is not registered");
	return tool.handler({}).then(() => {
		const harness = String.raw`
import json, sys, types
cfg = json.loads(sys.stdin.read())
unreal = types.ModuleType("unreal")
manifest = cfg["manifest"]
removed = set(cfg["remove"])

members = {"SystemLibrary": set()}
for pairs in manifest["tools"].values():
    for cls, member in pairs:
        members.setdefault(cls, set()).add(member)
for cls, names in members.items():
    if cls in removed:
        continue
    attrs = {m: staticmethod(lambda *a: None) for m in names if cls + "." + m not in removed}
    if cls == "SystemLibrary":
        attrs["get_engine_version"] = staticmethod(lambda: "5.3.2-29314046+++UE5+Release-5.3")
    setattr(unreal, cls, type(cls, (), attrs))
for symbols in manifest["symbols"].values():
    for s in symbols:
        if not hasattr(unreal, s) and s not in removed:
            setattr(unreal, s, type(s, (), {}))
sys.modules["unreal"] = unreal
exec(compile(cfg["script"], "check_ue_compat", "exec"), {"__name__": "__main__"})
`;
		const run = spawnSync(PYTHON as string, ["-I", "-c", harness], {
			input: JSON.stringify({ script: recorded[0], manifest: API_MANIFEST, remove: options.remove }),
			encoding: "utf-8",
		});
		if (run.status !== 0) throw new Error(run.stderr);
		return JSON.parse(run.stdout);
	}) as unknown as Record<string, unknown>;
}

describe.skipIf(!PYTHON)("check_ue_compat", () => {
	it("passes when the engine has every API", async () => {
		const result = await runCompatCheck({ remove: [] });
		expect(result).toMatchObject({
			ok: true,
			same_minor_version: true,
			checked_against: API_MANIFEST.version,
			tools_that_will_fail: [],
			missing: [],
		});
		expect(result.apis_checked as number).toBeGreaterThan(100);
	});

	it("names the tools that call an API the engine lacks", async () => {
		const result = (await runCompatCheck({
			remove: ["EditorAssetLibrary.save_asset"],
		})) as { ok: boolean; missing: { api: string; tools: string[] }[]; tools_that_will_fail: string[] };
		expect(result.ok).toBe(false);
		expect(result.missing.map((m) => m.api)).toEqual(["unreal.EditorAssetLibrary.save_asset"]);
		expect(result.missing[0].tools).toContain("generate_lods");
		expect(result.tools_that_will_fail).toEqual(result.missing[0].tools);
	});

	it("reports a missing class once per tool, and a missing module symbol", async () => {
		const result = (await runCompatCheck({ remove: ["StaticMesh"] })) as {
			missing: { api: string }[];
		};
		expect(result.missing.map((m) => m.api)).toContain("unreal.StaticMesh");
	});

	it("treats version-gated APIs as informational, not as failures", async () => {
		const gated = Object.values(API_MANIFEST.gated).flat();
		expect(gated.length).toBeGreaterThan(0);
		const result = (await runCompatCheck({ remove: gated })) as {
			ok: boolean;
			missing: unknown[];
			version_gated: { api: string; tools: string[] }[];
		};
		expect(result.ok).toBe(true);
		expect(result.missing).toEqual([]);
		expect(result.version_gated.map((g) => g.api).sort()).toEqual(
			gated.map((g) => `unreal.${g}`).sort(),
		);
	});
});
