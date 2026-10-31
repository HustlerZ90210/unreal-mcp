import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findFramework, gameContentRoots } from "../ron/framework.js";
import type { UnrealMcpConfig } from "../types.js";
import { type PathKind, ProtectedContentError, WriteGuard } from "../utils/protect.js";

/**
 * Which parameter of which tool names content that the tool changes (saves, creates in, renames,
 * deletes). Tools listed here are refused when the content is protected; see utils/protect.ts.
 * A test checks that every tool whose script saves, creates, renames or deletes assets is listed.
 */

interface WriteParam {
	name: string;
	kind: PathKind;
	/** The parameter holds a list of paths */
	list?: boolean;
	/** Used when the argument is left out (a tool that then covers the whole project) */
	fallback?: string;
}

const asset = (name: string): WriteParam => ({ name, kind: "asset" });
const assets = (name: string): WriteParam => ({ name, kind: "asset", list: true });
const directory = (name: string, fallback?: string): WriteParam => ({
	name,
	kind: "directory",
	fallback,
});

export const WRITE_PARAMS: Record<string, WriteParam[]> = {
	// assets
	rename_asset: [asset("source_path"), asset("destination_path")],
	duplicate_asset: [asset("destination_path")],
	delete_asset: [asset("asset_path")],
	import_asset: [directory("destination_path")],
	import_fbx: [directory("destination_path")],
	save_asset: [asset("asset_path")],
	resave_packages: [directory("directory", "/Game")],
	consolidate_assets: [asset("target_path"), assets("source_paths")],
	// new assets
	create_blueprint: [directory("path")],
	create_material: [directory("path")],
	create_material_function: [directory("path")],
	create_material_instance: [directory("path")],
	create_level_sequence: [directory("path")],
	create_anim_blueprint: [directory("path")],
	create_anim_montage: [directory("path")],
	// blueprints
	add_blueprint_component: [asset("blueprint_path")],
	add_blueprint_variable: [asset("blueprint_path")],
	add_blueprint_function: [asset("blueprint_path")],
	set_blueprint_property: [asset("blueprint_path")],
	compile_blueprint: [asset("blueprint_path")],
	add_graph_node: [asset("blueprint_path")],
	connect_graph_nodes: [asset("blueprint_path")],
	remove_graph_node: [asset("blueprint_path")],
	// materials
	create_material_expression: [asset("material_path")],
	connect_material_expressions: [asset("material_path")],
	connect_material_property: [asset("material_path")],
	delete_material_expression: [asset("material_path")],
	recompile_material: [asset("material_path")],
	set_material_instance_scalar: [asset("instance_path")],
	set_material_instance_vector: [asset("instance_path")],
	set_material_instance_texture: [asset("instance_path")],
	// sequences, animation, meshes
	add_actor_binding: [asset("sequence_path")],
	add_track: [asset("sequence_path")],
	set_playback_range: [asset("sequence_path")],
	set_sequence_framerate: [asset("sequence_path")],
	apply_anim_modifier: [asset("sequence_path")],
	set_skeletal_mesh_lod: [asset("mesh_path")],
	reimport_skeletal_mesh: [asset("mesh_path")],
	generate_lods: [asset("mesh_path")],
	generate_collision: [asset("mesh_path")],
	generate_lightmap_uvs: [asset("mesh_path")],
	set_lightmap_settings: [asset("mesh_path")],
};

function pathsOf(param: WriteParam, args: Record<string, unknown>): string[] {
	const value = args[param.name] ?? param.fallback;
	if (typeof value === "string") return [value];
	if (param.list && Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}
	return [];
}

/** Returns an MCP error result when a call would change protected content. */
export function refuseProtectedWrite(
	guard: WriteGuard,
	tool: string,
	args: Record<string, unknown>,
): ReturnType<ProtectedContentError["toToolResult"]> | undefined {
	for (const param of WRITE_PARAMS[tool] ?? []) {
		for (const path of pathsOf(param, args)) {
			const reason = guard.check(path, param.kind);
			if (reason) return new ProtectedContentError(path, reason).toToolResult();
		}
	}
	return undefined;
}

export function createWriteGuard(config: UnrealMcpConfig): WriteGuard {
	return new WriteGuard({
		projectPath: config.projectPath,
		protectedPaths: config.protectedPaths,
		protectLinkedContent: config.protectLinkedContent,
		gameContent: () => gameContentRoots(findFramework(config)?.paths),
	});
}

/**
 * A view of the server whose tools check their arguments with the guard first. Modules register
 * their tools on this view exactly as they would on the server.
 */
export function guardWrites(server: McpServer, guard: WriteGuard): McpServer {
	return new Proxy(server, {
		get(target, property, receiver) {
			if (property !== "tool") {
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			}
			return (name: string, ...rest: unknown[]) => {
				const handler = rest[rest.length - 1] as (...args: unknown[]) => unknown;
				if (WRITE_PARAMS[name] && typeof handler === "function") {
					rest[rest.length - 1] = async (args: Record<string, unknown>, ...more: unknown[]) =>
						refuseProtectedWrite(guard, name, args) ?? handler(args, ...more);
				}
				// biome-ignore lint/suspicious/noExplicitAny: forwards the overloaded McpServer.tool signature
				return (target.tool as any)(name, ...rest);
			};
		},
	});
}
