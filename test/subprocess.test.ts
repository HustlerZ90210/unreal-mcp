import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	needsCmdShell,
	quoteCmdArg,
	runProcess,
} from "../src/transports/subprocess.js";
import { TimeoutError, UnrealMcpError } from "../src/utils/errors.js";

describe("quoteCmdArg", () => {
	it("leaves simple arguments alone", () => {
		expect(quoteCmdArg("-run=Cook")).toBe("-run=Cook");
		expect(quoteCmdArg("C:\\Projects\\X\\X.uproject")).toBe("C:\\Projects\\X\\X.uproject");
	});

	it("quotes arguments with spaces or shell characters", () => {
		expect(quoteCmdArg("C:\\Program Files\\Epic Games\\UE_5.3")).toBe(
			'"C:\\Program Files\\Epic Games\\UE_5.3"',
		);
		expect(quoteCmdArg("a&b")).toBe('"a&b"');
		expect(quoteCmdArg("a|b")).toBe('"a|b"');
		expect(quoteCmdArg("-map=Maps/A (copy)")).toBe('"-map=Maps/A (copy)"');
	});

	it("keeps a trailing backslash from escaping the closing quote", () => {
		expect(quoteCmdArg("C:\\My Dir\\")).toBe('"C:\\My Dir\\\\"');
	});

	it("quotes the empty string", () => {
		expect(quoteCmdArg("")).toBe('""');
	});

	it.each(['a"b', "100%", "a\nb", "a\rb", "a\0b"])("rejects %j", (arg) => {
		expect(() => quoteCmdArg(arg)).toThrow(UnrealMcpError);
	});
});

describe("needsCmdShell", () => {
	it("is only true for batch files on Windows", () => {
		expect(needsCmdShell("C:\\UE\\RunUAT.bat", "win32")).toBe(true);
		expect(needsCmdShell("C:\\UE\\Build.CMD", "win32")).toBe(true);
		expect(needsCmdShell("C:\\UE\\UnrealEditor-Cmd.exe", "win32")).toBe(false);
		expect(needsCmdShell("/opt/UE/RunUAT.sh", "linux")).toBe(false);
		expect(needsCmdShell("/opt/UE/RunUAT.bat", "linux")).toBe(false);
	});
});

describe("runProcess", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mcp run dir "));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function script(name: string, source: string): string {
		const file = join(dir, name);
		writeFileSync(file, source);
		return file;
	}

	it("passes arguments through untouched when the paths contain spaces", async () => {
		const file = script("print args.mjs", "console.log(JSON.stringify(process.argv.slice(2)))");
		const args = ["a b", "it's", "x&y", "-project=C:/My Games/Game.uproject", ""];
		const result = await runProcess(process.execPath, [file, ...args], 10_000, { cwd: dir });
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(args);
	});

	it("runs in the requested folder", async () => {
		const file = script("cwd.mjs", "console.log(process.cwd())");
		const result = await runProcess(process.execPath, [file], 10_000, { cwd: dir });
		expect(result.stdout.trim().toLowerCase()).toContain("mcp run dir");
	});

	it("reports the exit code and stderr of a failing program", async () => {
		const file = script("fail.mjs", "console.error('boom'); process.exit(3)");
		const result = await runProcess(process.execPath, [file], 10_000);
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("boom");
	});

	it("parses compiler diagnostics from the output", async () => {
		const file = script(
			"diag.mjs",
			"console.log(\"C:/P/Source/A.cpp(12,5): error C2065: 'x': undeclared identifier\")",
		);
		const result = await runProcess(process.execPath, [file], 10_000);
		expect(result.parsed).toBeDefined();
	});

	it("gives up on a program that runs too long", async () => {
		const file = script("hang.mjs", "setInterval(() => {}, 1000)");
		await expect(runProcess(process.execPath, [file], 300)).rejects.toBeInstanceOf(TimeoutError);
	});

	it("reports a program that does not exist", async () => {
		await expect(runProcess(join(dir, "no-such-program"), [], 5_000)).rejects.toMatchObject({
			code: "SPAWN_FAILED",
		});
	});

	it("keeps the end of very long output", async () => {
		const file = script(
			"flood.mjs",
			"const line = 'x'.repeat(999) + '\\n'; for (let i = 0; i < 6000; i++) process.stdout.write(line); process.stdout.write('THE END\\n');",
		);
		const result = await runProcess(process.execPath, [file], 30_000);
		expect(result.stdout.length).toBeLessThan(4_100_000);
		expect(result.stdout.trimEnd().endsWith("THE END")).toBe(true);
	});

	it.skipIf(process.platform !== "win32")("runs a batch file in a folder with spaces", async () => {
		const bat = script("run uat.bat", "@echo off\r\necho [%~1] [%~2]\r\nexit /b 4\r\n");
		const result = await runProcess(bat, ["with space", "-x=1"], 10_000, { cwd: dir });
		expect(result.exitCode).toBe(4);
		expect(result.stdout).toContain("[with space] [-x=1]");
	});
});
