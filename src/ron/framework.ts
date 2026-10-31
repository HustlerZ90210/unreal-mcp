import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { UnrealMcpConfig } from "../types.js";
import { resolveProject } from "../utils/project.js";

/**
 * Finding and describing the Ready or Not Community Mapping Framework and its `ronfw` tool.
 * Nothing here runs the tool; see tools/ron.ts for that.
 */

export interface RonFramework {
	/** Folder that holds Tools/ronfw.py, next to the framework's Unreal project */
	root: string;
	toolsDir: string;
	script: string;
	/** Python to run the script with */
	python: string;
	/** ronfw.config.json: the paths `ronfw setup` found. Undefined until setup has been run. */
	paths?: Record<string, string>;
	/** The tool's own version, read from the script */
	version?: string;
}

export interface RonProfile {
	name: string;
	maps: string[];
	pakName?: string;
}

/** A folder of untouched game content, mounted like the project's content (Game = /Game/...). */
export interface GameContentRoot {
	mount: string;
	dir: string;
}

function scriptIn(folder: string): string | undefined {
	const candidates = [join(folder, "Tools", "ronfw.py"), join(folder, "ronfw.py")];
	return candidates.find((candidate) => existsSync(candidate));
}

/** Where the framework is: the configured folder, or the one next to the configured project. */
function locateScript(config: UnrealMcpConfig): string | undefined {
	if (config.ronFrameworkPath) {
		const given = resolve(config.ronFrameworkPath);
		if (given.toLowerCase().endsWith("ronfw.py")) return existsSync(given) ? given : undefined;
		return scriptIn(given);
	}
	const project = resolveProject(config.projectPath);
	if (!project.dir) return undefined;
	// The project sits one folder below the framework root; look a little further up as well.
	for (const folder of [dirname(project.dir), project.dir, dirname(dirname(project.dir))]) {
		const found = scriptIn(folder);
		if (found) return found;
	}
	return undefined;
}

/** The engine's own Python, which the framework's documentation recommends, else the one on PATH. */
function findPython(config: UnrealMcpConfig): string {
	if (config.ronPython) return config.ronPython;
	if (config.enginePath) {
		const bundled = [
			join(config.enginePath, "Engine", "Binaries", "ThirdParty", "Python3", "Win64", "python.exe"),
			join(
				config.enginePath,
				"Engine",
				"Binaries",
				"ThirdParty",
				"Python3",
				"Linux",
				"bin",
				"python3",
			),
			join(
				config.enginePath,
				"Engine",
				"Binaries",
				"ThirdParty",
				"Python3",
				"Mac",
				"bin",
				"python3",
			),
		].find((candidate) => existsSync(candidate));
		if (bundled) return bundled;
	}
	return process.platform === "win32" ? "python" : "python3";
}

export function readRonPaths(toolsDir: string): Record<string, string> | undefined {
	const file = join(toolsDir, "ronfw.config.json");
	if (!existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
		const paths: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string") paths[key] = value;
		}
		return paths;
	} catch {
		return undefined;
	}
}

function readVersion(script: string): string | undefined {
	try {
		const head = readFileSync(script, "utf-8").slice(0, 4000);
		return /^VERSION\s*=\s*"([^"]+)"/m.exec(head)?.[1];
	} catch {
		return undefined;
	}
}

export function findFramework(config: UnrealMcpConfig): RonFramework | undefined {
	const script = locateScript(config);
	if (!script) return undefined;
	const toolsDir = dirname(script);
	return {
		root: dirname(toolsDir),
		toolsDir,
		script,
		python: findPython(config),
		paths: readRonPaths(toolsDir),
		version: readVersion(script),
	};
}

export function listProfiles(toolsDir: string): RonProfile[] {
	const dir = join(toolsDir, "profiles");
	if (!existsSync(dir)) return [];
	const profiles: RonProfile[] = [];
	for (const file of readdirSync(dir).sort()) {
		if (!file.toLowerCase().endsWith(".json")) continue;
		try {
			const data = JSON.parse(readFileSync(join(dir, file), "utf-8")) as {
				name?: string;
				maps?: string[];
				pak_name?: string;
			};
			profiles.push({
				name: data.name ?? file.replace(/\.json$/i, ""),
				maps: Array.isArray(data.maps) ? data.maps : [],
				pakName: data.pak_name,
			});
		} catch {
			// A profile that does not parse is skipped; ronfw reports it itself.
		}
	}
	return profiles;
}

/**
 * Where the game's own exported content is, mounted the way the project mounts it: the Content
 * folder is /Game, and each DLC's game feature plugin has its own mount.
 */
export function gameContentRoots(paths: Record<string, string> | undefined): GameContentRoot[] {
	if (!paths) return [];
	const base = paths.content_root ?? (paths.export_dir ? join(paths.export_dir, "ReadyOrNot") : "");
	if (!base) return [];
	const roots: GameContentRoot[] = [];
	const content = join(base, "Content");
	if (existsSync(content)) roots.push({ mount: "Game", dir: content });
	const features = join(base, "Plugins", "GameFeatures");
	if (existsSync(features)) {
		for (const name of readdirSync(features)) {
			const dir = join(features, name, "Content");
			if (existsSync(dir)) roots.push({ mount: name, dir });
		}
	}
	return roots;
}
