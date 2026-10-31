import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionManager } from "../transports/connection-manager.js";
import type { UnrealMcpConfig } from "../types.js";
import { inlineScript } from "../utils/template.js";

/**
 * Bringing meshes from a modelling tool (Blender) into Unreal and checking what arrived.
 *
 * The exporting half lives in the modelling tool: MifBlender's export_mesh writes a centimeter FBX with
 * UCX_ collision hulls, a lightmap UV layer and LOD groups. These tools are the other half: import it
 * with the options that matter, then read back the things that usually go wrong - scale, collision,
 * lightmap UVs, LODs - instead of finding out in the level.
 */

/**
 * Python shared by both tools. Everything it calls is checked against the UE 5.3 Python API
 * (npm run check:ue-api).
 */
const MESH_SUMMARY_PY = `def mcp_mesh_summary(mesh, expected_max_cm=0):
    lib = unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)
    bounds = mesh.get_bounds()
    size = [round(v * 2.0, 2) for v in (bounds.box_extent.x, bounds.box_extent.y, bounds.box_extent.z)]
    lods = []
    for i in range(lib.get_lod_count(mesh)):
        lods.append({
            "lod": i,
            "vertices": lib.get_number_verts(mesh, i),
            "triangles": mesh.get_num_triangles(i),
            "sections": mesh.get_num_sections(i),
            "uv_channels": lib.get_num_uv_channels(mesh, i),
        })
    simple = lib.get_simple_collision_count(mesh)
    convex = lib.get_convex_collision_count(mesh)
    complexity = lib.get_collision_complexity(mesh)
    light_index = mesh.get_editor_property('light_map_coordinate_index')
    light_resolution = mesh.get_editor_property('light_map_resolution')
    slots = [str(m.material_slot_name) for m in mesh.static_materials]
    channels = lods[0]["uv_channels"] if lods else 0
    biggest = max(size) if size else 0

    warnings = []
    if simple == 0 and complexity != unreal.CollisionTraceFlag.CTF_USE_COMPLEX_AS_SIMPLE:
        warnings.append("No simple collision. Author UCX_ hulls in the modelling tool, or add collision here.")
    if light_index >= channels:
        warnings.append("Lightmap Coordinate Index %d is outside the mesh's %d UV channels." % (light_index, channels))
    elif channels < 2:
        warnings.append("Lightmaps use UV channel 0, the only channel. That is only right if it has no overlapping or tiled UVs.")
    elif light_index == 0:
        warnings.append("Lightmap Coordinate Index is 0 but the mesh has %d UV channels. If a lightmap UV was authored it is usually the last one (index %d)." % (channels, channels - 1))
    if biggest > 50000:
        warnings.append("The mesh is %.0f cm across, over 500 m. A file in meters imported as centimeters (or the other way round) is the usual cause." % biggest)
    elif 0 < biggest < 1:
        warnings.append("The mesh is under 1 cm across. A file in centimeters imported as meters is the usual cause.")
    if expected_max_cm > 0 and biggest > 0:
        ratio = biggest / expected_max_cm
        if ratio > 2 or ratio < 0.5:
            hint = " (about 100 times: meters against centimeters)" if 90 < ratio < 110 or 0.009 < ratio < 0.011 else ""
            warnings.append("Largest dimension is %.1f cm, expected about %.1f cm: a factor of %.3g%s." % (biggest, expected_max_cm, ratio, hint))
    if lods and len(lods) == 1 and lods[0]["triangles"] > 20000:
        warnings.append("%d triangles with a single LOD." % lods[0]["triangles"])

    return {
        "size_cm": size,
        "origin_cm": [round(v, 2) for v in (bounds.origin.x, bounds.origin.y, bounds.origin.z)],
        "lods": lods,
        "materials": slots,
        "collision": {"simple": simple, "convex": convex, "complexity": str(complexity)},
        "lightmap": {"coordinate_index": light_index, "resolution": light_resolution},
        "nanite": lib.get_nanite_settings(mesh).enabled,
        "warnings": warnings,
    }
`;

function reply(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function fail(message: string) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
		isError: true,
	};
}

export function registerMeshTools(
	server: McpServer,
	manager: ConnectionManager,
	_config: UnrealMcpConfig,
): void {
	server.tool(
		"import_fbx",
		"Import an FBX into the project as a static mesh, a skeletal mesh or an animation, with the import options that matter for a file from a modelling tool (collision from UCX_ hulls, lightmap UVs, LODs, scale, normals). Only the options you pass are changed; the rest keep Unreal's defaults. A static mesh comes back with the same check as inspect_static_mesh.",
		{
			source_file: z
				.string()
				.regex(/\.fbx$/i, "Must be an .fbx file (use import_asset for other formats)")
				.describe("Path of the .fbx file on disk"),
			destination_path: z
				.string()
				.min(1)
				.describe("Content folder to import into, e.g. /Game/Mods/YourName/Meshes"),
			kind: z
				.enum(["static_mesh", "skeletal_mesh", "animation"])
				.default("static_mesh")
				.describe("What the file is. An animation needs skeleton_path"),
			name: z.string().optional().describe("Asset name (default: the file's name)"),
			replace_existing: z
				.boolean()
				.default(false)
				.describe("Overwrite an asset of the same name. Off: an existing asset is left alone"),
			save: z.boolean().default(true).describe("Save the imported assets"),
			import_materials: z.boolean().optional().describe("Create materials from the file"),
			import_textures: z.boolean().optional().describe("Import the textures the file references"),
			combine_meshes: z
				.boolean()
				.optional()
				.describe("Static mesh: combine all meshes in the file into one"),
			auto_generate_collision: z
				.boolean()
				.optional()
				.describe("Static mesh: generate collision when the file has no UCX_ hulls"),
			one_convex_hull_per_ucx: z
				.boolean()
				.optional()
				.describe("Static mesh: keep each UCX_ hull as one convex shape instead of splitting it"),
			generate_lightmap_uvs: z
				.boolean()
				.optional()
				.describe(
					"Static mesh: make a lightmap UV channel. Turn off when the file already has one authored as its last UV layer",
				),
			import_mesh_lods: z
				.boolean()
				.optional()
				.describe("Static mesh: import the LODs in the file (<name>_LOD1, ... or an LOD group)"),
			build_nanite: z.boolean().optional().describe("Static mesh: build Nanite data"),
			remove_degenerates: z
				.boolean()
				.optional()
				.describe("Static mesh: remove degenerate triangles"),
			normals: z
				.enum(["compute", "import", "import_with_tangents"])
				.optional()
				.describe("Where normals come from: Unreal computes them, or the file's are used"),
			vertex_colors: z
				.enum(["replace", "ignore"])
				.optional()
				.describe("Static mesh: use the file's vertex colors, or ignore them"),
			convert_scene_unit: z
				.boolean()
				.optional()
				.describe(
					"Convert the file's unit to centimeters. Needed for a file saved in meters; harmless for a centimeter file",
				),
			import_uniform_scale: z
				.number()
				.positive()
				.optional()
				.describe("Scale applied on import (1 = none). Use as a last resort for a wrong-size file"),
			skeleton_path: z
				.string()
				.optional()
				.describe("Skeletal mesh or animation: the existing Skeleton asset to use"),
			create_physics_asset: z
				.boolean()
				.optional()
				.describe("Skeletal mesh: create a physics asset"),
			import_animations: z
				.boolean()
				.optional()
				.describe("Skeletal mesh: also import the animations in the file"),
			expected_max_dimension_cm: z
				.number()
				.positive()
				.optional()
				.describe("Static mesh: how big the largest dimension should be, to flag a wrong scale"),
		},
		async (args) => {
			manager.requireEditor();
			if (args.kind === "animation" && !args.skeleton_path) {
				return fail("An animation needs skeleton_path, the Skeleton asset it is for.");
			}

			const set = (condition: boolean, line: string) => (condition ? [`    ${line}`] : []);
			const has = (value: unknown) => value !== undefined;
			const staticOptions = [
				...set(has(args.combine_meshes), "data.combine_meshes = {{combine_meshes}}"),
				...set(
					has(args.auto_generate_collision),
					"data.auto_generate_collision = {{auto_generate_collision}}",
				),
				...set(
					has(args.one_convex_hull_per_ucx),
					"data.one_convex_hull_per_ucx = {{one_convex_hull_per_ucx}}",
				),
				...set(
					has(args.generate_lightmap_uvs),
					"data.generate_lightmap_u_vs = {{generate_lightmap_uvs}}",
				),
				...set(has(args.import_mesh_lods), "data.import_mesh_lo_ds = {{import_mesh_lods}}"),
				...set(has(args.build_nanite), "data.build_nanite = {{build_nanite}}"),
				...set(has(args.remove_degenerates), "data.remove_degenerates = {{remove_degenerates}}"),
				...set(
					has(args.vertex_colors),
					"data.vertex_color_import_option = VERTEX_COLORS['{{vertex_colors}}']",
				),
			];
			// Mesh import data (static and skeletal) also decides where normals come from
			const meshOptions = [
				...set(has(args.normals), "data.normal_import_method = NORMALS['{{normals}}']"),
			];
			// Options every kind of import data has
			const commonOptions = [
				...set(has(args.convert_scene_unit), "data.convert_scene_unit = {{convert_scene_unit}}"),
				...set(
					has(args.import_uniform_scale),
					"data.import_uniform_scale = {{import_uniform_scale}}",
				),
			];
			const skeletalOptions = [
				...set(
					has(args.create_physics_asset),
					"options.create_physics_asset = {{create_physics_asset}}",
				),
				...set(has(args.import_animations), "options.import_animations = {{import_animations}}"),
			];
			const importFlags = [
				...set(has(args.import_materials), "options.import_materials = {{import_materials}}"),
				...set(has(args.import_textures), "options.import_textures = {{import_textures}}"),
			];

			// "data" is the options object for what is being imported; the options above the kind blocks apply to all.
			const body = [
				"def run():",
				"    task = unreal.AssetImportTask()",
				"    task.filename = '{{source_file}}'",
				"    task.destination_path = '{{destination_path}}'",
				"    task.destination_name = '{{name}}'",
				"    task.automated = True",
				"    task.replace_existing = {{replace_existing}}",
				"    task.save = {{save}}",
				"    options = unreal.FbxImportUI()",
				"    options.automated_import_should_detect_type = False",
				...importFlags,
				"    skeleton = None",
				"    if '{{skeleton_path}}':",
				"        skeleton = unreal.EditorAssetLibrary.load_asset('{{skeleton_path}}')",
				"        if not isinstance(skeleton, unreal.Skeleton):",
				'            return {"success": False, "error": "Skeleton not found: {{skeleton_path}}"}',
				"    kind = '{{kind}}'",
				"    if kind == 'static_mesh':",
				"        options.mesh_type_to_import = unreal.FBXImportType.FBXIT_STATIC_MESH",
				"        options.import_mesh = True",
				"        options.import_as_skeletal = False",
				"        options.import_animations = False",
				"        data = options.static_mesh_import_data",
				...staticOptions.map((line) => `    ${line}`),
				...meshOptions.map((line) => `    ${line}`),
				...commonOptions.map((line) => `    ${line}`),
				"    elif kind == 'skeletal_mesh':",
				"        options.mesh_type_to_import = unreal.FBXImportType.FBXIT_SKELETAL_MESH",
				"        options.import_mesh = True",
				"        options.import_as_skeletal = True",
				"        if skeleton:",
				"            options.skeleton = skeleton",
				"        data = options.skeletal_mesh_import_data",
				...skeletalOptions.map((line) => `    ${line}`),
				...meshOptions.map((line) => `    ${line}`),
				...commonOptions.map((line) => `    ${line}`),
				"    else:",
				"        if skeleton is None:",
				'            return {"success": False, "error": "An animation needs skeleton_path, the Skeleton it is for."}',
				"        options.mesh_type_to_import = unreal.FBXImportType.FBXIT_ANIMATION",
				"        options.import_mesh = False",
				"        options.import_animations = True",
				"        options.skeleton = skeleton",
				"        data = options.anim_sequence_import_data",
				...commonOptions.map((line) => `    ${line}`),
				"    task.options = options",
				"    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])",
				"    paths = [str(p) for p in task.imported_object_paths]",
				"    if not paths:",
				'        return {"success": False, "error": "Nothing was imported. If an asset of that name already exists, pass replace_existing."}',
				'    result = {"success": True, "kind": kind, "imported": paths}',
				"    if kind == 'static_mesh':",
				"        meshes = []",
				"        for path in paths:",
				"            asset = unreal.EditorAssetLibrary.load_asset(path)",
				"            if isinstance(asset, unreal.StaticMesh):",
				"                summary = mcp_mesh_summary(asset, {{expected_max_dimension_cm}})",
				'                summary["path"] = path',
				"                meshes.append(summary)",
				'        result["meshes"] = meshes',
				"    return result",
			].join("\n");

			const script = inlineScript(
				`import unreal
import json
NORMALS = {
    'compute': unreal.FBXNormalImportMethod.FBXNIM_COMPUTE_NORMALS,
    'import': unreal.FBXNormalImportMethod.FBXNIM_IMPORT_NORMALS,
    'import_with_tangents': unreal.FBXNormalImportMethod.FBXNIM_IMPORT_NORMALS_AND_TANGENTS,
}
VERTEX_COLORS = {
    'replace': unreal.VertexColorImportOption.REPLACE,
    'ignore': unreal.VertexColorImportOption.IGNORE,
}
${MESH_SUMMARY_PY}
${body}
print(json.dumps(run()))`,
				{
					source_file: args.source_file,
					destination_path: args.destination_path,
					name: args.name ?? "",
					kind: args.kind,
					replace_existing: args.replace_existing,
					save: args.save,
					skeleton_path: args.skeleton_path ?? "",
					combine_meshes: args.combine_meshes ?? false,
					auto_generate_collision: args.auto_generate_collision ?? false,
					one_convex_hull_per_ucx: args.one_convex_hull_per_ucx ?? false,
					generate_lightmap_uvs: args.generate_lightmap_uvs ?? false,
					import_mesh_lods: args.import_mesh_lods ?? false,
					build_nanite: args.build_nanite ?? false,
					remove_degenerates: args.remove_degenerates ?? false,
					normals: args.normals ?? "compute",
					vertex_colors: args.vertex_colors ?? "replace",
					convert_scene_unit: args.convert_scene_unit ?? true,
					import_uniform_scale: args.import_uniform_scale ?? 1,
					create_physics_asset: args.create_physics_asset ?? false,
					import_animations: args.import_animations ?? false,
					import_materials: args.import_materials ?? true,
					import_textures: args.import_textures ?? true,
					expected_max_dimension_cm: args.expected_max_dimension_cm ?? 0,
				},
			);
			return reply(await manager.runPython(script));
		},
	);

	server.tool(
		"inspect_static_mesh",
		"Read back what a static mesh really is: size in centimeters, vertices and triangles per LOD, UV channels, material slots, collision, lightmap settings and Nanite, with warnings for the usual import mistakes (wrong scale, no collision, no usable lightmap UVs, a dense mesh with one LOD).",
		{
			mesh_path: z.string().min(1).describe("Static mesh asset path, e.g. /Game/Meshes/SM_Crate"),
			expected_max_dimension_cm: z
				.number()
				.positive()
				.optional()
				.describe("How big the largest dimension should be, to flag a wrong scale"),
		},
		async ({ mesh_path, expected_max_dimension_cm }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
${MESH_SUMMARY_PY}
mesh = unreal.EditorAssetLibrary.load_asset('{{mesh_path}}')
if isinstance(mesh, unreal.StaticMesh):
    summary = mcp_mesh_summary(mesh, {{expected}})
    summary["path"] = '{{mesh_path}}'
    print(json.dumps(summary, indent=2))
else:
    print(json.dumps({"error": "StaticMesh not found: {{mesh_path}}"}))`,
				{ mesh_path, expected: expected_max_dimension_cm ?? 0 },
			);
			return reply(await manager.runPython(script));
		},
	);

	server.tool(
		"set_lightmap_settings",
		"Set which UV channel a static mesh uses for lightmaps, and its lightmap resolution. A mesh from a modelling tool with an authored lightmap UV layer last needs the coordinate index pointed at that last channel (use_last_uv_channel).",
		{
			mesh_path: z.string().min(1).describe("Static mesh asset path"),
			coordinate_index: z
				.number()
				.int()
				.min(0)
				.max(7)
				.optional()
				.describe("UV channel for lightmaps (0 is the first channel)"),
			use_last_uv_channel: z
				.boolean()
				.default(false)
				.describe("Use the mesh's last UV channel instead of naming one"),
			resolution: z
				.number()
				.int()
				.min(4)
				.max(4096)
				.optional()
				.describe("Lightmap resolution in texels"),
			save: z.boolean().default(true).describe("Save the mesh"),
		},
		async ({ mesh_path, coordinate_index, use_last_uv_channel, resolution, save }) => {
			manager.requireEditor();
			if (coordinate_index !== undefined && use_last_uv_channel) {
				return fail("Give coordinate_index or use_last_uv_channel, not both.");
			}
			if (coordinate_index === undefined && !use_last_uv_channel && resolution === undefined) {
				return fail("Give coordinate_index, use_last_uv_channel or resolution.");
			}
			const script = inlineScript(
				`import unreal
import json
def run():
    mesh = unreal.EditorAssetLibrary.load_asset('{{mesh_path}}')
    if not isinstance(mesh, unreal.StaticMesh):
        return {"error": "StaticMesh not found: {{mesh_path}}"}
    lib = unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)
    channels = lib.get_num_uv_channels(mesh, 0)
    mode = '{{mode}}'
    index = None
    if mode == 'last':
        index = channels - 1
    elif mode == 'index':
        index = {{coordinate_index}}
    if index is not None and not 0 <= index < channels:
        return {"error": "Lightmap Coordinate Index %d is outside the mesh's %d UV channels (0 to %d)." % (index, channels, channels - 1)}
    if index is not None:
        mesh.set_editor_property('light_map_coordinate_index', index)
    if {{resolution}} > 0:
        mesh.set_editor_property('light_map_resolution', {{resolution}})
    if {{save}}:
        unreal.EditorAssetLibrary.save_asset('{{mesh_path}}')
    return {
        "success": True,
        "path": '{{mesh_path}}',
        "uv_channels": channels,
        "lightmap": {
            "coordinate_index": mesh.get_editor_property('light_map_coordinate_index'),
            "resolution": mesh.get_editor_property('light_map_resolution'),
        },
    }
print(json.dumps(run()))`,
				{
					mesh_path,
					mode: use_last_uv_channel ? "last" : coordinate_index !== undefined ? "index" : "keep",
					coordinate_index: coordinate_index ?? 0,
					resolution: resolution ?? 0,
					save,
				},
			);
			return reply(await manager.runPython(script));
		},
	);
}
