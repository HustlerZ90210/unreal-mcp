import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../transports/connection-manager.js";
import type { UnrealMcpConfig } from "../types.js";
import { registerActorTools } from "./actor.js";
import { registerAnimationTools } from "./animation.js";
import { registerAssetTools } from "./asset.js";
import { registerBlueprintTools } from "./blueprint.js";
import { registerBuildTools } from "./build.js";
import { registerConsoleTools } from "./console.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerEditorUtilsTools } from "./editor-utils.js";
import { createWriteGuard, guardWrites } from "./guard.js";
import { registerMaterialTools } from "./material.js";
import { registerNiagaraTools } from "./niagara.js";
import { registerPakTools } from "./pak.js";
import { registerPluginTools } from "./plugin.js";
import { registerProfilingTools } from "./profiling.js";
import { registerRemoteControlPresetsTools } from "./remote-control-presets.js";
import { registerRonTools } from "./ron.js";
import { registerSequencerTools } from "./sequencer.js";
import { registerSourceControlTools } from "./source-control.js";
import { registerTestingTools } from "./testing.js";
import { registerWorldPartitionTools } from "./world-partition.js";

// All 19 tool modules (ron is optional and off until listed in enabledModules)
const MODULE_REGISTRARS: Record<
	string,
	(server: McpServer, manager: ConnectionManager, config: UnrealMcpConfig) => void
> = {
	console: registerConsoleTools,
	actor: registerActorTools,
	asset: registerAssetTools,
	build: registerBuildTools,
	blueprint: registerBlueprintTools,
	material: registerMaterialTools,
	sequencer: registerSequencerTools,
	animation: registerAnimationTools,
	niagara: registerNiagaraTools,
	testing: registerTestingTools,
	"source-control": registerSourceControlTools,
	profiling: registerProfilingTools,
	"world-partition": registerWorldPartitionTools,
	"editor-utils": registerEditorUtilsTools,
	"remote-control-presets": registerRemoteControlPresetsTools,
	plugin: registerPluginTools,
	diagnostics: registerDiagnosticsTools,
	ron: registerRonTools,
	pak: registerPakTools,
};

/**
 * Register all enabled tool modules with the MCP server.
 */
export function registerAllTools(
	server: McpServer,
	manager: ConnectionManager,
	config: UnrealMcpConfig,
): void {
	const enabledModules = new Set(config.enabledModules);
	// Tools that change content check it against the protection rules first.
	const guarded = guardWrites(server, createWriteGuard(config));

	for (const [moduleName, register] of Object.entries(MODULE_REGISTRARS)) {
		if (enabledModules.has(moduleName)) {
			register(guarded, manager, config);
		}
	}
}
