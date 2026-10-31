import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { findFramework, listProfiles } from "../src/ron/framework.js";
import { registerAllTools } from "../src/tools/index.js";
import { ALL_MODULES, DEFAULT_MODULES } from "../src/types.js";
import { type Fixture, createFixture } from "./helpers/fixtures.js";
import { createFakeManager, createFakeServer, testConfig } from "./helpers/harness.js";
import { PYTHON } from "./helpers/python.js";

describe("modules", () => {
	it("keeps ron off unless it is asked for", () => {
		expect(ALL_MODULES).toContain("ron");
		expect(DEFAULT_MODULES).not.toContain("ron");
		expect(DEFAULT_MODULES.length).toBe(ALL_MODULES.length - 1);
	});
});

describe("findFramework", () => {
	let fx: Fixture;
	beforeEach(() => {
		fx = createFixture();
	});
	afterEach(() => fx.cleanup());

	const config = (extra = {}) => testConfig({ projectPath: "", enginePath: undefined, ...extra });

	it("finds the framework from its folder, its Tools folder or the script", () => {
		const root = join(fx.toolsDir, "..");
		for (const given of [root, fx.toolsDir, join(fx.toolsDir, "ronfw.py")]) {
			const found = findFramework(config({ ronFrameworkPath: given }));
			expect(found?.script, given).toBe(join(fx.toolsDir, "ronfw.py"));
			expect(found?.root).toBe(root);
		}
	});

	it("finds the framework next to the project", () => {
		expect(findFramework(config({ projectPath: fx.project }))?.toolsDir).toBe(fx.toolsDir);
	});

	it("finds nothing when there is no framework", () => {
		expect(findFramework(config())).toBeUndefined();
		expect(findFramework(config({ ronFrameworkPath: join(fx.root, "nowhere") }))).toBeUndefined();
		expect(
			findFramework(config({ projectPath: join(fx.root, "nowhere", "X.uproject") })),
		).toBeUndefined();
	});

	it("reads the tool's version and setup paths", () => {
		const found = findFramework(config({ ronFrameworkPath: fx.toolsDir }));
		expect(found?.version).toBe("9.9.9");
		expect(found?.paths?.engine_dir).toBe("C:/UE_5.3");
	});

	it("chooses the Python: configured, the engine's own, then the one on PATH", () => {
		expect(
			findFramework(config({ ronFrameworkPath: fx.toolsDir, ronPython: "/x/py" }))?.python,
		).toBe("/x/py");

		const engine = mkdtempSync(join(tmpdir(), "mcp engine "));
		try {
			const bundled = join(
				engine,
				"Engine",
				"Binaries",
				"ThirdParty",
				"Python3",
				"Win64",
				"python.exe",
			);
			mkdirSync(join(bundled, ".."), { recursive: true });
			writeFileSync(bundled, "");
			expect(
				findFramework(config({ ronFrameworkPath: fx.toolsDir, enginePath: engine }))?.python,
			).toBe(bundled);
		} finally {
			rmSync(engine, { recursive: true, force: true });
		}
		expect(findFramework(config({ ronFrameworkPath: fx.toolsDir }))?.python).toMatch(/^python3?$/);
	});

	it("lists profiles, skipping files that are not profiles", () => {
		expect(listProfiles(fx.toolsDir)).toEqual([
			{ name: "MyMap", maps: ["/Game/Mods/Me/MyMap"], pakName: "pakchunk99-Mod_MyMap" },
		]);
		expect(listProfiles(join(fx.root, "nowhere"))).toEqual([]);
	});
});

/** The JSON the ron tools answer with. */
// biome-ignore lint/suspicious/noExplicitAny: test helper reading loosely shaped JSON
type ToolData = Record<string, any>;

describe.skipIf(!PYTHON)("ron tools", () => {
	let fx: Fixture;
	let call: (
		tool: string,
		args?: Record<string, unknown>,
	) => Promise<{ isError?: boolean; data: ToolData }>;

	beforeEach(() => {
		fx = createFixture();
		const { server, tools } = createFakeServer();
		const config = testConfig({
			projectPath: fx.project,
			ronFrameworkPath: fx.toolsDir,
			ronPython: PYTHON,
		});
		registerAllTools(
			server as never,
			createFakeManager({ python: [], calls: [] }) as never,
			config,
		);
		call = async (tool, args = {}) => {
			const registered = tools.get(tool);
			if (!registered) throw new Error(`no tool ${tool}`);
			const result = (await registered.handler(z.object(registered.shape).parse(args))) as {
				isError?: boolean;
				content: { text: string }[];
			};
			return { isError: result.isError, data: JSON.parse(result.content[0].text) };
		};
	});
	afterEach(() => fx.cleanup());

	/** What the fake ronfw.py printed: it echoes its arguments. */
	const echoed = (data: { output_tail: string }) =>
		JSON.parse(data.output_tail.trim().split("\n").pop() ?? "{}");

	it("ron_status describes the framework, the profiles and the protection", async () => {
		const { data, isError } = await call("ron_status");
		expect(isError).toBeUndefined();
		expect(data.framework).toMatchObject({
			script: join(fx.toolsDir, "ronfw.py"),
			version: "9.9.9",
		});
		expect(data.setup_done).toBe(true);
		expect(data.profiles.map((p: { name: string }) => p.name)).toEqual(["MyMap"]);
		expect(data.game_content_found).toBe(true);
		expect(data.protection.protect_linked_content).toBe(true);
	});

	it("ron_check_map runs ronfw check-map in the Tools folder, with UTF-8 output", async () => {
		const { data, isError } = await call("ron_check_map", { map: "MyMap" });
		expect(isError).toBeUndefined();
		expect(data).toMatchObject({ status: "succeeded", exit_code: 0 });
		const out = echoed(data);
		expect(out.argv).toEqual(["check-map", "MyMap"]);
		expect(out.cwd.toLowerCase()).toBe(fx.toolsDir.toLowerCase());
		expect(out.io).toBe("utf-8");
	});

	it("ron_build_map turns options into flags", async () => {
		const plain = await call("ron_build_map", { map: "MyMap" });
		expect(echoed(plain.data).argv).toEqual(["build", "MyMap"]);
		const full = await call("ron_build_map", {
			map: "MyMap",
			iterate: true,
			skip_cook: true,
			no_install: true,
			keep_worldgen: true,
			strict: true,
			no_check: true,
			launch: true,
		});
		expect(echoed(full.data).argv).toEqual([
			"build",
			"MyMap",
			"--iterate",
			"--skip-cook",
			"--no-install",
			"--keep-worldgen",
			"--strict",
			"--no-check",
			"--launch",
		]);
	});

	it("ron_light_map, ron_conflicts, ron_official_levels and ron_testmode pass the right arguments", async () => {
		expect(
			echoed(
				(
					await call("ron_light_map", {
						map: "MyMap",
						quality: "preview",
						keep_open: true,
						timeout_minutes: 30,
					})
				).data,
			).argv,
		).toEqual(["light", "MyMap", "--quality", "preview", "--timeout", "30", "--keep-open"]);
		expect(echoed((await call("ron_conflicts", { show: 3 })).data).argv).toEqual([
			"conflicts",
			"--show",
			"3",
		]);
		expect(echoed((await call("ron_official_levels", { check: true })).data).argv).toEqual([
			"official",
			"--list",
			"--check",
		]);
		expect(
			echoed((await call("ron_testmode", { action: "on", maps: ["MyMap", "Other"] })).data).argv,
		).toEqual(["testmode", "on", "MyMap", "Other"]);
		expect(
			echoed((await call("ron_testmode", { action: "status", maps: ["Ignored"] })).data).argv,
		).toEqual(["testmode", "status"]);
		expect(echoed((await call("ron_verify_content")).data).argv).toEqual(["verify-content"]);
	});

	it("reports a failing command as an error, with its exit code and output", async () => {
		const { data, isError } = await call("ron_run", {
			command: "check-refs",
			args: ["MyMap", "--fail"],
		});
		expect(isError).toBe(true);
		expect(data).toMatchObject({ status: "failed", exit_code: 3 });
		expect(data.output_tail).toContain("--fail");
	});

	it("ron_run passes arguments with spaces through as they are", async () => {
		const { data } = await call("ron_run", {
			command: "official",
			args: ["Neon Tomb", "--name", "My Copy"],
		});
		expect(echoed(data).argv).toEqual(["official", "Neon Tomb", "--name", "My Copy"]);
	});

	it("ron_run only allows safe live commands", async () => {
		expect((await call("ron_run", { command: "live", args: ["status"] })).isError).toBeUndefined();
		const refused = await call("ron_run", { command: "live", args: ["run", "import os"] });
		expect(refused.isError).toBe(true);
		expect(refused.data.error).toMatch(/execute_python/);
		expect((await call("ron_run", { command: "live", args: [] })).isError).toBe(true);
	});

	it("rejects commands and map names that are not allowed", async () => {
		await expect(call("ron_run", { command: "setup" })).rejects.toThrow();
		await expect(call("ron_run", { command: "export-game" })).rejects.toThrow();
		await expect(call("ron_check_map", { map: "--force" })).rejects.toThrow();
		await expect(call("ron_check_map", { map: "../outside" })).rejects.toThrow();
		await expect(call("ron_build_map", { map: "" })).rejects.toThrow();
		await expect(call("ron_run", { command: "bake", args: ["a\nb"] })).rejects.toThrow();
	});

	it("hands back a job for a command that is still running, and follows it", async () => {
		const started = await call("ron_run", {
			command: "view",
			args: ["--sleep", "1.2"],
			wait_seconds: 0,
		});
		expect(started.data.status).toBe("running");
		expect(started.data.hint).toContain(started.data.job_id);

		const listed = await call("ron_job", { action: "list" });
		expect(listed.data.jobs.map((j: { id: string }) => j.id)).toContain(started.data.job_id);

		const finished = await call("ron_job", {
			action: "wait",
			job_id: started.data.job_id,
			wait_seconds: 20,
		});
		expect(finished.data.status).toBe("succeeded");
		expect(echoed(finished.data).argv).toEqual(["view", "--sleep", "1.2"]);
	});

	it("cancels a running job", async () => {
		const started = await call("ron_run", {
			command: "view",
			args: ["--sleep", "30"],
			wait_seconds: 0,
		});
		const cancelled = await call("ron_job", { action: "cancel", job_id: started.data.job_id });
		expect(cancelled.data.status).toBe("cancelled");
		expect(cancelled.isError).toBe(true);
	});

	it("ron_job needs a job id and knows when there is none", async () => {
		expect((await call("ron_job", { action: "status" })).isError).toBe(true);
		const unknown = await call("ron_job", { action: "status", job_id: "job-9999" });
		expect(unknown.isError).toBe(true);
		expect(unknown.data.error).toContain("job-9999");
	});
});

describe("ron tools without a framework", () => {
	it("explains what to configure", async () => {
		const { server, tools } = createFakeServer();
		const config = testConfig({ projectPath: "", ronFrameworkPath: undefined });
		registerAllTools(
			server as never,
			createFakeManager({ python: [], calls: [] }) as never,
			config,
		);
		for (const [tool, args] of [
			["ron_status", {}],
			["ron_check_map", { map: "MyMap" }],
		] as const) {
			const registered = tools.get(tool);
			const result = (await registered?.handler(z.object(registered?.shape ?? {}).parse(args))) as {
				isError?: boolean;
				content: { text: string }[];
			};
			expect(result.isError, tool).toBe(true);
			expect(JSON.parse(result.content[0].text)).toMatchObject({
				error: "RON_FRAMEWORK_NOT_FOUND",
			});
			expect(result.content[0].text).toContain("ronFrameworkPath");
		}
	});
});
