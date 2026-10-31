import { describe, expect, it } from "vitest";
import { registerAllTools } from "../src/tools/index.js";
import { ConnectionManager } from "../src/transports/connection-manager.js";
import { ALL_MODULES } from "../src/types.js";
import { parseEngineVersion } from "../src/utils/engine-version.js";
import { UnsupportedEngineError } from "../src/utils/errors.js";
import { createFakeManager, createFakeServer, testConfig } from "./helpers/harness.js";

function registerEverything(config = testConfig()) {
	const { server, tools } = createFakeServer();
	const recording = { python: [] as string[], calls: [] };
	registerAllTools(server as never, createFakeManager(recording) as never, config);
	return tools;
}

describe("tool registration", () => {
	const tools = registerEverything();

	it("registers 127 or more tools", () => {
		expect(tools.size).toBeGreaterThanOrEqual(127);
	});

	it("gives every tool a snake_case name and a description", () => {
		for (const tool of tools.values()) {
			expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
			expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(10);
		}
	});

	it("loads only the enabled modules", () => {
		const some = registerEverything(testConfig({ enabledModules: ["console"] }));
		expect(some.size).toBeGreaterThan(0);
		expect(some.size).toBeLessThan(tools.size);
		expect(some.has("execute_python")).toBe(true);
		expect(some.has("list_data_layers")).toBe(false);
	});

	it("has a registrar for every module name", () => {
		for (const module of ALL_MODULES) {
			const only = registerEverything(testConfig({ enabledModules: [module] }));
			expect(only.size, module).toBeGreaterThan(0);
		}
	});
});

describe("engine version gate", () => {
	function managerWithVersion(version: string | undefined): ConnectionManager {
		const manager = new ConnectionManager();
		(manager as unknown as { _engineVersion: unknown })._engineVersion =
			parseEngineVersion(version);
		return manager;
	}

	it("rejects a feature that needs a newer engine, naming both versions", async () => {
		const manager = managerWithVersion("5.3.2");
		const error = await manager
			.requireEngineAtLeast("5.5", "Adding Blueprint variables", "Use the plugin.")
			.catch((e) => e);
		expect(error).toBeInstanceOf(UnsupportedEngineError);
		expect(error.message).toContain("5.5");
		expect(error.message).toContain("5.3.2");
		expect(error.message).toContain("Use the plugin.");
	});

	it("allows a feature the engine supports", async () => {
		await expect(
			managerWithVersion("5.3.2").requireEngineAtLeast("5.3", "x"),
		).resolves.toBeUndefined();
	});

	it("lets the call through when the version is unknown", async () => {
		await expect(
			managerWithVersion(undefined).requireEngineAtLeast("5.5", "x"),
		).resolves.toBeUndefined();
	});
});
