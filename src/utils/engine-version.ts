import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface EngineVersion {
	major: number;
	minor: number;
	patch: number;
	/** The text the version was parsed from, for display. */
	raw: string;
}

/**
 * Parse an Unreal version string: "5.3", "5.3.2", "UE_5.3" or the editor's
 * "5.3.2-29314046+++UE5+Release-5.3".
 */
export function parseEngineVersion(text: string | undefined | null): EngineVersion | undefined {
	if (!text) return undefined;
	const match = /(?:^|[^0-9.])(\d+)\.(\d+)(?:\.(\d+))?/.exec(text.trim());
	if (!match) return undefined;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: match[3] ? Number(match[3]) : 0,
		raw: text.trim(),
	};
}

/** Negative if a < b, zero if equal, positive if a > b. Patch level is compared too. */
export function compareVersions(a: EngineVersion, b: EngineVersion): number {
	return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Whether `version` is at least `min` (e.g. "5.5"). Returns undefined when the version is unknown,
 * so callers can decide whether to try anyway.
 */
export function isAtLeast(version: EngineVersion | undefined, min: string): boolean | undefined {
	if (!version) return undefined;
	const wanted = parseEngineVersion(min);
	if (!wanted) throw new Error(`Invalid minimum engine version: ${min}`);
	return compareVersions(version, wanted) >= 0;
}

export function formatVersion(version: EngineVersion): string {
	return `${version.major}.${version.minor}.${version.patch}`;
}

/** Read Engine/Build/Build.version, which ships with every engine install. */
export function readBuildVersion(enginePath: string | undefined): EngineVersion | undefined {
	if (!enginePath) return undefined;
	const file = join(enginePath, "Engine", "Build", "Build.version");
	if (!existsSync(file)) return undefined;
	try {
		const json = JSON.parse(readFileSync(file, "utf-8")) as {
			MajorVersion?: number;
			MinorVersion?: number;
			PatchVersion?: number;
		};
		if (typeof json.MajorVersion !== "number" || typeof json.MinorVersion !== "number") {
			return undefined;
		}
		const patch = json.PatchVersion ?? 0;
		return {
			major: json.MajorVersion,
			minor: json.MinorVersion,
			patch,
			raw: `${json.MajorVersion}.${json.MinorVersion}.${patch}`,
		};
	} catch {
		return undefined;
	}
}
