import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { GameContentRoot } from "../ron/framework.js";
import { UnrealMcpError } from "./errors.js";
import { resolveProject } from "./project.js";

/**
 * Keeps the tools away from content that must not change.
 *
 * Some projects link another file set into their content folder: a Ready or Not mapping project
 * hard-links the game's exported content, so a file in the project and a file in the export are the
 * same file on disk. Saving, renaming or deleting one of them changes (or breaks) the other. A
 * tool asked to do that is refused with an explanation instead.
 *
 * A content path is protected when
 *  - it is engine content (/Engine),
 *  - it is under one of the configured protectedPaths,
 *  - it exists in the exported game content (when that is known), or
 *  - its file in the project has more than one hard link (or a folder holds such files).
 */

export type PathKind = "asset" | "directory";

export interface WriteGuardOptions {
	projectPath: string;
	protectedPaths?: string[];
	protectLinkedContent?: boolean;
	/** Folders holding an untouched copy of game content. Read on every check, so it can change. */
	gameContent?: () => GameContentRoot[];
}

export class ProtectedContentError extends UnrealMcpError {
	constructor(contentPath: string, reason: string) {
		const advice = [
			"Make a copy under your own folder (for example /Game/Mods/<YourName>/) and change that.",
			"To lift the protection, edit protectedPaths or protectLinkedContent in the configuration.",
		].join(" ");
		super(`Refusing to change ${contentPath}: ${reason}. ${advice}`, "PROTECTED_CONTENT", {
			path: contentPath,
			reason,
		});
		this.name = "ProtectedContentError";
	}
}

const ASSET_EXTENSIONS = [".uasset", ".umap"];
/** Folders are searched for linked files until this many entries have been looked at. */
const SCAN_BUDGET = 20_000;

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function linkCount(file: string): number {
	try {
		return statSync(file).nlink;
	} catch {
		return 0;
	}
}

function hasAsset(dir: string, rel: string): boolean {
	return ASSET_EXTENSIONS.some((ext) => existsSync(join(dir, rel + ext)));
}

function containsLinkedFile(start: string): boolean {
	if (!isDirectory(start)) return false;
	const stack = [start];
	let seen = 0;
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (++seen > SCAN_BUDGET) return false;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (
				ASSET_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext)) &&
				linkCount(full) > 1
			) {
				return true;
			}
		}
	}
	return false;
}

function forwardSlashes(path: string): string {
	return path.replace(/\\/g, "/");
}

/** "/Prefix/" and "Prefix" both mean "/Prefix". Compared without regard to case, like Unreal does. */
function normalizePrefix(prefix: string): string {
	const text = posix.normalize(`/${forwardSlashes(prefix.trim())}`).replace(/\/+$/, "");
	return text.toLowerCase();
}

export class WriteGuard {
	private readonly projectDir?: string;
	private readonly protectedPaths: string[];
	private readonly protectLinked: boolean;
	private readonly gameContent: () => GameContentRoot[];

	constructor(options: WriteGuardOptions) {
		this.projectDir = resolveProject(options.projectPath).dir;
		this.protectedPaths = (options.protectedPaths ?? []).filter(Boolean).map(normalizePrefix);
		this.protectLinked = options.protectLinkedContent ?? true;
		this.gameContent = options.gameContent ?? (() => []);
	}

	/** Why this path must not be changed, or undefined if it may be. */
	check(rawPath: string, kind: PathKind): string | undefined {
		const path = this.toContentPath(rawPath, kind);
		if (!path) return undefined;
		const [, mount = "", ...rest] = path.split("/");
		const rel = rest.join("/");
		const lower = path.toLowerCase();

		if (mount.toLowerCase() === "engine") return "it is engine content";
		for (const prefix of this.protectedPaths) {
			if (lower === prefix || lower.startsWith(`${prefix}/`)) {
				return `it is under ${prefix}, which protectedPaths lists`;
			}
		}
		if (!this.protectLinked) return undefined;

		for (const root of this.gameContent()) {
			if (root.mount !== mount) continue;
			const present = kind === "asset" ? hasAsset(root.dir, rel) : isDirectory(join(root.dir, rel));
			if (present) return "it is part of your exported game content";
		}

		const dir = this.contentDir(mount);
		if (!dir) return undefined;
		if (kind === "asset") {
			if (ASSET_EXTENSIONS.some((ext) => linkCount(join(dir, rel + ext)) > 1)) {
				return "it is hard-linked to another file (an exported copy of game content)";
			}
		} else if (containsLinkedFile(join(dir, rel))) {
			return "it holds hard-linked game content";
		}
		return undefined;
	}

	/** Throws for the first path that must not be changed. */
	assertWritable(items: { path: string; kind: PathKind }[]): void {
		for (const { path, kind } of items) {
			const reason = this.check(path, kind);
			if (reason) throw new ProtectedContentError(path, reason);
		}
	}

	/** The content path (/Game/Folder/Asset) a tool argument names, if it names one. */
	private toContentPath(raw: string, kind: PathKind): string | undefined {
		let text = forwardSlashes(raw.trim());
		if (!text) return undefined;

		const fromDisk = this.diskToContent(text);
		if (fromDisk) {
			text = fromDisk;
		} else if (!text.startsWith("/") || /^[A-Za-z]:\//.test(text)) {
			return undefined;
		}

		text = posix.normalize(text).replace(/(.)\/+$/, "$1");
		if (kind === "asset") {
			// "/Game/Folder/Asset.Asset" and "/Game/Folder/Asset.Asset:Sub" name the asset "/Game/Folder/Asset"
			const slash = text.lastIndexOf("/");
			text = text.slice(0, slash + 1) + text.slice(slash + 1).replace(/[.:].*$/, "");
		}
		return text;
	}

	/** A file path inside the project's content becomes the content path it is mounted at. */
	private diskToContent(text: string): string | undefined {
		if (!this.projectDir) return undefined;
		const project = forwardSlashes(this.projectDir).replace(/\/+$/, "");
		const insensitive = process.platform === "win32";
		const compare = (value: string) => (insensitive ? value.toLowerCase() : value);
		const prefixed = (prefix: string) => compare(text).startsWith(`${compare(prefix)}/`);
		const tail = (prefix: string) => text.slice(prefix.length + 1);

		if (prefixed(`${project}/Content`)) return `/Game/${tail(`${project}/Content`)}`;
		const plugin = new RegExp(
			`^${escapeRegExp(project)}/Plugins/(?:GameFeatures/)?([^/]+)/Content/(.*)$`,
			insensitive ? "i" : "",
		);
		const match = plugin.exec(text);
		return match ? `/${match[1]}/${match[2]}` : undefined;
	}

	/** The folder on disk that a mount point (Game, or a plugin's name) shows. */
	private contentDir(mount: string): string | undefined {
		if (!this.projectDir) return undefined;
		const candidates =
			mount === "Game"
				? [join(this.projectDir, "Content")]
				: [
						join(this.projectDir, "Plugins", mount, "Content"),
						join(this.projectDir, "Plugins", "GameFeatures", mount, "Content"),
					];
		return candidates.find((candidate) => isDirectory(candidate));
	}
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
