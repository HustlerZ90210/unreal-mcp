import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../transports/connection-manager.js";
import type { UnrealMcpConfig } from "../types.js";
import { formatVersion } from "../utils/engine-version.js";
import { inlineScript } from "../utils/template.js";
import { API_MANIFEST } from "./api-manifest.js";

export function registerDiagnosticsTools(
	server: McpServer,
	manager: ConnectionManager,
	config: UnrealMcpConfig,
): void {
	server.tool(
		"get_engine_info",
		"Report the Unreal Engine version, the project, and which connections to the editor work. Safe to call when the editor is not running.",
		{},
		async () => {
			const status = await manager.refreshStatus();
			const version = await manager.detectEngineVersion();
			const info: Record<string, unknown> = {
				engine_version: version ? formatVersion(version) : null,
				project_path: config.projectPath || null,
				engine_path: config.enginePath ?? null,
				platform: config.platform,
				connections: status,
				plugin_bridge: manager.hasPlugin ? manager.pluginCapabilities : null,
			};

			if (status.editorRunning) {
				try {
					const output = await manager.runPython(`import unreal
import json
import sys
print(json.dumps({
    "engine_version": unreal.SystemLibrary.get_engine_version(),
    "project": unreal.SystemLibrary.get_game_name(),
    "project_directory": unreal.SystemLibrary.get_project_directory(),
    "python": sys.version.split()[0],
}))`);
					info.editor = JSON.parse(output);
				} catch (error) {
					info.editor_error = error instanceof Error ? error.message : String(error);
				}
			}
			return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
		},
	);

	server.tool(
		"check_ue_compat",
		`Check that the running editor has every Unreal Python API these tools call, and list the tools that would fail on it. The list was checked against Unreal Engine ${API_MANIFEST.version}; run this once after connecting to an engine build.`,
		{},
		async () => {
			manager.requireEditor();
			const script = inlineScript(
				`import unreal
import json
manifest = json.loads('{{manifest}}')
missing = {}
version_gated = {}

def note(table, api, tool):
    tools = table.setdefault(api, [])
    if tool not in tools:
        tools.append(tool)

checked = 0
for tool, names in manifest["symbols"].items():
    for name in names:
        checked += 1
        if not hasattr(unreal, name):
            note(missing, "unreal." + name, tool)
for tool, pairs in manifest["tools"].items():
    gated = manifest["gated"].get(tool, [])
    for cls, member in pairs:
        checked += 1
        owner = getattr(unreal, cls, None)
        api = cls + "." + member
        if owner is None:
            note(missing, "unreal." + cls, tool)
        elif not hasattr(owner, member):
            note(version_gated if api in gated else missing, "unreal." + api, tool)

engine = unreal.SystemLibrary.get_engine_version()
failing = sorted({t for tools in missing.values() for t in tools})
print(json.dumps({
    "engine_version": engine,
    "checked_against": manifest["version"],
    "same_minor_version": engine.startswith(manifest["version"] + "."),
    "apis_checked": checked,
    "ok": not missing,
    "tools_that_will_fail": failing,
    "missing": [{"api": api, "tools": sorted(tools)} for api, tools in sorted(missing.items())],
    "version_gated": [{"api": api, "tools": sorted(tools)} for api, tools in sorted(version_gated.items())],
}, indent=2))`,
				{ manifest: JSON.stringify(API_MANIFEST) },
			);
			const result = await manager.runPython(script);
			return { content: [{ type: "text", text: result }] };
		},
	);
}
