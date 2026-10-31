import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SubprocessResult } from "../types.js";
import { TimeoutError, UnrealMcpError } from "../utils/errors.js";
import { parseBuildOutput } from "../utils/output-parser.js";
import { resolveProject } from "../utils/project.js";

/** Keep at most this many characters of each output stream (the tail), so long builds stay bounded. */
const MAX_CAPTURED_OUTPUT = 4_000_000;

/**
 * Quote one argument for cmd.exe. Arguments with spaces or shell characters are wrapped in double
 * quotes. Characters that cannot be quoted safely (quotes, %, line breaks) are rejected, because
 * these arguments come from tool parameters and must not be able to inject extra commands.
 */
export function quoteCmdArg(arg: string): string {
	if (/["%\r\n\0]/.test(arg)) {
		throw new UnrealMcpError(
			`Argument contains a character that cannot be passed safely to a Windows batch file: ${JSON.stringify(arg)}`,
			"UNSAFE_ARGUMENT",
		);
	}
	if (arg === "") return '""';
	if (!/[\s&|<>^()@!]/.test(arg)) return arg;
	// A trailing backslash would escape the closing quote, so double it.
	return `"${arg.replace(/(\\+)$/, "$1$1")}"`;
}

/** Whether a launcher is a batch file, which Windows can only start through cmd.exe. */
export function needsCmdShell(command: string, platform: string = process.platform): boolean {
	return platform === "win32" && /\.(bat|cmd)$/i.test(command);
}

/** Kill a child and everything it started (UAT and UBT start their own children). */
function killTree(child: ChildProcess): void {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") {
			spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			process.kill(-child.pid, "SIGTERM");
		}
	} catch {
		child.kill("SIGTERM");
	}
}

function appendTail(chunks: string[], state: { size: number }, text: string): void {
	chunks.push(text);
	state.size += text.length;
	while (state.size > MAX_CAPTURED_OUTPUT && chunks.length > 1) {
		state.size -= (chunks.shift() as string).length;
	}
}

/**
 * Run a program and capture its output. Paths and arguments with spaces work on every platform
 * (the default Windows install folder is "C:\\Program Files\\Epic Games\\...").
 */
export function runProcess(
	command: string,
	args: string[],
	timeout: number,
	options: { cwd?: string } = {},
): Promise<SubprocessResult> {
	return new Promise<SubprocessResult>((resolve, reject) => {
		const startTime = Date.now();
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const outSize = { size: 0 };
		const errSize = { size: 0 };

		let child: ChildProcess;
		try {
			if (needsCmdShell(command)) {
				const commandLine = [command, ...args].map(quoteCmdArg).join(" ");
				child = spawn(commandLine, [], {
					shell: true,
					windowsVerbatimArguments: true,
					cwd: options.cwd,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} else {
				child = spawn(command, args, {
					shell: false,
					cwd: options.cwd,
					detached: process.platform !== "win32",
					stdio: ["ignore", "pipe", "pipe"],
				});
			}
		} catch (err) {
			reject(err instanceof UnrealMcpError ? err : new UnrealMcpError(String(err), "SPAWN_FAILED"));
			return;
		}

		const timer = setTimeout(() => {
			killTree(child);
			reject(new TimeoutError(`${command} ${args[0] || ""}`, timeout));
		}, timeout);

		child.stdout?.on("data", (data: Buffer) => appendTail(stdoutChunks, outSize, data.toString()));
		child.stderr?.on("data", (data: Buffer) => appendTail(stderrChunks, errSize, data.toString()));

		child.on("close", (exitCode) => {
			clearTimeout(timer);
			const stdout = stdoutChunks.join("");
			const stderr = stderrChunks.join("");
			resolve({
				exitCode: exitCode ?? 1,
				stdout,
				stderr,
				duration: Date.now() - startTime,
				parsed: parseBuildOutput(`${stdout}\n${stderr}`),
			});
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			reject(
				new UnrealMcpError(`Failed to spawn process: ${err.message}`, "SPAWN_FAILED", {
					command,
					args,
				}),
			);
		});
	});
}

export interface SubprocessConfig {
	enginePath?: string;
	projectPath: string;
	platform: string;
	configuration: string;
	timeouts: {
		build: number;
		cook: number;
	};
}

/**
 * Runs UAT, UBT, and commandlets as child processes.
 * These don't require the editor to be running.
 */
export class SubprocessRunner {
	private config: SubprocessConfig;

	constructor(config: SubprocessConfig) {
		this.config = config;
	}

	/** The .uproject file that UAT, UBT and the editor expect (the configured path may be its folder). */
	get uprojectPath(): string {
		return resolveProject(this.config.projectPath).uprojectPath ?? this.config.projectPath;
	}

	/** The project name, which UBT needs to build target names such as `<Name>Editor`. */
	get projectName(): string | undefined {
		return resolveProject(this.config.projectPath).name;
	}

	/**
	 * Run UAT (Unreal Automation Tool) with the given command and args.
	 */
	async runUAT(command: string, args: string[] = [], timeout?: number): Promise<SubprocessResult> {
		const uatPath = this.getUATPath();
		if (!uatPath) {
			throw new UnrealMcpError(
				"Cannot find RunUAT. Set enginePath in config or UNREAL_MCP_ENGINE_PATH env var.",
				"UAT_NOT_FOUND",
			);
		}

		const fullArgs = [command, ...args];
		return this.spawn(uatPath, fullArgs, timeout || this.config.timeouts.build);
	}

	/**
	 * Run BuildCookRun — the main build pipeline command.
	 */
	async buildCookRun(options: {
		build?: boolean;
		cook?: boolean;
		stage?: boolean;
		package?: boolean;
		archive?: boolean;
		deploy?: boolean;
		run?: boolean;
		iterate?: boolean;
		compressed?: boolean;
		pak?: boolean;
		platform?: string;
		configuration?: string;
		additionalArgs?: string[];
	}): Promise<SubprocessResult> {
		const args: string[] = [];

		args.push(`-project=${this.uprojectPath}`);
		args.push(`-platform=${options.platform || this.config.platform}`);
		args.push(`-clientconfig=${options.configuration || this.config.configuration}`);

		if (options.build) args.push("-build");
		if (options.cook) args.push("-cook");
		if (options.stage) args.push("-stage");
		if (options.package) args.push("-package");
		if (options.archive) args.push("-archive");
		if (options.deploy) args.push("-deploy");
		if (options.run) args.push("-run");
		if (options.iterate) args.push("-iterate");
		if (options.compressed) args.push("-compressed");
		if (options.pak) args.push("-pak");

		// Non-interactive: no Perforce lookup, no prompts, readable output.
		args.push("-nop4", "-unattended", "-utf8output");

		if (options.additionalArgs) {
			args.push(...options.additionalArgs);
		}

		return this.runUAT("BuildCookRun", args, this.config.timeouts.cook);
	}

	/**
	 * Run UBT (UnrealBuildTool) to compile C++ code.
	 */
	async runUBT(args: string[], timeout?: number): Promise<SubprocessResult> {
		const ubtPath = this.getUBTPath();
		if (!ubtPath) {
			throw new UnrealMcpError(
				"Cannot find UnrealBuildTool. Set enginePath in config or UNREAL_MCP_ENGINE_PATH env var.",
				"UBT_NOT_FOUND",
			);
		}

		return this.spawn(ubtPath, args, timeout || this.config.timeouts.build);
	}

	/**
	 * Run a UE commandlet (headless batch operation).
	 */
	async runCommandlet(
		commandletName: string,
		args: string[] = [],
		timeout?: number,
	): Promise<SubprocessResult> {
		const editorPath = this.getEditorPath();
		if (!editorPath) {
			throw new UnrealMcpError(
				"Cannot find UnrealEditor. Set enginePath in config.",
				"EDITOR_NOT_FOUND",
			);
		}

		const fullArgs = [this.uprojectPath, `-run=${commandletName}`, ...args, "-unattended"];
		return this.spawn(editorPath, fullArgs, timeout || this.config.timeouts.build);
	}

	/**
	 * Generate project files (VS/Xcode/Rider) through UnrealBuildTool, the way the
	 * "Generate project files" context menu entry does.
	 */
	async generateProjectFiles(): Promise<SubprocessResult> {
		return this.runUBT([
			"-projectfiles",
			`-project=${this.uprojectPath}`,
			"-game",
			"-engine",
			"-progress",
		]);
	}

	private getUATPath(): string | null {
		if (!this.config.enginePath) return null;

		const candidates = [
			join(this.config.enginePath, "Engine", "Build", "BatchFiles", "RunUAT.bat"),
			join(this.config.enginePath, "Engine", "Build", "BatchFiles", "RunUAT.sh"),
		];

		for (const candidate of candidates) {
			if (existsSync(candidate)) return candidate;
		}
		return null;
	}

	private getUBTPath(): string | null {
		if (!this.config.enginePath) return null;

		const candidates = [
			join(
				this.config.enginePath,
				"Engine",
				"Binaries",
				"DotNET",
				"UnrealBuildTool",
				"UnrealBuildTool.exe",
			),
			join(
				this.config.enginePath,
				"Engine",
				"Binaries",
				"DotNET",
				"UnrealBuildTool",
				"UnrealBuildTool",
			),
		];

		for (const candidate of candidates) {
			if (existsSync(candidate)) return candidate;
		}
		return null;
	}

	private getEditorPath(): string | null {
		if (!this.config.enginePath) return null;

		// The -Cmd build is a console program, so its log reaches our pipes.
		const binaries = join(this.config.enginePath, "Engine", "Binaries");
		const candidates = [
			join(binaries, "Win64", "UnrealEditor-Cmd.exe"),
			join(binaries, "Win64", "UnrealEditor.exe"),
			join(binaries, "Mac", "UnrealEditor-Cmd"),
			join(binaries, "Mac", "UnrealEditor.app", "Contents", "MacOS", "UnrealEditor"),
			join(binaries, "Linux", "UnrealEditor-Cmd"),
			join(binaries, "Linux", "UnrealEditor"),
		];

		for (const candidate of candidates) {
			if (existsSync(candidate)) return candidate;
		}
		return null;
	}

	private spawn(command: string, args: string[], timeout: number): Promise<SubprocessResult> {
		return runProcess(command, args, timeout);
	}
}
