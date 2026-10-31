import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gameContentRoots } from "../src/ron/framework.js";
import { ProtectedContentError, WriteGuard } from "../src/utils/protect.js";
import { type Fixture, createFixture } from "./helpers/fixtures.js";

describe("WriteGuard", () => {
	let fx: Fixture;
	beforeEach(() => {
		fx = createFixture();
	});
	afterEach(() => fx.cleanup());

	const guard = (extra: Partial<ConstructorParameters<typeof WriteGuard>[0]> = {}) =>
		new WriteGuard({ projectPath: fx.project, ...extra });

	describe("hard-linked content", () => {
		it("refuses an asset whose file has another hard link", () => {
			const reason = guard().check("/Game/ReadyOrNot/Props/Chair", "asset");
			expect(reason).toMatch(/hard-linked/);
		});

		it("reads the asset out of object paths, sub-object paths and file paths", () => {
			const g = guard();
			expect(g.check("/Game/ReadyOrNot/Props/Chair.Chair", "asset")).toBeDefined();
			expect(g.check("/Game/ReadyOrNot/Props/Chair.Chair:Mesh", "asset")).toBeDefined();
			expect(g.check("/Game/ReadyOrNot/Props/Chair.uasset", "asset")).toBeDefined();
			expect(
				g.check(`${fx.projectDir}/Content/ReadyOrNot/Props/Chair.uasset`, "asset"),
			).toBeDefined();
			expect(g.check("\\Game\\ReadyOrNot\\Props\\Chair", "asset")).toBeDefined();
		});

		it("follows .. out of the mapper's folder", () => {
			expect(guard().check("/Game/Mods/Me/../../ReadyOrNot/Props/Chair", "asset")).toBeDefined();
		});

		it("finds linked files in plugin (DLC) content", () => {
			expect(guard().check("/ReadyOrNotDLC2/Dlc/Thing", "asset")).toMatch(/hard-linked/);
		});

		it("allows the mapper's own assets, existing or new", () => {
			const g = guard();
			expect(g.check("/Game/Mods/Me/MyMap", "asset")).toBeUndefined();
			expect(g.check("/Game/Mods/Me/Props/Crate.Crate", "asset")).toBeUndefined();
			expect(g.check("/Game/Mods/Me/Props/NewThing", "asset")).toBeUndefined();
		});

		it("refuses a folder that holds linked files, however deep", () => {
			const g = guard();
			expect(g.check("/Game/ReadyOrNot", "directory")).toMatch(/hard-linked/);
			expect(g.check("/Game/ReadyOrNot/Props", "directory")).toBeDefined();
			expect(g.check("/Game", "directory")).toBeDefined();
			expect(g.check("/Game/", "directory")).toBeDefined();
		});

		it("allows the mapper's own folders, existing or new", () => {
			const g = guard();
			expect(g.check("/Game/Mods", "directory")).toBeUndefined();
			expect(g.check("/Game/Mods/Me", "directory")).toBeUndefined();
			expect(g.check("/Game/Mods/Me/NewFolder", "directory")).toBeUndefined();
		});

		it("can be turned off", () => {
			const g = guard({ protectLinkedContent: false });
			expect(g.check("/Game/ReadyOrNot/Props/Chair", "asset")).toBeUndefined();
			expect(g.check("/Game", "directory")).toBeUndefined();
		});
	});

	describe("the game export", () => {
		const content = () => gameContentRoots({ content_root: fx.exportDir });

		it("refuses a file the editor re-saved, which has lost its link", () => {
			// Table.uasset in the project is a separate file now, but the export has it
			expect(guard().check("/Game/ReadyOrNot/Props/Table", "asset")).toBeUndefined();
			expect(
				guard({ gameContent: content }).check("/Game/ReadyOrNot/Props/Table", "asset"),
			).toMatch(/exported game content/);
		});

		it("refuses folders that exist in the export, even empty ones", () => {
			expect(guard({ gameContent: content }).check("/Game/ReadyOrNot", "directory")).toMatch(
				/exported game content/,
			);
		});

		it("finds game content mounts for DLC plugins", () => {
			expect(
				content()
					.map((root) => root.mount)
					.sort(),
			).toEqual(["Game", "ReadyOrNotDLC2"]);
		});

		it("returns nothing when the export is unknown or missing", () => {
			expect(gameContentRoots(undefined)).toEqual([]);
			expect(gameContentRoots({ content_root: `${fx.root}/nowhere` })).toEqual([]);
		});
	});

	describe("rules that do not depend on the files", () => {
		it("always refuses engine content", () => {
			expect(
				guard({ protectLinkedContent: false }).check("/Engine/BasicShapes/Cube", "asset"),
			).toMatch(/engine content/);
			expect(guard().check("/engine", "directory")).toMatch(/engine content/);
		});

		it("refuses paths under protectedPaths, whatever the case or slashes", () => {
			const g = guard({ protectedPaths: ["/Game/Mods/Me/Props/", "game/Mods/Other"] });
			expect(g.check("/Game/Mods/Me/Props/Crate", "asset")).toMatch(/protectedPaths/);
			expect(g.check("/game/mods/me/props/NewThing", "asset")).toMatch(/protectedPaths/);
			expect(g.check("/Game/Mods/Other", "directory")).toMatch(/protectedPaths/);
			expect(g.check("/Game/Mods/Me/MyMap", "asset")).toBeUndefined();
			expect(g.check("/Game/Mods/Me/PropsExtra/Thing", "asset")).toBeUndefined();
		});

		it("has no opinion about text that is not a content path", () => {
			const g = guard();
			for (const text of [
				"",
				"  ",
				"SampleName",
				"Game/ReadyOrNot/Props/Chair",
				"C:/elsewhere/file.uasset",
			]) {
				expect(g.check(text, "asset"), text).toBeUndefined();
			}
		});

		it("does not fail when there is no project", () => {
			const g = new WriteGuard({ projectPath: "" });
			expect(g.check("/Game/Anything", "asset")).toBeUndefined();
			expect(g.check("/Engine/Anything", "asset")).toBeDefined();
		});
	});

	it("assertWritable throws an error that explains what to do", () => {
		const g = guard();
		expect(() => g.assertWritable([{ path: "/Game/Mods/Me/MyMap", kind: "asset" }])).not.toThrow();
		try {
			g.assertWritable([{ path: "/Game/ReadyOrNot/Props/Chair", kind: "asset" }]);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(ProtectedContentError);
			const message = (error as Error).message;
			expect(message).toContain("/Game/ReadyOrNot/Props/Chair");
			expect(message).toContain("/Game/Mods/<YourName>/");
			expect(message).toContain("protectLinkedContent");
		}
	});
});
