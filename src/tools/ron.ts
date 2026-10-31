import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	type RonFramework,
	findFramework,
	gameContentRoots,
	listProfiles,
} from "../ron/framework.js";
import type { ConnectionManager } from "../transports/connection-manager.js";
import type { UnrealMcpConfig } from "../types.js";
import { UnrealMcpError } from "../utils/errors.js";
import { type JobSnapshot, jobs } from "../utils/jobs.js";

/**
 * Ready or Not modding: runs the Community Mapping Framework's `ronfw` tool (Tools/ronfw.py, UE 5.3.2)
 * so an assistant can check, build and install maps the way a mapper does from the command line.
 * The tool does the work; these wrappers only start it, wait for it and report what it printed.
 *
 * Off by default. Enable with `--modules all` or by listing "ron" in enabledModules.
 */

const TAIL_LINES = 80;
const HOUR = 60 * 60 * 1000;

/** A map is a profile name ("MyMap") or a content path ("/Game/Mods/Me/MyMap/Levels/MyMap"). */
const mapArg = z
	.string()
	.min(1)
	.max(300)
	.regex(/^[^-\s][\w./ -]*$/, "A profile name or a /Game/... path")
	.refine((value) => !value.includes(".."), "No '..' in paths");

const waitSeconds = (fallback: number) =>
	z
		.number()
		.int()
		.min(0)
		.max(3600)
		.default(fallback)
		.describe(
			`How long to wait for the command before returning (default ${fallback}s). If it is still running you get a job_id to check with ron_job`,
		);

/** Commands ron_run may start. Setup, game export, packaging and in-game tests are left to the user. */
const RUN_COMMANDS = [
	"new-map",
	"new-profile",
	"namespace",
	"mission",
	"qsm",
	"bake",
	"spawn-limits",
	"remove-actors",
	"official",
	"remix",
	"variant",
	"port-volumes",
	"view",
	"check-refs",
	"uninstall",
	"link-content",
	"content",
	"live",
] as const;

class FrameworkNotFoundError extends UnrealMcpError {
	constructor() {
		super(
			"Cannot find the Ready or Not framework (Tools/ronfw.py). Set ronFrameworkPath in the configuration " +
				"(or --ron-framework) to the folder that holds the Tools folder, or open the framework's Unreal " +
				"project as projectPath.",
			"RON_FRAMEWORK_NOT_FOUND",
		);
		this.name = "FrameworkNotFoundError";
	}
}

function reply(value: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		...(isError ? { isError: true } : {}),
	};
}

function describeJob(job: JobSnapshot) {
	const running = job.status === "running";
	return reply(
		{
			job_id: job.id,
			command: job.name,
			status: job.status,
			exit_code: job.exitCode,
			error: job.error,
			duration_seconds: job.durationSeconds,
			output_lines: job.outputLines,
			output_tail: job.outputTail,
			...(running
				? { hint: `Still running. Check on it with ron_job (action "wait", job_id "${job.id}").` }
				: {}),
		},
		job.status === "failed" || job.status === "timed_out" || job.status === "cancelled",
	);
}

export function registerRonTools(
	server: McpServer,
	_manager: ConnectionManager,
	config: UnrealMcpConfig,
): void {
	const framework = (): RonFramework => {
		const found = findFramework(config);
		if (!found) throw new FrameworkNotFoundError();
		return found;
	};

	/** Start `ronfw <args>` as a job and wait a while for it. */
	const run = async (args: string[], options: { wait: number; timeoutMs: number }) => {
		try {
			const fw = framework();
			const id = jobs.start({
				name: `ronfw ${args.join(" ")}`,
				command: fw.python,
				args: [fw.script, ...args],
				cwd: fw.toolsDir,
				// ronfw prints non-ASCII text; a Windows pipe would otherwise use the ANSI code page.
				env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
				timeoutMs: options.timeoutMs,
			});
			const job = await jobs.waitFor(id, options.wait * 1000, TAIL_LINES);
			return job ? describeJob(job) : reply({ error: `Job ${id} disappeared` }, true);
		} catch (error) {
			if (error instanceof UnrealMcpError) return error.toToolResult();
			throw error;
		}
	};

	server.tool(
		"ron_status",
		"Ready or Not: where the framework and its ronfw tool are, what `ronfw setup` found (engine, game, content export), your map profiles, and the content protection settings.",
		{},
		async () => {
			let fw: RonFramework;
			try {
				fw = framework();
			} catch (error) {
				return error instanceof UnrealMcpError
					? error.toToolResult()
					: reply({ error: String(error) }, true);
			}
			return reply({
				framework: {
					root: fw.root,
					script: fw.script,
					python: fw.python,
					version: fw.version ?? null,
				},
				setup_done: fw.paths !== undefined,
				paths: fw.paths ?? null,
				profiles: listProfiles(fw.toolsDir),
				game_content_found: gameContentRoots(fw.paths).length > 0,
				protection: {
					protect_linked_content: config.protectLinkedContent ?? true,
					protected_paths: config.protectedPaths ?? [],
				},
				running_jobs: jobs.list().filter((job) => job.status === "running"),
			});
		},
	);

	server.tool(
		"ron_check_map",
		"Ready or Not: check a map for common mistakes (level script, lighting, player starts, nav mesh, AI spawns, doors, sound). Runs `ronfw check-map`.",
		{
			map: mapArg.describe("Profile name or /Game/... map path"),
			wait_seconds: waitSeconds(300),
		},
		async ({ map, wait_seconds }) =>
			run(["check-map", map], { wait: wait_seconds, timeoutMs: HOUR }),
	);

	server.tool(
		"ron_build_map",
		"Ready or Not: build a map into a mod pak and install it into the game: map check, cook, pak, reference check, install. Runs `ronfw build`. Can take many minutes; if it is still running you get a job_id to follow with ron_job.",
		{
			map: mapArg.describe("Profile name"),
			iterate: z
				.boolean()
				.default(false)
				.describe("Iterative cook (faster, keeps old cooked files)"),
			skip_cook: z.boolean().default(false).describe("Re-stage and re-pak the last cook"),
			no_install: z
				.boolean()
				.default(false)
				.describe("Build the pak but do not install it into the game"),
			keep_worldgen: z.boolean().default(false).describe("Keep the map's WorldGen cache"),
			strict: z.boolean().default(false).describe("Fail on missing references"),
			no_check: z.boolean().default(false).describe("Skip the map checker"),
			launch: z.boolean().default(false).describe("Start the game through Steam afterwards"),
			wait_seconds: waitSeconds(120),
		},
		async ({
			map,
			iterate,
			skip_cook,
			no_install,
			keep_worldgen,
			strict,
			no_check,
			launch,
			wait_seconds,
		}) => {
			const args = ["build", map];
			if (iterate) args.push("--iterate");
			if (skip_cook) args.push("--skip-cook");
			if (no_install) args.push("--no-install");
			if (keep_worldgen) args.push("--keep-worldgen");
			if (strict) args.push("--strict");
			if (no_check) args.push("--no-check");
			if (launch) args.push("--launch");
			return run(args, { wait: wait_seconds, timeoutMs: Math.max(config.timeouts.cook, 3 * HOUR) });
		},
	);

	server.tool(
		"ron_light_map",
		"Ready or Not: build a map's lighting with Lightmass and save its BuiltData. Runs `ronfw light`. Can take a long time; follow it with ron_job.",
		{
			map: mapArg.describe("Profile name"),
			quality: z
				.enum(["preview", "medium", "high", "production"])
				.default("high")
				.describe("Lightmass quality"),
			keep_open: z
				.boolean()
				.default(false)
				.describe("Open the editor on the map and build there; the editor stays open afterwards"),
			timeout_minutes: z
				.number()
				.int()
				.min(1)
				.max(1440)
				.default(480)
				.describe("Minutes before ronfw stops the build"),
			wait_seconds: waitSeconds(60),
		},
		async ({ map, quality, keep_open, timeout_minutes, wait_seconds }) => {
			const args = ["light", map, "--quality", quality, "--timeout", String(timeout_minutes)];
			if (keep_open) args.push("--keep-open");
			return run(args, { wait: wait_seconds, timeoutMs: (timeout_minutes + 15) * 60 * 1000 });
		},
	);

	server.tool(
		"ron_conflicts",
		"Ready or Not: list files that more than one installed mod pak provides (the later pak silently wins) and mod files that replace stock game files. Runs `ronfw conflicts`.",
		{
			show: z
				.number()
				.int()
				.min(1)
				.max(100)
				.default(8)
				.describe("Example files to list per conflict"),
			wait_seconds: waitSeconds(120),
		},
		async ({ show, wait_seconds }) =>
			run(["conflicts", "--show", String(show)], { wait: wait_seconds, timeoutMs: HOUR }),
	);

	server.tool(
		"ron_official_levels",
		"Ready or Not: list the official levels your exported game content covers. Runs `ronfw official --list`.",
		{
			check: z.boolean().default(false).describe("Also report missing sublevels"),
			wait_seconds: waitSeconds(120),
		},
		async ({ check, wait_seconds }) =>
			run(["official", "--list", ...(check ? ["--check"] : [])], {
				wait: wait_seconds,
				timeoutMs: HOUR,
			}),
	);

	server.tool(
		"ron_testmode",
		"Ready or Not: set other mods aside for a clean in-game test (on), put them back (off), or show what is parked (status). Moves mod pak files between the game's Paks folder and Paks_parked; the game's own paks are never touched. Runs `ronfw testmode`.",
		{
			action: z
				.enum(["on", "off", "status"])
				.describe("on parks the other mods, off restores them"),
			maps: z
				.array(mapArg)
				.default([])
				.describe("With on: the maps (profiles) to keep installed. Default: all of yours"),
			wait_seconds: waitSeconds(60),
		},
		async ({ action, maps, wait_seconds }) =>
			run(["testmode", action, ...(action === "on" ? maps : [])], {
				wait: wait_seconds,
				timeoutMs: HOUR,
			}),
	);

	server.tool(
		"ron_verify_content",
		"Ready or Not: restore any linked game file that the editor has re-saved, so the project's game content matches your export again. Run it after an editor session if a game asset might have been saved. Runs `ronfw verify-content`.",
		{ wait_seconds: waitSeconds(300) },
		async ({ wait_seconds }) => run(["verify-content"], { wait: wait_seconds, timeoutMs: HOUR }),
	);

	server.tool(
		"ron_run",
		`Ready or Not: run another ronfw command. Allowed: ${RUN_COMMANDS.join(", ")}. Setup, game export, packaging and the in-game test are not available here. For "live" only "status" and "rooms" work (use execute_python to run code in the editor). Arguments go to ronfw as they are, for example command "official" with args ["Neon Tomb", "--name", "MyCopy"].`,
		{
			command: z.enum(RUN_COMMANDS).describe("The ronfw command"),
			args: z
				.array(
					z
						.string()
						.min(1)
						.max(500)
						.regex(/^[^\0\r\n]+$/, "No line breaks"),
				)
				.max(40)
				.default([])
				.describe("Arguments after the command"),
			wait_seconds: waitSeconds(120),
		},
		async ({ command, args, wait_seconds }) => {
			if (command === "live" && !(args.length === 1 && ["status", "rooms"].includes(args[0]))) {
				return reply(
					{
						error:
							'ron_run only allows "live status" and "live rooms". Use execute_python to run code in the editor.',
					},
					true,
				);
			}
			return run([command, ...args], { wait: wait_seconds, timeoutMs: 3 * HOUR });
		},
	);

	server.tool(
		"ron_job",
		"Follow a long ronfw command: show its state and the end of its output, wait for it, cancel it, or list the jobs of this session. Jobs keep running if the server stops.",
		{
			action: z
				.enum(["status", "wait", "cancel", "list"])
				.describe(
					"status looks now, wait waits up to wait_seconds, cancel stops it, list shows all jobs",
				),
			job_id: z.string().optional().describe("The job_id a command returned (not needed for list)"),
			wait_seconds: waitSeconds(60),
			tail_lines: z
				.number()
				.int()
				.min(1)
				.max(500)
				.default(TAIL_LINES)
				.describe("How many lines from the end of the output to show"),
		},
		async ({ action, job_id, wait_seconds, tail_lines }) => {
			if (action === "list") return reply({ jobs: jobs.list() });
			if (!job_id) return reply({ error: `job_id is required for ${action}` }, true);
			let job: JobSnapshot | undefined;
			if (action === "cancel") {
				jobs.cancel(job_id);
				job = await jobs.waitFor(job_id, 5000, tail_lines);
			} else {
				job = await jobs.waitFor(job_id, action === "wait" ? wait_seconds * 1000 : 0, tail_lines);
			}
			return job ? describeJob(job) : reply({ error: `No job ${job_id}` }, true);
		},
	);
}
