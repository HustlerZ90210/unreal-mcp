import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
	let home: string;
	let work: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "mcp-home-"));
		work = mkdtempSync(join(tmpdir(), "mcp-work-"));
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		for (const name of [
			"UNREAL_MCP_PROJECT_PATH",
			"UNREAL_MCP_ENGINE_PATH",
			"UNREAL_MCP_ENGINE_VERSION",
			"UNREAL_MCP_RC_PORT",
			"UNREAL_MCP_MODULES",
		]) {
			vi.stubEnv(name, "");
		}
		vi.spyOn(process, "cwd").mockReturnValue(work);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(home, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	});

	function makeEngine(root: string, version: { major: number; minor: number; patch: number }) {
		mkdirSync(join(root, "Engine", "Build"), { recursive: true });
		writeFileSync(
			join(root, "Engine", "Build", "Build.version"),
			JSON.stringify({
				MajorVersion: version.major,
				MinorVersion: version.minor,
				PatchVersion: version.patch,
			}),
		);
	}

	it("prefers command line over environment over config file", () => {
		writeFileSync(join(work, ".unrealmcp.json"), JSON.stringify({ remoteControlPort: 1111 }));
		expect(loadConfig([]).remoteControlPort).toBe(1111);

		vi.stubEnv("UNREAL_MCP_RC_PORT", "2222");
		expect(loadConfig([]).remoteControlPort).toBe(2222);

		expect(loadConfig(["--rc-port", "3333"]).remoteControlPort).toBe(3333);
	});

	it("takes an explicit engine version from the command line or environment", () => {
		vi.stubEnv("UNREAL_MCP_ENGINE_VERSION", "5.4");
		expect(loadConfig([]).engineVersion).toBe("5.4");
		expect(loadConfig(["--engine-version", "5.3.2"]).engineVersion).toBe("5.3.2");
	});

	it("reads the version from the engine install", () => {
		const engine = join(home, "Epic Games", "UE_5.3");
		makeEngine(engine, { major: 5, minor: 3, patch: 2 });
		const config = loadConfig(["--engine-path", engine]);
		expect(config.engineVersion).toBe("5.3.2");
	});

	it("falls back to the project's EngineAssociation", () => {
		const project = join(work, "Game");
		mkdirSync(project);
		writeFileSync(join(project, "Game.uproject"), JSON.stringify({ EngineAssociation: "5.3" }));
		const config = loadConfig(["--project-path", project]);
		expect(config.engineVersion).toBe("5.3");
	});

	it("ignores an EngineAssociation that is a GUID", () => {
		const project = join(work, "Game");
		mkdirSync(project);
		writeFileSync(
			join(project, "Game.uproject"),
			JSON.stringify({ EngineAssociation: "{8F3E1C7A-0000-4000-8000-123456789ABC}" }),
		);
		expect(loadConfig(["--project-path", project]).engineVersion).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")("finds an engine installed in the home folder", () => {
		const project = join(work, "Game");
		mkdirSync(project);
		writeFileSync(join(project, "Game.uproject"), JSON.stringify({ EngineAssociation: "5.3" }));
		const engine = join(home, "UE_5.3");
		makeEngine(engine, { major: 5, minor: 3, patch: 2 });
		const config = loadConfig(["--project-path", join(project, "Game.uproject")]);
		expect(config.enginePath).toBe(engine);
		expect(config.engineVersion).toBe("5.3.2");
	});

	it("limits tools to the enabled modules", () => {
		expect(loadConfig(["--modules", "console, asset"]).enabledModules).toEqual(["console", "asset"]);
	});
});
