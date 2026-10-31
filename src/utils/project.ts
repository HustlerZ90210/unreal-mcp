import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface ProjectInfo {
	/** Absolute path of the .uproject file, if one was found. */
	uprojectPath?: string;
	/** Project name: the .uproject file name without its extension. */
	name?: string;
	/** Folder that holds the .uproject file. */
	dir?: string;
}

/**
 * Resolve a configured project path, which may be a .uproject file or the folder holding one.
 */
export function resolveProject(projectPath: string): ProjectInfo {
	if (!projectPath) return {};

	if (projectPath.toLowerCase().endsWith(".uproject")) {
		return {
			uprojectPath: projectPath,
			name: basename(projectPath).replace(/\.uproject$/i, ""),
			dir: dirname(projectPath),
		};
	}

	try {
		if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) return {};
		const found = readdirSync(projectPath).find((entry) =>
			entry.toLowerCase().endsWith(".uproject"),
		);
		if (found) {
			return {
				uprojectPath: join(projectPath, found),
				name: found.replace(/\.uproject$/i, ""),
				dir: projectPath,
			};
		}
	} catch {
		// Unreadable folder: treat as not found
	}
	return {};
}

const TARGET_SUFFIX: Record<string, string> = {
	editor: "Editor",
	game: "",
	client: "Client",
	server: "Server",
};

/**
 * UnrealBuildTool wants a target name such as `MyGameEditor`, not a target type such as `Editor`.
 * Map the type words the tools accept to real target names; anything else is passed through.
 */
export function ubtTargetName(target: string, projectName: string | undefined): string {
	const suffix = TARGET_SUFFIX[target.toLowerCase()];
	if (suffix === undefined || !projectName) return target;
	return `${projectName}${suffix}`;
}
