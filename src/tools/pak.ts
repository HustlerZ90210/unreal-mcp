import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	type PakListing,
	auditListing,
	findConflicts,
	findPaks,
	findUnrealPak,
	gamePath,
	listPak,
} from "../pak/unrealpak.js";
import type { ConnectionManager } from "../transports/connection-manager.js";
import type { UnrealMcpConfig } from "../types.js";
import { UnrealMcpError } from "../utils/errors.js";

/**
 * Looking inside .pak files with UnrealPak: what a pak holds, whether it holds anything it should not,
 * and which files several paks both provide. Read only: nothing here creates or changes a pak.
 */

function reply(value: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		...(isError ? { isError: true } : {}),
	};
}

/** Run a tool body, turning this module's errors into tool errors. */
async function guarded(body: () => Promise<ReturnType<typeof reply>>) {
	try {
		return await body();
	} catch (error) {
		if (error instanceof UnrealMcpError) return error.toToolResult();
		throw error;
	}
}

const FOLDER_DEPTH = 3;

function summarizeFolders(listing: PakListing) {
	const folders = new Map<string, { files: number; size: number }>();
	for (const entry of listing.entries) {
		const parts = gamePath(listing.mountPoint, entry.path).split("/");
		const key = parts.slice(0, Math.min(FOLDER_DEPTH, Math.max(1, parts.length - 1))).join("/");
		const folder = folders.get(key) ?? { files: 0, size: 0 };
		folder.files++;
		folder.size += entry.size;
		folders.set(key, folder);
	}
	return [...folders]
		.map(([folder, totals]) => ({ folder, ...totals }))
		.sort((a, b) => b.size - a.size)
		.slice(0, 15);
}

export function registerPakTools(
	server: McpServer,
	_manager: ConnectionManager,
	config: UnrealMcpConfig,
): void {
	const timeout = config.timeouts.build;

	server.tool(
		"pak_list",
		"List the files inside a .pak (runs UnrealPak -List): how many, how big, which folders they are in, and the files themselves. A pak with encrypted contents cannot be listed without its keys.",
		{
			pak: z.string().min(1).describe("Path of the .pak file"),
			filter: z
				.string()
				.optional()
				.describe("Only list files whose path contains this text (case does not matter)"),
			limit: z
				.number()
				.int()
				.min(1)
				.max(5000)
				.default(200)
				.describe("Most files to list (the totals always cover the whole pak)"),
		},
		async ({ pak, filter, limit }) =>
			guarded(async () => {
				const listing = await listPak(findUnrealPak(config), pak, timeout);
				const wanted = filter?.toLowerCase();
				const files = listing.entries
					.map((entry) => ({
						path: gamePath(listing.mountPoint, entry.path),
						size: entry.size,
						compressed_size: entry.compressedSize,
					}))
					.filter((file) => !wanted || file.path.toLowerCase().includes(wanted))
					.sort((a, b) => a.path.localeCompare(b.path));
				return reply({
					pak,
					mount_point: listing.mountPoint ?? null,
					file_count: listing.entries.length,
					total_size_bytes: listing.entries.reduce((sum, entry) => sum + entry.size, 0),
					biggest_folders: summarizeFolders(listing),
					matched: files.length,
					truncated: files.length > limit,
					files: files.slice(0, limit),
				});
			}),
	);

	server.tool(
		"pak_audit",
		"Check that a .pak only holds files under the folders you expect, for example that a mod pak holds nothing but your own mod's folders and no game content. Lists every file outside the allowed folders.",
		{
			pak: z.string().min(1).describe("Path of the .pak file"),
			allowed_prefixes: z
				.array(z.string().min(1))
				.min(1)
				.describe(
					'Folders the pak may hold, as game paths, e.g. ["ReadyOrNot/Content/Mods/YourName/"]. "*" stands for any one folder name',
				),
			limit: z.number().int().min(1).max(5000).default(100).describe("Most stray files to list"),
		},
		async ({ pak, allowed_prefixes, limit }) =>
			guarded(async () => {
				const listing = await listPak(findUnrealPak(config), pak, timeout);
				const result = auditListing(listing, allowed_prefixes);
				return reply({
					pak,
					ok: result.outside.length === 0,
					files_checked: result.checked,
					files_outside: result.outside.length,
					size_outside_bytes: result.outside.reduce((sum, file) => sum + file.size, 0),
					allowed_prefixes,
					outside: result.outside.slice(0, limit),
					truncated: result.outside.length > limit,
				});
			}),
	);

	server.tool(
		"pak_conflicts",
		"Find files that more than one .pak provides. Give the paks, or a folder to take every .pak from. Which pak wins depends on the order the game loads them, which this does not decide: for installed Ready or Not mods, ron_conflicts knows the game's order and also checks the game's own files.",
		{
			paks: z.array(z.string().min(1)).optional().describe("Paths of the .pak files to compare"),
			folder: z.string().optional().describe("A folder whose .pak files are compared"),
			recursive: z.boolean().default(false).describe("With folder: include sub-folders"),
			show: z
				.number()
				.int()
				.min(1)
				.max(1000)
				.default(20)
				.describe("Most conflicting files to list"),
		},
		async ({ paks, folder, recursive, show }) =>
			guarded(async () => {
				const files = [...(paks ?? []), ...(folder ? findPaks(folder, recursive) : [])];
				const unique = [...new Set(files)];
				if (unique.length < 2) {
					return reply(
						{ error: "Give at least two .pak files, or a folder that holds at least two." },
						true,
					);
				}
				const unrealPak = findUnrealPak(config);
				const listings: PakListing[] = [];
				for (const file of unique) listings.push(await listPak(unrealPak, file, timeout));

				const conflicts = findConflicts(listings);
				const pairs = new Map<string, number>();
				for (const conflict of conflicts) {
					const names = conflict.paks.map((owner) => basename(owner.pak)).sort();
					for (let i = 0; i < names.length; i++) {
						for (let j = i + 1; j < names.length; j++) {
							const key = `${names[i]} + ${names[j]}`;
							pairs.set(key, (pairs.get(key) ?? 0) + 1);
						}
					}
				}
				return reply({
					paks: listings.map((l) => ({ pak: l.pak, files: l.entries.length })),
					conflict_count: conflicts.length,
					pairs: [...pairs]
						.map(([between, files]) => ({ between, files }))
						.sort((a, b) => b.files - a.files)
						.slice(0, 20),
					conflicts: conflicts.slice(0, show).map((conflict) => ({
						path: conflict.path,
						in: conflict.paks.map((owner) => basename(owner.pak)),
						sizes: conflict.paks.map((owner) => owner.size),
					})),
					truncated: conflicts.length > show,
				});
			}),
	);
}
