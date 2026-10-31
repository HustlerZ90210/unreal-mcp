export interface UnrealMcpConfig {
	projectPath: string;
	enginePath?: string;
	engineVersion?: string;
	remoteControlPort: number;
	remoteControlWsPort: number;
	pythonExecPort: number;
	pluginBridgePort: number;
	platform: string;
	configuration: string;
	enabledModules: string[];
	/**
	 * Content paths such as "/Game/ReadyOrNot" that tools refuse to modify. Engine content (/Engine)
	 * is always protected.
	 */
	protectedPaths?: string[];
	/**
	 * Refuse to modify assets that are hard-linked to another file, such as a copy of a game's exported
	 * content linked into the project. On by default.
	 */
	protectLinkedContent?: boolean;
	/** UnrealPak, if it is not at its usual place under the engine install */
	unrealPakPath?: string;
	/** Ready or Not: the Community Mapping Framework folder, which holds Tools/ronfw.py */
	ronFrameworkPath?: string;
	/** Python to run ronfw with (default: the engine's bundled Python, then the one on PATH) */
	ronPython?: string;
	timeouts: {
		build: number;
		cook: number;
		remoteControl: number;
		pythonExec: number;
	};
}

export interface ConnectionStatus {
	remoteControl: boolean;
	pythonExec: boolean;
	pluginBridge: boolean;
	editorRunning: boolean;
}

export interface SubprocessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	duration: number;
	parsed?: ParsedBuildOutput;
}

export interface ParsedBuildOutput {
	errors: BuildDiagnostic[];
	warnings: BuildDiagnostic[];
	progress: number;
	succeeded: boolean;
	summary: string;
}

export interface BuildDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "error" | "warning";
	code: string;
	message: string;
}

export interface PluginBridgeCommand {
	id?: string;
	command: string;
	params: Record<string, unknown>;
}

export interface PluginBridgeResponse {
	id?: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export interface PluginCapabilities {
	version: string;
	commands: string[];
	features: string[];
}

export const ALL_MODULES = [
	"console",
	"actor",
	"asset",
	"build",
	"blueprint",
	"material",
	"sequencer",
	"animation",
	"niagara",
	"testing",
	"source-control",
	"profiling",
	"world-partition",
	"editor-utils",
	"remote-control-presets",
	"plugin",
	"diagnostics",
	"ron",
	"pak",
	"mesh",
] as const;

export type ModuleName = (typeof ALL_MODULES)[number];

/** Modules that stay off until they are listed in enabledModules (or "all" is). */
export const OPTIONAL_MODULES: readonly ModuleName[] = ["ron"];

export const DEFAULT_MODULES: ModuleName[] = ALL_MODULES.filter(
	(module) => !OPTIONAL_MODULES.includes(module),
);
