import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { startProcess } from "../transports/subprocess.js";
import type { UnrealMcpConfig } from "../types.js";
import { TimeoutError, UnrealMcpError } from "../utils/errors.js";

/**
 * Reading what is inside .pak files with UnrealPak (`UnrealPak <pak> -List`), and comparing paks.
 *
 * The listing is read line by line as UnrealPak prints it: a game pak has tens of thousands of files,
 * more output than the runProcess buffer keeps.
 */

export interface PakEntry {
	/** Path inside the pak, relative to its mount point */
	path: string;
	offset: number;
	/** Size of the file, before compression */
	size: number;
	compressedSize?: number;
}

export interface PakListing {
	pak: string;
	/** Where the pak mounts, e.g. "../../../" */
	mountPoint?: string;
	entries: PakEntry[];
}

export class PakToolError extends UnrealMcpError {
	constructor(message: string, code: string, details?: Record<string, unknown>) {
		super(message, code, details);
		this.name = "PakToolError";
	}
}

// LogPakFile: Display: "Folder/File.uasset" offset: 0, size: 1234 bytes, sha1: ..., compression: ...
// Newer engines add more fields after the size (compression method, compressed size, block size ...).
const ENTRY_PATTERN = /"([^"]+)"\s+offset:\s*(\d+),\s*size:\s*(\d+)\s*bytes/i;
const COMPRESSED_PATTERN = /compressed size:\s*(\d+)/i;
const MOUNT_PATTERN = /mount point[:\s]+"?([^\s"]+)"?/i;
// A line that talks about a quoted file with an offset or size is a file line, whatever its exact shape.
const LOOKS_LIKE_ENTRY = /"[^"]+".*\b(?:offset|size)\b/i;

export function parsePakListLine(line: string): PakEntry | undefined {
	const match = ENTRY_PATTERN.exec(line);
	if (!match) return undefined;
	const compressed = COMPRESSED_PATTERN.exec(line);
	return {
		path: match[1],
		offset: Number(match[2]),
		size: Number(match[3]),
		...(compressed ? { compressedSize: Number(compressed[1]) } : {}),
	};
}

export function parseMountPoint(line: string): string | undefined {
	return MOUNT_PATTERN.exec(line)?.[1];
}

/**
 * The path a file has in the game's content tree: mount point and path joined, without the leading
 * "../../../" and with forward slashes. Two paks that mount differently still compare equal.
 */
export function gamePath(mountPoint: string | undefined, path: string): string {
	const joined = `${mountPoint ?? ""}/${path}`.replace(/\\/g, "/");
	const parts: string[] = [];
	for (const part of joined.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			// A mount point climbs out of the game folder; nothing before it can be dropped
			if (parts.length > 0) parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts.join("/");
}

export function findUnrealPak(config: UnrealMcpConfig): string {
	if (config.unrealPakPath) {
		if (existsSync(config.unrealPakPath)) return config.unrealPakPath;
		throw new PakToolError(
			`UnrealPak was not found at unrealPakPath: ${config.unrealPakPath}`,
			"UNREALPAK_NOT_FOUND",
		);
	}
	if (config.enginePath) {
		const candidate = [
			join(config.enginePath, "Engine", "Binaries", "Win64", "UnrealPak.exe"),
			join(config.enginePath, "Engine", "Binaries", "Linux", "UnrealPak"),
			join(config.enginePath, "Engine", "Binaries", "Mac", "UnrealPak"),
		].find((path) => existsSync(path));
		if (candidate) return candidate;
	}
	throw new PakToolError(
		"Cannot find UnrealPak. Set enginePath (the Unreal Engine install folder) or unrealPakPath in the configuration.",
		"UNREALPAK_NOT_FOUND",
	);
}

/** Pak files in a folder, sorted by name. */
export function findPaks(folder: string, recursive: boolean): string[] {
	const found: string[] = [];
	const visit = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) {
				if (recursive) visit(full);
			} else if (name.toLowerCase().endsWith(".pak")) {
				found.push(full);
			}
		}
	};
	if (!existsSync(folder) || !statSync(folder).isDirectory()) {
		throw new PakToolError(`Not a folder: ${folder}`, "NOT_A_FOLDER");
	}
	visit(folder);
	return found.sort((a, b) => a.localeCompare(b));
}

const TAIL_LINES = 15;

/** Run `UnrealPak <pak> -List` and read the entries as they are printed. */
export async function listPak(
	unrealPak: string,
	pak: string,
	timeoutMs: number,
): Promise<PakListing> {
	if (!existsSync(pak)) throw new PakToolError(`Pak file not found: ${pak}`, "PAK_NOT_FOUND");

	const entries: PakEntry[] = [];
	let mountPoint: string | undefined;
	let pending = "";
	const tail: string[] = [];
	const unparsed: string[] = [];

	const handleLine = (raw: string) => {
		const line = raw.replace(/\r$/, "");
		if (!line.trim()) return;
		tail.push(line);
		if (tail.length > TAIL_LINES) tail.shift();
		const entry = parsePakListLine(line);
		if (entry) {
			entries.push(entry);
			return;
		}
		if (LOOKS_LIKE_ENTRY.test(line) && unparsed.length < 3) unparsed.push(line);
		mountPoint ??= parseMountPoint(line);
	};

	const running = startProcess(unrealPak, [pak, "-List"], {
		onData: (chunk) => {
			const lines = (pending + chunk).split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		},
	});

	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			running.kill();
			reject(new TimeoutError(`UnrealPak -List ${pak}`, timeoutMs));
		}, timeoutMs);
	});
	let exitCode: number;
	try {
		exitCode = await Promise.race([running.done, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
	if (pending) handleLine(pending);

	if (exitCode !== 0) {
		throw new PakToolError(
			`UnrealPak could not list ${pak} (exit code ${exitCode}). A pak with encrypted contents needs its keys.`,
			"UNREALPAK_FAILED",
			{ exitCode, output: tail.join("\n") },
		);
	}
	if (entries.length === 0 && unparsed.length > 0) {
		// Better to stop than to report an empty pak: the output format is not the one this reads.
		throw new PakToolError(
			`UnrealPak printed file lines for ${pak} that could not be read, so nothing is reported.`,
			"PAK_LIST_FORMAT",
			{ example_lines: unparsed },
		);
	}
	return { pak, mountPoint, entries };
}

/** A prefix such as "ReadyOrNot/Content/Mods/" as a pattern; "*" stands for one folder name. */
function prefixPattern(prefix: string): RegExp {
	const clean = gamePath(undefined, prefix);
	const source = clean
		.split("/")
		.map((part) => (part === "*" ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
		.join("/");
	return new RegExp(`^${source}(?:/|$)`, "i");
}

export interface AuditResult {
	checked: number;
	outside: { path: string; size: number }[];
}

/** Files of a pak that are not under any of the allowed folders. */
export function auditListing(listing: PakListing, allowedPrefixes: string[]): AuditResult {
	const patterns = allowedPrefixes.map(prefixPattern);
	const outside: AuditResult["outside"] = [];
	for (const entry of listing.entries) {
		const path = gamePath(listing.mountPoint, entry.path);
		if (!patterns.some((pattern) => pattern.test(path))) outside.push({ path, size: entry.size });
	}
	return { checked: listing.entries.length, outside };
}

export interface PakConflict {
	path: string;
	paks: { pak: string; size: number }[];
}

/** Files that more than one of the listings provides, compared without regard to case. */
export function findConflicts(listings: PakListing[]): PakConflict[] {
	const byPath = new Map<string, PakConflict>();
	for (const listing of listings) {
		for (const entry of listing.entries) {
			const path = gamePath(listing.mountPoint, entry.path);
			const key = path.toLowerCase();
			let conflict = byPath.get(key);
			if (!conflict) {
				conflict = { path, paks: [] };
				byPath.set(key, conflict);
			}
			// the same pak listing a path twice (a delete record, for example) is not a conflict
			if (!conflict.paks.some((owner) => owner.pak === listing.pak)) {
				conflict.paks.push({ pak: listing.pak, size: entry.size });
			}
		}
	}
	return [...byPath.values()]
		.filter((conflict) => conflict.paks.length > 1)
		.sort((a, b) => b.paks.length - a.paks.length || a.path.localeCompare(b.path));
}
