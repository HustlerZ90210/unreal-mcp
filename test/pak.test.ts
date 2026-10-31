import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type PakListing,
	auditListing,
	findConflicts,
	findPaks,
	gamePath,
	parseMountPoint,
	parsePakListLine,
} from "../src/pak/unrealpak.js";
import { registerAllTools } from "../src/tools/index.js";
import {
	type ToolData,
	createFakeManager,
	createFakeServer,
	testConfig,
} from "./helpers/harness.js";

// What UnrealPak -List prints, as seen in a public script for UE 4.25 and as newer engines extend it.
const OLD_LINE =
	'LogPakFile: Display: "ReadyOrNot/Content/Mods/Me/Map.umap" offset: 0, size: 1234 bytes, sha1: ABCDEF0123456789ABCDEF0123456789ABCDEF01, compression: Zlib';
const NEW_LINE =
	'[2026.10.31-05.10.11:123][  0]LogPakFile: Display: "ReadyOrNot/Content/Mods/Me/Map.uexp" offset: 1300, size: 5000 bytes, sha1: ABCDEF0123456789ABCDEF0123456789ABCDEF01, compression method: Oodle, compressed size: 2100, compression block size: 65536, encrypted: false.';

describe("parsePakListLine", () => {
	it("reads the older format", () => {
		expect(parsePakListLine(OLD_LINE)).toEqual({
			path: "ReadyOrNot/Content/Mods/Me/Map.umap",
			offset: 0,
			size: 1234,
		});
	});

	it("reads the newer format, with a log time prefix and the compressed size", () => {
		expect(parsePakListLine(NEW_LINE)).toEqual({
			path: "ReadyOrNot/Content/Mods/Me/Map.uexp",
			offset: 1300,
			size: 5000,
			compressedSize: 2100,
		});
	});

	it("keeps spaces and hyphens in paths", () => {
		const line = 'LogPakFile: Display: "Game/Content/My Mod/a-b c.uasset" offset: 5, size: 7 bytes';
		expect(parsePakListLine(line)?.path).toBe("Game/Content/My Mod/a-b c.uasset");
	});

	it("ignores lines that are not entries", () => {
		for (const line of [
			"LogPakFile: Display: Mount point ../../../",
			"LogInit: Display: Unreal Engine 5.3",
			"",
			'"quoted" without the rest',
		]) {
			expect(parsePakListLine(line), line).toBeUndefined();
		}
	});

	it("reads the mount point", () => {
		expect(parseMountPoint("LogPakFile: Display: Mount point ../../../")).toBe("../../../");
		expect(parseMountPoint('LogPakFile: Display: Mount point "../../../ReadyOrNot/Content/"')).toBe(
			"../../../ReadyOrNot/Content/",
		);
		expect(parseMountPoint(OLD_LINE)).toBeUndefined();
	});
});

describe("gamePath", () => {
	it("drops the leading ../ of the mount point", () => {
		expect(gamePath("../../../", "ReadyOrNot/Content/A.uasset")).toBe(
			"ReadyOrNot/Content/A.uasset",
		);
		expect(gamePath("../../../ReadyOrNot/Content/", "Mods/A.uasset")).toBe(
			"ReadyOrNot/Content/Mods/A.uasset",
		);
		expect(gamePath(undefined, "A\\B\\C.uasset")).toBe("A/B/C.uasset");
		expect(gamePath("", "/A//B.uasset")).toBe("A/B.uasset");
	});
});

const listing = (
	pak: string,
	entries: [string, number][],
	mountPoint: string | undefined = "../../../",
): PakListing => ({
	pak,
	mountPoint,
	entries: entries.map(([path, size], i) => ({ path, size, offset: i })),
});

describe("auditListing", () => {
	const mod = listing("mod.pak", [
		["ReadyOrNot/Content/Mods/Me/Map.umap", 10],
		["ReadyOrNot/Content/Mods/Me/Props/Crate.uasset", 20],
		["ReadyOrNot/Content/ReadyOrNot/Props/Chair.uasset", 300],
		["ReadyOrNot/Config/Difficulties/Mine.ini", 5],
		["ReadyOrNot/Content/ModsExtra/Thing.uasset", 7],
	]);

	it("lists the files outside the allowed folders", () => {
		const result = auditListing(mod, [
			"ReadyOrNot/Content/Mods/Me/",
			"ReadyOrNot/Config/Difficulties",
		]);
		expect(result.checked).toBe(5);
		expect(result.outside).toEqual([
			{ path: "ReadyOrNot/Content/ReadyOrNot/Props/Chair.uasset", size: 300 },
			{ path: "ReadyOrNot/Content/ModsExtra/Thing.uasset", size: 7 },
		]);
	});

	it("does not mistake a longer folder name for the allowed folder", () => {
		expect(auditListing(mod, ["ReadyOrNot/Content/Mods"]).outside.map((f) => f.path)).toContain(
			"ReadyOrNot/Content/ModsExtra/Thing.uasset",
		);
	});

	it("ignores case and leading slashes or ../", () => {
		expect(auditListing(mod, ["../../../readyornot/CONTENT/mods/me/"]).outside).toHaveLength(3);
		expect(auditListing(mod, ["/ReadyOrNot"]).outside).toHaveLength(0);
	});

	it('lets "*" stand for one folder name, such as the project name', () => {
		expect(auditListing(mod, ["*/Content/Mods/Me/", "*/Config/"]).outside).toHaveLength(2);
		expect(auditListing(mod, ["*/Mods/"]).outside).toHaveLength(5);
	});

	it("understands paks that mount below the game folder", () => {
		const nested = listing(
			"nested.pak",
			[
				["Mods/Me/Map.umap", 10],
				["ReadyOrNot/Props/Chair.uasset", 3],
			],
			"../../../ReadyOrNot/Content/",
		);
		expect(auditListing(nested, ["ReadyOrNot/Content/Mods/Me/"]).outside).toEqual([
			{ path: "ReadyOrNot/Content/ReadyOrNot/Props/Chair.uasset", size: 3 },
		]);
	});

	it("passes an empty pak", () => {
		expect(auditListing(listing("empty.pak", []), ["X/"])).toEqual({ checked: 0, outside: [] });
	});
});

describe("findConflicts", () => {
	it("finds files in more than one pak, ignoring case and how the paks mount", () => {
		const a = listing("a.pak", [
			["ReadyOrNot/Content/X/One.uasset", 1],
			["ReadyOrNot/Content/X/Only-A.uasset", 1],
		]);
		const b = listing("b.pak", [["readyornot/content/x/ONE.uasset", 2]]);
		const c = listing(
			"c.pak",
			[
				["X/One.uasset", 3],
				["X/Two.uasset", 3],
			],
			"../../../ReadyOrNot/Content/",
		);
		const d = listing("d.pak", [["ReadyOrNot/Content/X/Two.uasset", 4]]);
		const conflicts = findConflicts([a, b, c, d]);
		expect(conflicts.map((x) => x.path)).toEqual([
			"ReadyOrNot/Content/X/One.uasset",
			"ReadyOrNot/Content/X/Two.uasset",
		]);
		expect(conflicts[0].paks.map((p) => p.pak)).toEqual(["a.pak", "b.pak", "c.pak"]);
		expect(conflicts[1].paks.map((p) => p.pak)).toEqual(["c.pak", "d.pak"]);
	});

	it("does not count a path twice in one pak, and reports nothing when nothing is shared", () => {
		const a = listing("a.pak", [
			["A/x.uasset", 1],
			["A/x.uasset", 1],
		]);
		const b = listing("b.pak", [["A/y.uasset", 1]]);
		expect(findConflicts([a, b])).toEqual([]);
		expect(findConflicts([])).toEqual([]);
	});
});

describe("findPaks", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mcp paks "));
		mkdirSync(join(dir, "sub"));
		for (const name of ["b.pak", "a.PAK", "notes.txt", join("sub", "c.pak")])
			writeFileSync(join(dir, name), "");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("lists .pak files by name, with or without sub-folders", () => {
		expect(findPaks(dir, false).map((p) => p.slice(dir.length + 1))).toEqual(["a.PAK", "b.pak"]);
		expect(findPaks(dir, true)).toHaveLength(3);
	});

	it("rejects a path that is not a folder", () => {
		expect(() => findPaks(join(dir, "nowhere"), false)).toThrow(/Not a folder/);
		expect(() => findPaks(join(dir, "a.PAK"), false)).toThrow(/Not a folder/);
	});
});

describe("pak tools", () => {
	let dir: string;
	let call: (
		tool: string,
		args: Record<string, unknown>,
	) => Promise<{ isError?: boolean; data: ToolData }>;

	/** A stand-in for UnrealPak that prints <pak>.list, and fails if <pak>.fail exists. */
	function installFakeUnrealPak(): string {
		if (process.platform === "win32") {
			const file = join(dir, "UnrealPak.cmd");
			writeFileSync(file, '@echo off\r\ntype "%~1.list"\r\nif exist "%~1.fail" exit /b 2\r\n');
			return file;
		}
		const file = join(dir, "UnrealPak");
		writeFileSync(file, '#!/bin/sh\ncat "$1.list"\n[ -f "$1.fail" ] && exit 2\nexit 0\n');
		chmodSync(file, 0o755);
		return file;
	}

	const makePak = (name: string, lines: string[]): string => {
		const pak = join(dir, name);
		writeFileSync(pak, "pak");
		writeFileSync(`${pak}.list`, `${lines.join("\n")}\n`);
		return pak;
	};
	const entry = (path: string, size: number, offset = 0) =>
		`LogPakFile: Display: "${path}" offset: ${offset}, size: ${size} bytes, sha1: AB, compression: Zlib`;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mcp pak tools "));
		const { server, tools } = createFakeServer();
		const config = testConfig({ unrealPakPath: installFakeUnrealPak() });
		registerAllTools(
			server as never,
			createFakeManager({ python: [], calls: [] }) as never,
			config,
		);
		call = async (tool, args) => {
			const registered = tools.get(tool);
			if (!registered) throw new Error(`no tool ${tool}`);
			const result = (await registered.handler(z.object(registered.shape).parse(args))) as {
				isError?: boolean;
				content: { text: string }[];
			};
			return { isError: result.isError, data: JSON.parse(result.content[0].text) };
		};
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("pak_list reports totals, folders and files", async () => {
		const pak = makePak("mod.pak", [
			"LogPakFile: Display: Mount point ../../../",
			entry("ReadyOrNot/Content/Mods/Me/Map.umap", 100),
			entry("ReadyOrNot/Content/Mods/Me/Props/Crate.uasset", 50),
			entry("ReadyOrNot/Content/Mods/Me/Props/Crate.uexp", 25),
			"LogPakFile: Display: Done",
		]);
		const { data, isError } = await call("pak_list", { pak });
		expect(isError).toBeUndefined();
		expect(data).toMatchObject({
			file_count: 3,
			total_size_bytes: 175,
			matched: 3,
			truncated: false,
			mount_point: "../../../",
		});
		expect(data.files.map((f: { path: string }) => f.path)).toEqual([
			"ReadyOrNot/Content/Mods/Me/Map.umap",
			"ReadyOrNot/Content/Mods/Me/Props/Crate.uasset",
			"ReadyOrNot/Content/Mods/Me/Props/Crate.uexp",
		]);
		expect(data.biggest_folders[0]).toEqual({
			folder: "ReadyOrNot/Content/Mods",
			files: 3,
			size: 175,
		});
	});

	it("pak_list filters and limits, but the totals cover the whole pak", async () => {
		const pak = makePak("many.pak", [
			entry("A/one.uasset", 1),
			entry("A/two.uasset", 2),
			entry("B/three.uasset", 4),
		]);
		const filtered = await call("pak_list", { pak, filter: "A/" });
		expect(filtered.data).toMatchObject({ file_count: 3, matched: 2, truncated: false });
		const limited = await call("pak_list", { pak, limit: 1 });
		expect(limited.data).toMatchObject({ matched: 3, truncated: true, total_size_bytes: 7 });
		expect(limited.data.files).toHaveLength(1);
	});

	it("reads every file of a very large pak", async () => {
		const lines: string[] = [];
		for (let i = 0; i < 60_000; i++)
			lines.push(entry(`ReadyOrNot/Content/Big/File_${i}.uasset`, 10, i));
		const pak = makePak("big.pak", lines);
		const { data } = await call("pak_list", { pak, limit: 1 });
		expect(data.file_count).toBe(60_000);
		expect(data.total_size_bytes).toBe(600_000);
	});

	it("reports UnrealPak failing, with what it printed", async () => {
		const pak = makePak("locked.pak", ["LogPakFile: Error: Pak file is encrypted"]);
		writeFileSync(`${pak}.fail`, "");
		const { data, isError } = await call("pak_list", { pak });
		expect(isError).toBe(true);
		expect(data).toMatchObject({ error: "UNREALPAK_FAILED", exitCode: 2 });
		expect(data.output).toContain("encrypted");
	});

	it("refuses to report an empty pak when it could not read the file lines", async () => {
		const pak = makePak("odd.pak", ['LogPakFile: Display: "A/x.uasset" offset=0 size=5']);
		const { data, isError } = await call("pak_list", { pak });
		expect(isError).toBe(true);
		expect(data.error).toBe("PAK_LIST_FORMAT");
		expect(data.example_lines[0]).toContain("offset=0");
	});

	it("says so when the pak or UnrealPak is missing", async () => {
		const missing = await call("pak_list", { pak: join(dir, "nowhere.pak") });
		expect(missing.data.error).toBe("PAK_NOT_FOUND");

		const { server, tools } = createFakeServer();
		registerAllTools(
			server as never,
			createFakeManager({ python: [], calls: [] }) as never,
			testConfig({ enginePath: join(dir, "no-engine"), unrealPakPath: undefined }),
		);
		const tool = tools.get("pak_list");
		const pak = makePak("x.pak", []);
		const result = (await tool?.handler(z.object(tool?.shape ?? {}).parse({ pak }))) as {
			isError?: boolean;
			content: { text: string }[];
		};
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text).error).toBe("UNREALPAK_NOT_FOUND");
	});

	it("pak_audit finds files outside the allowed folders", async () => {
		const pak = makePak("audit.pak", [
			entry("ReadyOrNot/Content/Mods/Me/Map.umap", 100),
			entry("ReadyOrNot/Content/ReadyOrNot/Props/Chair.uasset", 4000),
		]);
		const bad = await call("pak_audit", { pak, allowed_prefixes: ["ReadyOrNot/Content/Mods/Me/"] });
		expect(bad.isError).toBeUndefined();
		expect(bad.data).toMatchObject({
			ok: false,
			files_checked: 2,
			files_outside: 1,
			size_outside_bytes: 4000,
		});
		expect(bad.data.outside).toEqual([
			{ path: "ReadyOrNot/Content/ReadyOrNot/Props/Chair.uasset", size: 4000 },
		]);

		const good = await call("pak_audit", { pak, allowed_prefixes: ["ReadyOrNot/Content/"] });
		expect(good.data).toMatchObject({ ok: true, files_outside: 0 });
	});

	it("pak_conflicts compares the paks it is given or the paks in a folder", async () => {
		const a = makePak("a.pak", [
			entry("G/Content/X/One.uasset", 1),
			entry("G/Content/X/A.uasset", 1),
		]);
		const b = makePak("b.pak", [
			entry("G/Content/X/one.uasset", 2),
			entry("G/Content/Y/B.uasset", 2),
		]);
		makePak("c.pak", [entry("G/Content/X/One.uasset", 3), entry("G/Content/Y/b.uasset", 3)]);

		const two = await call("pak_conflicts", { paks: [a, b] });
		expect(two.data.conflict_count).toBe(1);
		expect(two.data.conflicts[0]).toMatchObject({ in: ["a.pak", "b.pak"] });

		const folder = await call("pak_conflicts", { folder: dir, show: 1 });
		expect(folder.data.paks.map((p: { pak: string }) => p.pak.slice(dir.length + 1))).toEqual([
			"a.pak",
			"b.pak",
			"c.pak",
		]);
		expect(folder.data).toMatchObject({ conflict_count: 2, truncated: true });
		expect(folder.data.conflicts[0].in).toEqual(["a.pak", "b.pak", "c.pak"]);
		expect(folder.data.pairs[0]).toEqual({ between: "b.pak + c.pak", files: 2 });
		expect(folder.data.pairs).toHaveLength(3);
	});

	it("pak_conflicts needs two paks", async () => {
		const a = makePak("a.pak", [entry("G/x.uasset", 1)]);
		expect((await call("pak_conflicts", { paks: [a] })).isError).toBe(true);
		expect((await call("pak_conflicts", {})).isError).toBe(true);
	});
});
