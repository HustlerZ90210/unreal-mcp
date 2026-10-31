import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionManager } from "../transports/connection-manager.js";
import type { UnrealMcpConfig } from "../types.js";
import { inlineScript } from "../utils/template.js";

/**
 * Python helpers shared by the data layer tools.
 *
 * A DataLayerInstance has no name getter in Python. Instances backed by a Data Layer Asset take
 * the asset's name, so look at the asset first and fall back to the instance's object name.
 */
const DATA_LAYER_HELPERS_PY = `def mcp_layer_name(layer):
    try:
        asset = layer.get_editor_property('data_layer_asset')
    except Exception:
        asset = None
    return asset.get_name() if asset else layer.get_name()

def mcp_find_layer(subsys, name):
    for layer in subsys.get_all_data_layers():
        if name in (mcp_layer_name(layer), layer.get_name(), layer.get_path_name()):
            return layer
    try:
        # Private (non-asset) data layers are looked up by their label
        return subsys.get_data_layer_from_label(name)
    except Exception:
        return None
`;

export function registerWorldPartitionTools(
	server: McpServer,
	manager: ConnectionManager,
	_config: UnrealMcpConfig,
): void {
	server.tool(
		"list_data_layers",
		"List the data layers in the current level, with their runtime type, visibility and initial runtime state.",
		{},
		async () => {
			manager.requireEditor();
			const script = `import unreal
import json
${DATA_LAYER_HELPERS_PY}
subsys = unreal.get_editor_subsystem(unreal.DataLayerEditorSubsystem)
result = []
for layer in subsys.get_all_data_layers():
    result.append({
        "name": mcp_layer_name(layer),
        "path": layer.get_path_name(),
        "is_runtime": layer.is_runtime(),
        "is_visible": layer.is_visible(),
        "initial_runtime_state": str(layer.get_initial_runtime_state()),
    })
print(json.dumps({"count": len(result), "data_layers": result}, indent=2))`;
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"set_data_layer_state",
		"Change a data layer in the editor. Loaded loads it, Activated loads it and makes it visible, Unloaded unloads it. This is the Data Layers panel; it does not change the runtime state in a play session.",
		{
			layer_name: z.string().describe("Data layer name (the Data Layer Asset's name)"),
			state: z.enum(["Loaded", "Activated", "Unloaded"]).describe("Target state"),
		},
		async ({ layer_name, state }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
${DATA_LAYER_HELPERS_PY}
subsys = unreal.get_editor_subsystem(unreal.DataLayerEditorSubsystem)
layer = mcp_find_layer(subsys, '{{layer_name}}')
if layer is None:
    print(json.dumps({"error": "Data layer not found: {{layer_name}}"}))
else:
    state = '{{state}}'
    changed = subsys.set_data_layer_is_loaded_in_editor(layer, state != 'Unloaded', True)
    if state == 'Activated':
        subsys.set_data_layer_visibility(layer, True)
    print(json.dumps({"success": True, "layer": mcp_layer_name(layer), "state": state, "changed": bool(changed)}))`,
				{ layer_name, state },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"get_loaded_cells",
		"Report the World Partition status of the current level: world bounds and actor counts. Unreal's Python API does not expose individual streaming cells.",
		{},
		async () => {
			manager.requireEditor();
			const script = `import unreal
import json
world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
lib = unreal.WorldPartitionBlueprintLibrary
try:
    bounds = lib.get_editor_world_bounds()
except Exception:
    bounds = None
info = {"world": world.get_name() if world else None, "has_world_partition": bool(bounds and bounds.is_valid)}
if info["has_world_partition"]:
    info["bounds"] = {
        "min": [bounds.min.x, bounds.min.y, bounds.min.z],
        "max": [bounds.max.x, bounds.max.y, bounds.max.z],
    }
    descs = lib.get_actor_descs() or []
    info["actor_count"] = len(descs)
    info["spatially_loaded_actor_count"] = sum(1 for d in descs if d.is_spatially_loaded)
    info["note"] = "Cell-level state is only shown in the World Partition editor window."
print(json.dumps(info, indent=2))`;
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);

	server.tool(
		"set_streaming_source",
		"Add a World Partition streaming source component to an actor in the level, or update the one it already has.",
		{
			actor_name: z.string().describe("Actor name or label"),
			radius: z.number().positive().default(10000).describe("Streaming radius in units"),
			target_grid: z
				.string()
				.optional()
				.describe("Runtime grid to load (default: all grids of the level)"),
		},
		async ({ actor_name, radius, target_grid }) => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
actor = None
for a in unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors():
    if a.get_name() == '{{actor_name}}' or a.get_actor_label() == '{{actor_name}}':
        actor = a
        break
if actor is None:
    print(json.dumps({"error": "Actor not found: {{actor_name}}"}))
else:
    comp = actor.get_component_by_class(unreal.WorldPartitionStreamingSourceComponent)
    created = comp is None
    if created:
        subobjects = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
        handles = subobjects.k2_gather_subobject_data_for_instance(actor)
        params = unreal.AddNewSubobjectParams(
            parent_handle=handles[0],
            new_class=unreal.WorldPartitionStreamingSourceComponent,
            blueprint_context=None,
        )
        new_handle, fail_reason = subobjects.add_new_subobject(params)
        if unreal.SubobjectDataBlueprintFunctionLibrary.is_handle_valid(new_handle):
            data = unreal.SubobjectDataBlueprintFunctionLibrary.get_data(new_handle)
            comp = unreal.SubobjectDataBlueprintFunctionLibrary.get_object(data)
        else:
            print(json.dumps({"error": "Failed to add streaming source component: " + str(fail_reason)}))
    if comp is not None:
        shape = unreal.StreamingSourceShape()
        shape.set_editor_property('use_grid_loading_range', False)
        shape.set_editor_property('radius', {{radius}})
        comp.set_editor_property('shapes', [shape])
        grid = '{{target_grid}}'
        if grid:
            comp.set_editor_property('target_grid', unreal.Name(grid))
        print(json.dumps({"success": True, "actor": "{{actor_name}}", "created": created, "radius": {{radius}}}))`,
				{ actor_name, radius, target_grid: target_grid ?? "" },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);
}
