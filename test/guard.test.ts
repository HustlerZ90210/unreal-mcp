import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WRITE_PARAMS } from "../src/tools/guard.js";
import { registerAllTools } from "../src/tools/index.js";
import { type Fixture, createFixture } from "./helpers/fixtures.js";
import {
	type Recording,
	collectScripts,
	createFakeManager,
	createFakeServer,
	testConfig,
} from "./helpers/harness.js";

/** Calls in a tool's script that save, create, rename or delete assets. */
const WRITES =
	/\b(save_asset|save_loaded_asset|save_directory|create_asset|delete_asset|rename_asset|duplicate_asset|import_asset_tasks|consolidate_assets)\b/;

describe("write protection of the tools", () => {
	it("covers every tool whose script saves, creates, renames or deletes assets", async () => {
		const { scripts } = await collectScripts(registerAllTools as never, testConfig(), "plain");
		const writers = [...new Set(scripts.filter((s) => WRITES.test(s.python)).map((s) => s.tool))];
		expect(writers.length).toBeGreaterThan(15);
		// check_ue_compat only names these functions to look for them
		const uncovered = writers.filter((tool) => tool !== "check_ue_compat" && !WRITE_PARAMS[tool]);
		expect(uncovered).toEqual([]);
	});

	it("only names tools and parameters that exist", () => {
		const { server, tools } = createFakeServer();
		const recording: Recording = { python: [], calls: [] };
		registerAllTools(server as never, createFakeManager(recording) as never, testConfig());
		for (const [tool, params] of Object.entries(WRITE_PARAMS)) {
			const registered = tools.get(tool);
			expect(registered, `tool ${tool}`).toBeDefined();
			for (const param of params) {
				expect(Object.keys(registered?.shape ?? {}), `${tool}.${param.name}`).toContain(param.name);
			}
		}
	});

	describe("on a project with linked game content", () => {
		let fx: Fixture;
		let recording: Recording;
		let call: (
			tool: string,
			args: Record<string, unknown>,
		) => Promise<{ isError?: boolean; text: string }>;

		beforeEach(() => {
			fx = createFixture();
			recording = { python: [], calls: [] };
			const { server, tools } = createFakeServer();
			const config = testConfig({ projectPath: fx.project, ronFrameworkPath: fx.toolsDir });
			registerAllTools(server as never, createFakeManager(recording) as never, config);
			call = async (tool, args) => {
				const registered = tools.get(tool);
				if (!registered) throw new Error(`no tool ${tool}`);
				const parsed = z.object(registered.shape).parse(args);
				const result = (await registered.handler(parsed)) as {
					isError?: boolean;
					content: { text: string }[];
				};
				return { isError: result.isError, text: result.content[0].text };
			};
		});
		afterEach(() => fx.cleanup());

		it("refuses to delete a game asset and runs nothing", async () => {
			const result = await call("delete_asset", { asset_path: "/Game/ReadyOrNot/Props/Chair" });
			expect(result.isError).toBe(true);
			expect(JSON.parse(result.text)).toMatchObject({ error: "PROTECTED_CONTENT" });
			expect(result.text).toMatch(/hard-linked|exported game content/);
			expect(recording.python).toEqual([]);
		});

		it("lets the mapper's own assets through", async () => {
			const result = await call("delete_asset", { asset_path: "/Game/Mods/Me/Props/Crate" });
			expect(result.isError).toBeUndefined();
			expect(recording.python).toHaveLength(1);
		});

		it("checks both ends of a rename, and only the destination of a copy", async () => {
			const move = await call("rename_asset", {
				source_path: "/Game/ReadyOrNot/Props/Chair",
				destination_path: "/Game/Mods/Me/Chair",
			});
			expect(move.isError).toBe(true);
			const copy = await call("duplicate_asset", {
				source_path: "/Game/ReadyOrNot/Props/Chair",
				destination_path: "/Game/Mods/Me/Chair",
			});
			expect(copy.isError).toBeUndefined();
			const copyOver = await call("duplicate_asset", {
				source_path: "/Game/Mods/Me/Props/Crate",
				destination_path: "/Game/ReadyOrNot/Props/Chair",
			});
			expect(copyOver.isError).toBe(true);
		});

		it("refuses to create assets in a game folder", async () => {
			const blocked = await call("create_blueprint", {
				name: "BP_X",
				path: "/Game/ReadyOrNot/Props",
			});
			expect(blocked.isError).toBe(true);
			const allowed = await call("create_blueprint", {
				name: "BP_X",
				path: "/Game/Mods/Me/Blueprints",
			});
			expect(allowed.isError).toBeUndefined();
		});

		it("refuses to edit and save a game blueprint, material or mesh", async () => {
			for (const [tool, args] of [
				["compile_blueprint", { blueprint_path: "/Game/ReadyOrNot/Props/Chair" }],
				["recompile_material", { material_path: "/Game/ReadyOrNot/Props/Chair" }],
				["generate_lods", { mesh_path: "/Game/ReadyOrNot/Props/Chair", lod_count: 3 }],
				["save_asset", { asset_path: "/Game/ReadyOrNot/Props/Chair" }],
			] as const) {
				const result = await call(tool, { ...args });
				expect(result.isError, tool).toBe(true);
			}
			expect(recording.python).toEqual([]);
		});

		it("checks every source of a consolidation", async () => {
			const result = await call("consolidate_assets", {
				target_path: "/Game/Mods/Me/Props/Crate",
				source_paths: ["/Game/Mods/Me/MyMap", "/Game/ReadyOrNot/Props/Chair"],
			});
			expect(result.isError).toBe(true);
		});

		it("treats a resave of the whole project as covering the game content", async () => {
			const everything = await call("resave_packages", {});
			expect(everything.isError).toBe(true);
			const mine = await call("resave_packages", { directory: "/Game/Mods/Me" });
			expect(mine.isError).toBeUndefined();
			expect(recording.calls.filter((c) => c.method === "runCommandlet")).toHaveLength(1);
		});

		it("does not touch tools that only read", async () => {
			const result = await call("get_asset_info", { asset_path: "/Game/ReadyOrNot/Props/Chair" });
			expect(result.isError).toBeUndefined();
			expect(recording.python).toHaveLength(1);
		});
	});

	it("does nothing to a project without linked content", async () => {
		const fx = createFixture({ withTools: false });
		try {
			const recording: Recording = { python: [], calls: [] };
			const { server, tools } = createFakeServer();
			const config = testConfig({ projectPath: fx.project, protectLinkedContent: false });
			registerAllTools(server as never, createFakeManager(recording) as never, config);
			const tool = tools.get("delete_asset");
			if (!tool) throw new Error("no delete_asset");
			const run = (path: string) =>
				tool.handler(z.object(tool.shape).parse({ asset_path: path })) as Promise<{
					isError?: boolean;
				}>;
			await run("/Game/ReadyOrNot/Props/Chair");
			expect(recording.python).toHaveLength(1);
			// engine content stays protected regardless
			expect((await run("/Engine/BasicShapes/Cube")).isError).toBe(true);
		} finally {
			fx.cleanup();
		}
	});
});
