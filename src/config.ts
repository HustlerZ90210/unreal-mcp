import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { UnrealMcpConfig } from "./types.js";
import { ALL_MODULES } from "./types.js";
import { parseEngineVersion, readBuildVersion } from "./utils/engine-version.js";
import { resolveProject } from "./utils/project.js";

const DEFAULTS: UnrealMcpConfig = {
	projectPath: "",
	remoteControlPort: 30010,
	remoteControlWsPort: 30020,
	pythonExecPort: 6776,
	pluginBridgePort: 55557,
	platform: "Win64",
	configuration: "Development",
	enabledModules: [...ALL_MODULES],
	timeouts: {
		build: 600_000,
		cook: 1_200_000,
		remoteControl: 10_000,
		pythonExec: 30_000,
	},
};

function loadConfigFile(): Partial<UnrealMcpConfig> {
	const candidates = [
		join(process.cwd(), ".unrealmcp.json"),
		join(process.env.HOME || process.env.USERPROFILE || "", ".unrealmcp.json"),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			try {
				return JSON.parse(readFileSync(candidate, "utf-8"));
			} catch {
				// Ignore invalid JSON
			}
		}
	}
	return {};
}

function loadEnvVars(): Partial<UnrealMcpConfig> {
	const config: Partial<UnrealMcpConfig> = {};

	if (process.env.UNREAL_MCP_PROJECT_PATH) {
		config.projectPath = process.env.UNREAL_MCP_PROJECT_PATH;
	}
	if (process.env.UNREAL_MCP_ENGINE_PATH) {
		config.enginePath = process.env.UNREAL_MCP_ENGINE_PATH;
	}
	if (process.env.UNREAL_MCP_ENGINE_VERSION) {
		config.engineVersion = process.env.UNREAL_MCP_ENGINE_VERSION;
	}
	if (process.env.UNREAL_MCP_RC_PORT) {
		config.remoteControlPort = Number.parseInt(process.env.UNREAL_MCP_RC_PORT, 10);
	}
	if (process.env.UNREAL_MCP_PYTHON_PORT) {
		config.pythonExecPort = Number.parseInt(process.env.UNREAL_MCP_PYTHON_PORT, 10);
	}
	if (process.env.UNREAL_MCP_PLATFORM) {
		config.platform = process.env.UNREAL_MCP_PLATFORM;
	}
	if (process.env.UNREAL_MCP_CONFIGURATION) {
		config.configuration = process.env.UNREAL_MCP_CONFIGURATION;
	}
	if (process.env.UNREAL_MCP_MODULES) {
		config.enabledModules = process.env.UNREAL_MCP_MODULES.split(",").map((m) => m.trim());
	}

	return config;
}

function parseCliArgs(argv: string[]): Partial<UnrealMcpConfig> {
	const config: Partial<UnrealMcpConfig> = {};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];

		switch (arg) {
			case "--project-path":
				config.projectPath = next;
				i++;
				break;
			case "--engine-path":
				config.enginePath = next;
				i++;
				break;
			case "--engine-version":
				config.engineVersion = next;
				i++;
				break;
			case "--rc-port":
				config.remoteControlPort = Number.parseInt(next, 10);
				i++;
				break;
			case "--python-port":
				config.pythonExecPort = Number.parseInt(next, 10);
				i++;
				break;
			case "--plugin-port":
				config.pluginBridgePort = Number.parseInt(next, 10);
				i++;
				break;
			case "--platform":
				config.platform = next;
				i++;
				break;
			case "--configuration":
				config.configuration = next;
				i++;
				break;
			case "--modules":
				config.enabledModules = next.split(",").map((m) => m.trim());
				i++;
				break;
		}
	}

	return config;
}

/** Folders the Epic Games Launcher (and common source-build layouts) install an engine into. */
function engineInstallCandidates(association: string): string[] {
	const folder = `UE_${association}`;
	if (process.platform === "win32") {
		const roots = [
			process.env.ProgramFiles,
			process.env["ProgramFiles(x86)"],
			"C:\\Program Files",
			"C:\\Program Files (x86)",
			"D:\\Program Files",
			"D:\\",
			"C:\\",
		].filter((r): r is string => !!r);
		return roots.flatMap((root) => [join(root, "Epic Games", folder), join(root, folder)]);
	}
	if (process.platform === "darwin") {
		return [join("/Users/Shared/Epic Games", folder), join(homedir(), folder)];
	}
	return [join(homedir(), folder), join(homedir(), "UnrealEngine"), join("/opt", folder)];
}

function autoDetectEnginePath(projectPath: string): string | undefined {
	const project = resolveProject(projectPath);
	if (!project.uprojectPath || !existsSync(project.uprojectPath)) return undefined;

	try {
		const uproject = JSON.parse(readFileSync(project.uprojectPath, "utf-8"));
		const association = uproject.EngineAssociation;
		if (!association || typeof association !== "string") return undefined;

		for (const candidate of engineInstallCandidates(association)) {
			if (existsSync(candidate)) return candidate;
		}
	} catch {
		// Ignore
	}

	return undefined;
}

/** The engine version the project asks for, e.g. "5.3" from EngineAssociation (not a GUID). */
function projectEngineVersion(projectPath: string): string | undefined {
	const project = resolveProject(projectPath);
	if (!project.uprojectPath || !existsSync(project.uprojectPath)) return undefined;
	try {
		const uproject = JSON.parse(readFileSync(project.uprojectPath, "utf-8"));
		const version = parseEngineVersion(uproject.EngineAssociation);
		return version ? `${version.major}.${version.minor}` : undefined;
	} catch {
		return undefined;
	}
}

export function loadConfig(argv: string[] = process.argv.slice(2)): UnrealMcpConfig {
	const fileConfig = loadConfigFile();
	const envConfig = loadEnvVars();
	const cliConfig = parseCliArgs(argv);

	// Priority: CLI > env > file > defaults
	const merged: UnrealMcpConfig = {
		...DEFAULTS,
		...fileConfig,
		...envConfig,
		...cliConfig,
		timeouts: {
			...DEFAULTS.timeouts,
			...(fileConfig.timeouts || {}),
			...(envConfig.timeouts || {}),
			...(cliConfig.timeouts || {}),
		},
	};

	// Resolve project path
	if (merged.projectPath) {
		merged.projectPath = resolve(merged.projectPath);
	}

	// Auto-detect engine path if not provided
	if (!merged.enginePath && merged.projectPath) {
		merged.enginePath = autoDetectEnginePath(merged.projectPath);
	}

	if (merged.enginePath) {
		merged.enginePath = resolve(merged.enginePath);
	}

	// Engine version: explicit setting > the install's Build.version > the project's association.
	if (!merged.engineVersion) {
		const installed = readBuildVersion(merged.enginePath);
		merged.engineVersion = installed
			? `${installed.major}.${installed.minor}.${installed.patch}`
			: projectEngineVersion(merged.projectPath);
	}

	return merged;
}
