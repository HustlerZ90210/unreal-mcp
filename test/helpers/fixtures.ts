import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A Ready-or-Not-shaped project on disk, built from real files and real hard links:
 *
 *   <root>/export/Content/ReadyOrNot/Props/Chair.uasset      the game export
 *   <root>/export/Plugins/GameFeatures/ReadyOrNotDLC2/Content/Dlc/Thing.uasset
 *   <root>/fw/RoN/ReadyOrNot.uproject                        the framework's project
 *   <root>/fw/RoN/Content/ReadyOrNot/Props/Chair.uasset      hard link to the export
 *   <root>/fw/RoN/Content/Mods/Me/MyMap.umap                 the mapper's own file
 *   <root>/fw/Tools/ronfw.py                                 a stand-in for the real tool
 */
export interface Fixture {
	root: string;
	project: string;
	projectDir: string;
	exportDir: string;
	toolsDir: string;
	cleanup(): void;
}

function write(file: string, text = "x"): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

const FAKE_RONFW = `VERSION = "9.9.9"
import json, os, sys, time
args = sys.argv[1:]
if "--sleep" in args:
    time.sleep(float(args[args.index("--sleep") + 1]))
print(json.dumps({"argv": args, "cwd": os.getcwd(), "io": os.environ.get("PYTHONIOENCODING")}), flush=True)
sys.exit(3 if "--fail" in args else 0)
`;

export function createFixture(options: { withTools?: boolean } = {}): Fixture {
	const root = mkdtempSync(join(tmpdir(), "mcp ron "));
	const exportDir = join(root, "export");
	const projectDir = join(root, "fw", "RoN");
	const toolsDir = join(root, "fw", "Tools");
	const project = join(projectDir, "ReadyOrNot.uproject");

	write(project, "{}");
	// game content: one file in the export, linked into the project
	const linked: [string, string][] = [
		[
			join(exportDir, "Content", "ReadyOrNot", "Props", "Chair.uasset"),
			join(projectDir, "Content", "ReadyOrNot", "Props", "Chair.uasset"),
		],
		[
			join(
				exportDir,
				"Plugins",
				"GameFeatures",
				"ReadyOrNotDLC2",
				"Content",
				"Dlc",
				"Thing.uasset",
			),
			join(
				projectDir,
				"Plugins",
				"GameFeatures",
				"ReadyOrNotDLC2",
				"Content",
				"Dlc",
				"Thing.uasset",
			),
		],
	];
	for (const [from, to] of linked) {
		write(from);
		mkdirSync(dirname(to), { recursive: true });
		linkSync(from, to);
	}
	// the export also has a file the project does not link (a re-saved game file loses its link)
	write(join(exportDir, "Content", "ReadyOrNot", "Props", "Table.uasset"));
	write(join(projectDir, "Content", "ReadyOrNot", "Props", "Table.uasset"), "re-saved");
	// the mapper's own files
	write(join(projectDir, "Content", "Mods", "Me", "MyMap.umap"));
	write(join(projectDir, "Content", "Mods", "Me", "Props", "Crate.uasset"));

	if (options.withTools !== false) {
		write(join(toolsDir, "ronfw.py"), FAKE_RONFW);
		write(
			join(toolsDir, "ronfw.config.json"),
			JSON.stringify({
				project: project.replace(/\\/g, "/"),
				engine_dir: "C:/UE_5.3",
				export_dir: exportDir.replace(/\\/g, "/"),
				content_root: exportDir.replace(/\\/g, "/"),
			}),
		);
		write(
			join(toolsDir, "profiles", "MyMap.json"),
			JSON.stringify({
				name: "MyMap",
				pak_name: "pakchunk99-Mod_MyMap",
				maps: ["/Game/Mods/Me/MyMap"],
			}),
		);
		write(join(toolsDir, "profiles", "Broken.json"), "{ not json");
		write(join(toolsDir, "profiles", "README.txt"), "not a profile");
	}

	return {
		root,
		project,
		projectDir,
		exportDir,
		toolsDir,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
