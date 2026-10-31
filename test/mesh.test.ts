import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { registerAllTools } from "../src/tools/index.js";
import { type Fixture, createFixture } from "./helpers/fixtures.js";
import {
	type Recording,
	type ToolData,
	createFakeManager,
	createFakeServer,
	testConfig,
} from "./helpers/harness.js";
import { PYTHON } from "./helpers/python.js";

function setup(config = testConfig()) {
	const { server, tools } = createFakeServer();
	const recording: Recording = { python: [], calls: [] };
	registerAllTools(server as never, createFakeManager(recording) as never, config);
	const call = async (tool: string, args: Record<string, unknown>) => {
		const registered = tools.get(tool);
		if (!registered) throw new Error(`no tool ${tool}`);
		const parsed = z.object(registered.shape).parse(args);
		const result = (await registered.handler(parsed)) as {
			isError?: boolean;
			content: { text: string }[];
		};
		return {
			isError: result.isError,
			text: result.content[0].text,
			script: recording.python.at(-1),
		};
	};
	return { call, tools, recording };
}

describe("import_fbx", () => {
	const required = { source_file: "C:/Export/Crate.fbx", destination_path: "/Game/Mods/Me/Meshes" };

	it("only changes the options it is given", async () => {
		const { script } = await setup().call("import_fbx", required);
		expect(script).toContain("task.filename = 'C:/Export/Crate.fbx'");
		expect(script).toContain("task.destination_path = '/Game/Mods/Me/Meshes'");
		expect(script).toContain("task.replace_existing = False");
		expect(script).toContain("task.save = True");
		for (const untouched of [
			"combine_meshes",
			"auto_generate_collision",
			"generate_lightmap_u_vs",
			"normal_import_method",
			"import_uniform_scale",
			"convert_scene_unit",
			"build_nanite",
			"options.import_materials",
			"options.create_physics_asset",
		]) {
			expect(script, untouched).not.toContain(`${untouched} =`);
		}
	});

	it("writes the options that were passed as Python values", async () => {
		const { script } = await setup().call("import_fbx", {
			...required,
			replace_existing: true,
			combine_meshes: false,
			auto_generate_collision: false,
			generate_lightmap_uvs: false,
			import_mesh_lods: true,
			build_nanite: true,
			normals: "import_with_tangents",
			vertex_colors: "ignore",
			convert_scene_unit: true,
			import_uniform_scale: 0.01,
			import_materials: false,
			expected_max_dimension_cm: 250,
		});
		for (const line of [
			"task.replace_existing = True",
			"data.combine_meshes = False",
			"data.auto_generate_collision = False",
			"data.generate_lightmap_u_vs = False",
			"data.import_mesh_lo_ds = True",
			"data.build_nanite = True",
			"data.normal_import_method = NORMALS['import_with_tangents']",
			"data.vertex_color_import_option = VERTEX_COLORS['ignore']",
			"data.convert_scene_unit = True",
			"data.import_uniform_scale = 0.01",
			"options.import_materials = False",
			"mcp_mesh_summary(asset, 250)",
		]) {
			expect(script, line).toContain(line);
		}
	});

	it("keeps mesh-only options out of animation imports", async () => {
		const { script } = await setup().call("import_fbx", {
			...required,
			kind: "animation",
			skeleton_path: "/Game/Mods/Me/Rigs/SK_Hero_Skeleton",
			normals: "import",
			combine_meshes: true,
		});
		const animation = script?.slice(script.indexOf("    else:\n        if skeleton is None")) ?? "";
		expect(animation).toContain(
			"options.mesh_type_to_import = unreal.FBXImportType.FBXIT_ANIMATION",
		);
		expect(animation).not.toContain("normal_import_method");
		expect(animation).not.toContain("combine_meshes");
	});

	it("turns away files that are not FBX, and animations without a skeleton", async () => {
		const { call } = setup();
		await expect(
			call("import_fbx", { ...required, source_file: "C:/Export/Crate.obj" }),
		).rejects.toThrow(/fbx/i);
		const animation = await call("import_fbx", { ...required, kind: "animation" });
		expect(animation.isError).toBe(true);
		expect(animation.text).toContain("skeleton_path");
	});

	it("keeps hostile text inside the string literals", async () => {
		const { script } = await setup().call("import_fbx", {
			source_file: 'C:/Ex\'port/"x"\\Crate.fbx',
			destination_path: "/Game/Mods/Me/';import os;'",
			name: "a'b",
		});
		expect(script).toContain("task.filename = 'C:/Ex\\'port/\\\"x\\\"\\\\Crate.fbx'");
		expect(script).toContain("task.destination_name = 'a\\'b'");
	});

	describe("in a project with linked game content", () => {
		let fx: Fixture;
		beforeEach(() => {
			fx = createFixture();
		});
		afterEach(() => fx.cleanup());

		it("refuses to import into a game folder", async () => {
			const { call, recording } = setup(
				testConfig({ projectPath: fx.project, ronFrameworkPath: fx.toolsDir }),
			);
			const blocked = await call("import_fbx", {
				source_file: "C:/Export/Crate.fbx",
				destination_path: "/Game/ReadyOrNot/Props",
			});
			expect(blocked.isError).toBe(true);
			expect(JSON.parse(blocked.text).error).toBe("PROTECTED_CONTENT");
			expect(recording.python).toEqual([]);
			const allowed = await call("import_fbx", {
				source_file: "C:/Export/Crate.fbx",
				destination_path: "/Game/Mods/Me/Meshes",
			});
			expect(allowed.isError).toBeUndefined();
		});
	});
});

describe.skipIf(!PYTHON)("inspect_static_mesh", () => {
	const HARNESS = String.raw`
import json, sys, types
cfg = json.loads(sys.stdin.read())
spec = cfg["mesh"]
unreal = types.ModuleType("unreal")

class Vec:
    def __init__(self, x, y, z): self.x, self.y, self.z = x, y, z
class Bounds:
    def __init__(self):
        self.box_extent = Vec(*spec["extent"]); self.origin = Vec(*spec["origin"])
class Slot:
    def __init__(self, name): self.material_slot_name = name
class StaticMesh:
    static_materials = [Slot(n) for n in spec["slots"]]
    def get_bounds(self): return Bounds()
    def get_num_triangles(self, i): return spec["lods"][i]["triangles"]
    def get_num_sections(self, i): return spec["lods"][i]["sections"]
    props = {"light_map_coordinate_index": spec["lightIndex"], "light_map_resolution": spec["lightResolution"]}
    def get_editor_property(self, name): return StaticMesh.props[name]
    def set_editor_property(self, name, value): StaticMesh.props[name] = value
class CollisionTraceFlag:
    CTF_USE_DEFAULT = "CTF_USE_DEFAULT"
    CTF_USE_COMPLEX_AS_SIMPLE = "CTF_USE_COMPLEX_AS_SIMPLE"
class Nanite:
    enabled = spec["nanite"]
class Lib:
    def get_lod_count(self, m): return len(spec["lods"])
    def get_number_verts(self, m, i): return spec["lods"][i]["vertices"]
    def get_num_uv_channels(self, m, i): return spec["lods"][i]["uv"]
    def get_simple_collision_count(self, m): return spec["simple"]
    def get_convex_collision_count(self, m): return spec["convex"]
    def get_collision_complexity(self, m): return getattr(CollisionTraceFlag, spec["complexity"])
    def get_nanite_settings(self, m): return Nanite()
class StaticMeshEditorSubsystem: pass
saved = []
class EditorAssetLibrary:
    @staticmethod
    def load_asset(path): return StaticMesh() if spec.get("exists", True) else None
    @staticmethod
    def save_asset(path):
        saved.append(path)
        return True
unreal.StaticMesh = StaticMesh
unreal.CollisionTraceFlag = CollisionTraceFlag
unreal.StaticMeshEditorSubsystem = StaticMeshEditorSubsystem
unreal.EditorAssetLibrary = EditorAssetLibrary
unreal.get_editor_subsystem = lambda cls: Lib()
sys.modules["unreal"] = unreal
import contextlib, io
buffer = io.StringIO()
with contextlib.redirect_stdout(buffer):
    exec(compile(cfg["script"], "tool", "exec"), {"__name__": "__main__"})
print(json.dumps(json.loads(buffer.getvalue())))
if cfg.get("report_saved"):
    print(json.dumps({"saved": saved}))
`;

	/** Run a tool's script against the fake editor; returns each JSON line it printed. */
	async function runTool(
		tool: string,
		args: Record<string, unknown>,
		mesh: Record<string, unknown> = {},
	): Promise<ToolData[]> {
		const { call } = setup();
		const { script } = await call(tool, args);
		const spec = {
			extent: [50, 25, 10],
			origin: [0, 0, 5],
			lods: [{ vertices: 100, triangles: 200, uv: 2, sections: 1 }],
			simple: 1,
			convex: 1,
			complexity: "CTF_USE_DEFAULT",
			lightIndex: 1,
			lightResolution: 64,
			slots: ["M_Wood"],
			nanite: false,
			...mesh,
		};
		const run = spawnSync(PYTHON as string, ["-I", "-c", HARNESS], {
			input: JSON.stringify({ script, mesh: spec, report_saved: tool === "set_lightmap_settings" }),
			encoding: "utf-8",
		});
		if (run.status !== 0) throw new Error(run.stderr);
		return run.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	}

	async function run(mesh: Record<string, unknown> = {}, expected?: number): Promise<ToolData> {
		const [summary] = await runTool(
			"inspect_static_mesh",
			{
				mesh_path: "/Game/Meshes/SM_Crate",
				...(expected ? { expected_max_dimension_cm: expected } : {}),
			},
			mesh,
		);
		return summary;
	}

	it("describes a healthy mesh without warnings", async () => {
		const summary = await run();
		expect(summary).toMatchObject({
			path: "/Game/Meshes/SM_Crate",
			size_cm: [100, 50, 20],
			origin_cm: [0, 0, 5],
			materials: ["M_Wood"],
			collision: { simple: 1, convex: 1, complexity: "CTF_USE_DEFAULT" },
			lightmap: { coordinate_index: 1, resolution: 64 },
			nanite: false,
			warnings: [],
		});
		expect(summary.lods).toEqual([
			{ lod: 0, vertices: 100, triangles: 200, sections: 1, uv_channels: 2 },
		]);
	});

	it("says when the asset is not a static mesh", async () => {
		expect(await run({ exists: false })).toEqual({
			error: "StaticMesh not found: /Game/Meshes/SM_Crate",
		});
	});

	it("warns about missing collision, unless complex collision is the simple one", async () => {
		expect((await run({ simple: 0 })).warnings.join(" ")).toMatch(/No simple collision/);
		expect((await run({ simple: 0, complexity: "CTF_USE_COMPLEX_AS_SIMPLE" })).warnings).toEqual(
			[],
		);
	});

	it("warns about lightmap UVs that cannot work", async () => {
		const outside = (await run({ lightIndex: 2 })).warnings.join(" ");
		expect(outside).toMatch(/Lightmap Coordinate Index 2 is outside the mesh's 2 UV channels/);
		const single = (
			await run({ lods: [{ vertices: 8, triangles: 12, uv: 1, sections: 1 }], lightIndex: 0 })
		).warnings.join(" ");
		expect(single).toMatch(/only channel/);
		const first = (await run({ lightIndex: 0 })).warnings.join(" ");
		expect(first).toMatch(/Index is 0 but the mesh has 2 UV channels.*last one \(index 1\)/);
	});

	it("warns about a size that points to a unit mix-up", async () => {
		expect((await run({ extent: [40000, 100, 100] })).warnings.join(" ")).toMatch(/over 500 m/);
		expect((await run({ extent: [0.2, 0.2, 0.2] })).warnings.join(" ")).toMatch(/under 1 cm/);
	});

	it("compares the size with the one you expect", async () => {
		// the largest dimension is 100 cm
		expect((await run({}, 100)).warnings).toEqual([]);
		expect((await run({}, 150)).warnings).toEqual([]);
		const tooBig = (await run({}, 1)).warnings.join(" ");
		expect(tooBig).toMatch(
			/Largest dimension is 100\.0 cm, expected about 1\.0 cm: a factor of 100 \(about 100 times: meters against centimeters\)/,
		);
		const tooSmall = (await run({}, 10000)).warnings.join(" ");
		expect(tooSmall).toMatch(/a factor of 0\.01 \(about 100 times/);
		expect((await run({}, 20)).warnings.join(" ")).toMatch(/a factor of 5\./);
	});

	it("warns about a dense mesh with a single LOD, and reports every LOD", async () => {
		const dense = await run({ lods: [{ vertices: 20000, triangles: 30000, uv: 2, sections: 2 }] });
		expect(dense.warnings.join(" ")).toMatch(/30000 triangles with a single LOD/);
		const chain = await run({
			lods: [
				{ vertices: 20000, triangles: 30000, uv: 2, sections: 2 },
				{ vertices: 9000, triangles: 15000, uv: 2, sections: 2 },
			],
		});
		expect(chain.warnings).toEqual([]);
		expect(chain.lods.map((l: { triangles: number }) => l.triangles)).toEqual([30000, 15000]);
	});

	describe("set_lightmap_settings", () => {
		const base = { mesh_path: "/Game/Meshes/SM_Crate" };

		it("points the lightmap at the last UV channel", async () => {
			const [result, saved] = await runTool(
				"set_lightmap_settings",
				{ ...base, use_last_uv_channel: true },
				{ lods: [{ vertices: 8, triangles: 12, uv: 3, sections: 1 }], lightIndex: 0 },
			);
			expect(result).toMatchObject({
				success: true,
				uv_channels: 3,
				lightmap: { coordinate_index: 2, resolution: 64 },
			});
			expect(saved).toEqual({ saved: ["/Game/Meshes/SM_Crate"] });
		});

		it("sets an index and a resolution, and can skip saving", async () => {
			const [result, saved] = await runTool("set_lightmap_settings", {
				...base,
				coordinate_index: 1,
				resolution: 256,
				save: false,
			});
			expect(result.lightmap).toEqual({ coordinate_index: 1, resolution: 256 });
			expect(saved).toEqual({ saved: [] });
		});

		it("changes only the resolution when no channel is named", async () => {
			const [result] = await runTool(
				"set_lightmap_settings",
				{ ...base, resolution: 128 },
				{ lightIndex: 1 },
			);
			expect(result.lightmap).toEqual({ coordinate_index: 1, resolution: 128 });
		});

		it("refuses a channel the mesh does not have, and changes nothing", async () => {
			const [result, saved] = await runTool("set_lightmap_settings", {
				...base,
				coordinate_index: 5,
				resolution: 256,
			});
			expect(result.error).toMatch(/Index 5 is outside the mesh's 2 UV channels \(0 to 1\)/);
			expect(saved).toEqual({ saved: [] });
		});

		it("says when the asset is not a static mesh", async () => {
			const [result] = await runTool(
				"set_lightmap_settings",
				{ ...base, resolution: 64 },
				{ exists: false },
			);
			expect(result.error).toContain("StaticMesh not found");
		});

		it("needs something to change, and one way to name the channel", async () => {
			const { call } = setup();
			const nothing = await call("set_lightmap_settings", { ...base, use_last_uv_channel: false });
			expect(nothing.isError).toBe(true);
			const both = await call("set_lightmap_settings", {
				...base,
				coordinate_index: 1,
				use_last_uv_channel: true,
			});
			expect(both.isError).toBe(true);
		});
	});
});
