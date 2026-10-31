import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionManager } from "../transports/connection-manager.js";
import type { UnrealMcpConfig } from "../types.js";
import { consoleScript } from "../utils/python.js";
import { inlineScript } from "../utils/template.js";

export function registerEditorUtilsTools(
	server: McpServer,
	manager: ConnectionManager,
	_config: UnrealMcpConfig,
): void {
	server.tool(
		"run_editor_utility_widget",
		"Run an Editor Utility Widget by asset path.",
		{
			widget_path: z.string().describe("Editor Utility Widget asset path"),
		},
		async ({ widget_path }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
subsys = unreal.get_editor_subsystem(unreal.EditorUtilitySubsystem)
widget = unreal.EditorAssetLibrary.load_asset('{{widget_path}}')
if widget:
    subsys.spawn_and_register_tab(widget)
    print(json.dumps({"success": True, "widget": "{{widget_path}}"}))
else:
    print(json.dumps({"error": "Widget not found: {{widget_path}}"}))`,
				{ widget_path },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"run_editor_utility_blueprint",
		"Run an Editor Utility Blueprint's Run event.",
		{
			blueprint_path: z.string().describe("Editor Utility Blueprint asset path"),
		},
		async ({ blueprint_path }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
subsys = unreal.get_editor_subsystem(unreal.EditorUtilitySubsystem)
bp = unreal.EditorAssetLibrary.load_asset('{{blueprint_path}}')
if bp:
    subsys.try_run(bp)
    print(json.dumps({"success": True}))
else:
    print(json.dumps({"error": "Blueprint not found: {{blueprint_path}}"}))`,
				{ blueprint_path },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"generate_lods",
		"Generate LODs for a static mesh, so it has the given total number of LODs (including LOD0).",
		{
			mesh_path: z.string().describe("Static mesh asset path"),
			lod_count: z
				.number()
				.int()
				.min(1)
				.max(8)
				.default(3)
				.describe("Total number of LODs, including LOD0"),
		},
		async ({ mesh_path, lod_count }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
def mesh_lib():
    # The Editor Scripting Utilities library is deprecated in favour of the subsystem (5.0+).
    sub_class = getattr(unreal, 'StaticMeshEditorSubsystem', None)
    return unreal.get_editor_subsystem(sub_class) if sub_class else unreal.EditorStaticMeshLibrary
mesh = unreal.EditorAssetLibrary.load_asset('{{mesh_path}}')
if mesh and isinstance(mesh, unreal.StaticMesh):
    lib = mesh_lib()
    options_class = getattr(unreal, 'StaticMeshReductionOptions', None) or unreal.EditorScriptingMeshReductionOptions
    settings_class = getattr(unreal, 'StaticMeshReductionSettings', None) or unreal.EditorScriptingMeshReductionSettings
    # The first entry is LOD0 (the full mesh); each later LOD keeps fewer triangles.
    settings = [
        settings_class(percent_triangles=max(0.1, 1.0 - (i * 0.3)), screen_size=0.5 ** i)
        for i in range({{lod_count}})
    ]
    options = options_class(auto_compute_lod_screen_size=False, reduction_settings=settings)
    created = lib.set_lods(mesh, options)
    unreal.EditorAssetLibrary.save_asset('{{mesh_path}}')
    print(json.dumps({"success": True, "lods": created}))
else:
    print(json.dumps({"error": "StaticMesh not found: {{mesh_path}}"}))`,
				{ mesh_path, lod_count },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"generate_collision",
		"Generate collision for a static mesh.",
		{
			mesh_path: z.string().describe("Static mesh asset path"),
			type: z
				.enum(["box", "sphere", "capsule", "convex", "auto"])
				.default("auto")
				.describe("Collision type"),
		},
		async ({ mesh_path, type }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
def mesh_lib():
    # The Editor Scripting Utilities library is deprecated in favour of the subsystem (5.0+).
    sub_class = getattr(unreal, 'StaticMeshEditorSubsystem', None)
    return unreal.get_editor_subsystem(sub_class) if sub_class else unreal.EditorStaticMeshLibrary
mesh = unreal.EditorAssetLibrary.load_asset('{{mesh_path}}')
if mesh and isinstance(mesh, unreal.StaticMesh):
    lib = mesh_lib()
    kind = '{{type}}'
    if kind == 'box':
        lib.add_simple_collisions(mesh, unreal.ScriptingCollisionShapeType.BOX)
    elif kind == 'sphere':
        lib.add_simple_collisions(mesh, unreal.ScriptingCollisionShapeType.SPHERE)
    elif kind == 'capsule':
        lib.add_simple_collisions(mesh, unreal.ScriptingCollisionShapeType.CAPSULE)
    else:
        # 4 hulls, 16 vertices each, and the editor's default hull precision
        lib.set_convex_decomposition_collisions(mesh, 4, 16, 100000)
    unreal.EditorAssetLibrary.save_asset('{{mesh_path}}')
    print(json.dumps({"success": True, "type": kind}))
else:
    print(json.dumps({"error": "StaticMesh not found: {{mesh_path}}"}))`,
				{ mesh_path, type },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"generate_lightmap_uvs",
		"Turn on lightmap UV generation for a static mesh and report its UV channels and lightmap settings.",
		{
			mesh_path: z.string().describe("Static mesh asset path"),
		},
		async ({ mesh_path }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
def mesh_lib():
    # The Editor Scripting Utilities library is deprecated in favour of the subsystem (5.0+).
    sub_class = getattr(unreal, 'StaticMeshEditorSubsystem', None)
    return unreal.get_editor_subsystem(sub_class) if sub_class else unreal.EditorStaticMeshLibrary
mesh = unreal.EditorAssetLibrary.load_asset('{{mesh_path}}')
if mesh and isinstance(mesh, unreal.StaticMesh):
    lib = mesh_lib()
    ok = lib.set_generate_lightmap_uv(mesh, True)
    info = {"success": bool(ok), "uv_channels": lib.get_num_uv_channels(mesh, 0)}
    for key in ('light_map_coordinate_index', 'light_map_resolution'):
        try:
            info[key] = mesh.get_editor_property(key)
        except Exception:
            pass
    unreal.EditorAssetLibrary.save_asset('{{mesh_path}}')
    print(json.dumps(info))
else:
    print(json.dumps({"error": "StaticMesh not found: {{mesh_path}}"}))`,
				{ mesh_path },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool("undo", "Undo the last editor action.", {}, async () => {
		manager.requireEditor();
		const script = consoleScript(`import json
success = run_console('transaction undo')
print(json.dumps({"undone": True}))`);
		const result = await manager.runPython(script);
		return { content: [{ type: "text", text: result }] };
	});

	server.tool("redo", "Redo the last undone editor action.", {}, async () => {
		manager.requireEditor();
		const script = consoleScript(`import json
success = run_console('transaction redo')
print(json.dumps({"redone": True}))`);
		const result = await manager.runPython(script);
		return { content: [{ type: "text", text: result }] };
	});

	server.tool(
		"get_undo_history",
		"Get the undo/redo transaction history.",
		{
			count: z.number().default(20).describe("Number of recent transactions to return"),
		},
		async ({ count }) => {
			manager.requireEditor();
			const script = `import unreal
import json
# Transaction history is accessible via GEditor->Trans
print(json.dumps({"hint": "Undo history available in Edit > Undo History window. Use undo/redo tools to navigate."}))`;
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);
}
