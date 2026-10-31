import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProject, ubtTargetName } from "../src/utils/project.js";

describe("resolveProject", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mcp project "));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("accepts a .uproject path, even if the file is not there yet", () => {
		const path = join(dir, "My Game.uproject");
		expect(resolveProject(path)).toEqual({ uprojectPath: path, name: "My Game", dir });
	});

	it("finds the .uproject inside a folder", () => {
		writeFileSync(join(dir, "RoN.uproject"), "{}");
		expect(resolveProject(dir)).toEqual({
			uprojectPath: join(dir, "RoN.uproject"),
			name: "RoN",
			dir,
		});
	});

	it("returns nothing for an empty folder, a missing path or an empty string", () => {
		mkdirSync(join(dir, "empty"));
		expect(resolveProject(join(dir, "empty"))).toEqual({});
		expect(resolveProject(join(dir, "missing"))).toEqual({});
		expect(resolveProject("")).toEqual({});
	});
});

describe("ubtTargetName", () => {
	it("turns target types into target names", () => {
		expect(ubtTargetName("Editor", "MyGame")).toBe("MyGameEditor");
		expect(ubtTargetName("editor", "MyGame")).toBe("MyGameEditor");
		expect(ubtTargetName("Game", "MyGame")).toBe("MyGame");
		expect(ubtTargetName("Client", "MyGame")).toBe("MyGameClient");
		expect(ubtTargetName("Server", "MyGame")).toBe("MyGameServer");
	});

	it("passes real target names and unknown projects through", () => {
		expect(ubtTargetName("MyGameEditor", "MyGame")).toBe("MyGameEditor");
		expect(ubtTargetName("Editor", undefined)).toBe("Editor");
	});
});
