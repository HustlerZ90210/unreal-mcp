import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	compareVersions,
	formatVersion,
	isAtLeast,
	parseEngineVersion,
	readBuildVersion,
} from "../src/utils/engine-version.js";

describe("parseEngineVersion", () => {
	it.each([
		["5.3", 5, 3, 0],
		["5.3.2", 5, 3, 2],
		["UE_5.3", 5, 3, 0],
		["5.3.2-29314046+++UE5+Release-5.3", 5, 3, 2],
		["  5.4.1 ", 5, 4, 1],
		["C:\\Program Files\\Epic Games\\UE_5.3", 5, 3, 0],
	])("reads %j", (text, major, minor, patch) => {
		expect(parseEngineVersion(text)).toMatchObject({ major, minor, patch });
	});

	it.each([[undefined], [null], [""], ["Release"], ["{8F3E1C7A-0000-4000-8000-123456789ABC}"]])(
		"gives up on %j",
		(text) => {
			expect(parseEngineVersion(text as string | undefined)).toBeUndefined();
		},
	);
});

describe("version comparison", () => {
	const v = (s: string) => parseEngineVersion(s) as NonNullable<ReturnType<typeof parseEngineVersion>>;

	it("orders by major, minor, then patch", () => {
		expect(compareVersions(v("5.3.2"), v("5.3.2"))).toBe(0);
		expect(compareVersions(v("5.3.2"), v("5.3.1"))).toBeGreaterThan(0);
		expect(compareVersions(v("5.3.2"), v("5.4"))).toBeLessThan(0);
		expect(compareVersions(v("6.0"), v("5.9.9"))).toBeGreaterThan(0);
	});

	it("answers isAtLeast, and says so when the version is unknown", () => {
		expect(isAtLeast(v("5.3.2"), "5.3")).toBe(true);
		expect(isAtLeast(v("5.3.2"), "5.3.2")).toBe(true);
		expect(isAtLeast(v("5.3.2"), "5.3.3")).toBe(false);
		expect(isAtLeast(v("5.3.2"), "5.5")).toBe(false);
		expect(isAtLeast(undefined, "5.5")).toBeUndefined();
		expect(() => isAtLeast(v("5.3"), "five")).toThrow(/Invalid minimum/);
	});

	it("formats as major.minor.patch", () => {
		expect(formatVersion(v("5.3"))).toBe("5.3.0");
	});
});

describe("readBuildVersion", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mcp-engine-"));
		mkdirSync(join(dir, "Engine", "Build"), { recursive: true });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("reads Engine/Build/Build.version", () => {
		writeFileSync(
			join(dir, "Engine", "Build", "Build.version"),
			JSON.stringify({ MajorVersion: 5, MinorVersion: 3, PatchVersion: 2, Changelist: 1 }),
		);
		expect(readBuildVersion(dir)).toMatchObject({ major: 5, minor: 3, patch: 2 });
	});

	it("returns undefined for a missing, broken or incomplete file", () => {
		expect(readBuildVersion(undefined)).toBeUndefined();
		expect(readBuildVersion(dir)).toBeUndefined();
		writeFileSync(join(dir, "Engine", "Build", "Build.version"), "{ not json");
		expect(readBuildVersion(dir)).toBeUndefined();
		writeFileSync(join(dir, "Engine", "Build", "Build.version"), JSON.stringify({ MajorVersion: 5 }));
		expect(readBuildVersion(dir)).toBeUndefined();
	});
});
