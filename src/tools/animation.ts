import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionManager } from "../transports/connection-manager.js";
import type { UnrealMcpConfig } from "../types.js";
import { inlineScript } from "../utils/template.js";

export function registerAnimationTools(
	server: McpServer,
	manager: ConnectionManager,
	_config: UnrealMcpConfig,
): void {
	server.tool(
		"create_anim_blueprint",
		"Create an Animation Blueprint for a target skeleton.",
		{
			name: z.string().describe("AnimBlueprint name"),
			skeleton_path: z.string().describe("Target skeleton asset path"),
			path: z.string().default("/Game/Animations").describe("Content directory"),
		},
		async ({ name, skeleton_path, path }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
skeleton = unreal.EditorAssetLibrary.load_asset('{{skeleton_path}}')
if skeleton:
    factory = unreal.AnimBlueprintFactory()
    factory.set_editor_property('TargetSkeleton', skeleton)
    asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
    anim_bp = asset_tools.create_asset('{{name}}', '{{path}}', unreal.AnimBlueprint, factory)
    if anim_bp:
        print(json.dumps({"success": True, "name": anim_bp.get_name(), "path": anim_bp.get_path_name()}))
    else:
        print(json.dumps({"error": "Failed to create AnimBlueprint"}))
else:
    print(json.dumps({"error": "Skeleton not found: {{skeleton_path}}"}))`,
				{ name, skeleton_path, path },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"get_anim_sequence_info",
		"Get info about an animation sequence (length, frames, bone data).",
		{
			sequence_path: z.string().describe("AnimSequence asset path"),
		},
		async ({ sequence_path }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
seq = unreal.EditorAssetLibrary.load_asset('{{sequence_path}}')
if seq and isinstance(seq, unreal.AnimSequence):
    lib = unreal.AnimationLibrary
    skeleton = seq.get_skeleton()
    result = {
        "name": seq.get_name(),
        "length": lib.get_sequence_length(seq),
        "num_frames": lib.get_num_frames(seq),
        "rate_scale": lib.get_rate_scale(seq),
        "skeleton": skeleton.get_name() if skeleton else None,
    }
    print(json.dumps(result, indent=2))
else:
    print(json.dumps({"error": "AnimSequence not found: {{sequence_path}}"}))`,
				{ sequence_path },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"create_anim_montage",
		"Create an animation montage from an animation sequence.",
		{
			name: z.string().describe("Montage name"),
			sequence_path: z.string().describe("Source AnimSequence asset path"),
			path: z.string().default("/Game/Animations").describe("Content directory"),
		},
		async ({ name, sequence_path, path }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
seq = unreal.EditorAssetLibrary.load_asset('{{sequence_path}}')
if seq:
    factory = unreal.AnimMontageFactory()
    factory.set_editor_property('SourceAnimation', seq)
    asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
    montage = asset_tools.create_asset('{{name}}', '{{path}}', unreal.AnimMontage, factory)
    if montage:
        print(json.dumps({"success": True, "name": montage.get_name(), "path": montage.get_path_name()}))
    else:
        print(json.dumps({"error": "Failed to create montage"}))
else:
    print(json.dumps({"error": "AnimSequence not found: {{sequence_path}}"}))`,
				{ name, sequence_path, path },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"set_skeletal_mesh_lod",
		"Generate LODs on a skeletal mesh so it has the given total number of LODs (including LOD0).",
		{
			mesh_path: z.string().describe("Skeletal mesh asset path"),
			lod_count: z
				.number()
				.int()
				.min(1)
				.max(8)
				.describe("Total number of LODs the mesh should have"),
		},
		async ({ mesh_path, lod_count }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
mesh = unreal.EditorAssetLibrary.load_asset('{{mesh_path}}')
if mesh and isinstance(mesh, unreal.SkeletalMesh):
    # The library functions are deprecated in favour of the subsystem; use it when present.
    sub_class = getattr(unreal, 'SkeletalMeshEditorSubsystem', None)
    lib = unreal.get_editor_subsystem(sub_class) if sub_class else unreal.EditorSkeletalMeshLibrary
    ok = lib.regenerate_lod(mesh, {{lod_count}}, True, False)
    unreal.EditorAssetLibrary.save_asset('{{mesh_path}}')
    print(json.dumps({"success": bool(ok), "lods": {{lod_count}}}))
else:
    print(json.dumps({"error": "SkeletalMesh not found: {{mesh_path}}"}))`,
				{ mesh_path, lod_count },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"reimport_skeletal_mesh",
		"Reimport a skeletal mesh from its source file.",
		{
			mesh_path: z.string().describe("Skeletal mesh asset path"),
		},
		async ({ mesh_path }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
mesh = unreal.EditorAssetLibrary.load_asset('{{mesh_path}}')
if mesh:
    success = unreal.EditorSkeletalMeshLibrary.reimport_all_custom_lo_ds(mesh)
    print(json.dumps({"success": True, "reimported": "{{mesh_path}}"}))
else:
    print(json.dumps({"error": "Mesh not found: {{mesh_path}}"}))`,
				{ mesh_path },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"apply_anim_modifier",
		"Apply an animation modifier to an animation sequence. Needs the optional C++ plugin: Unreal's Python API does not expose applying modifiers.",
		{
			sequence_path: z.string().describe("AnimSequence asset path"),
			modifier_class: z.string().describe("Animation modifier class name"),
		},
		async ({ sequence_path, modifier_class }) => {
			manager.requireEditor();

			if (manager.hasPlugin && manager.plugin.hasCapability("apply_anim_modifier")) {
				const response = await manager.plugin.sendCommand({
					command: "apply_anim_modifier",
					params: { sequence_path, modifier_class },
				});
				return { content: [{ type: "text", text: JSON.stringify(response.data) }] };
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							error:
								"Applying animation modifiers is not available through Unreal's Python API (UE 5.3 to 5.6).",
							hint: "Add the modifier and press Apply in the Animation Modifiers panel of the animation editor, or use the optional UnrealMCPBridge plugin.",
						}),
					},
				],
				isError: true,
			};
		},
	);
}
