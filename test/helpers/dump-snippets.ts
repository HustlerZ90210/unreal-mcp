/**
 * Dev helper: write every tool's generated Python to a directory so it can be checked with
 * external tools (pyflakes, pyright against an `unreal` stub, ...).
 *
 *   npx tsx test/helpers/dump-snippets.ts <outDir> [plain|hostile]
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerAllTools } from "../../src/tools/index.js";
import { collectScripts, testConfig } from "./harness.js";

const outDir = process.argv[2];
const mode = (process.argv[3] as "plain" | "hostile") ?? "plain";
if (!outDir) {
	console.error("usage: dump-snippets.ts <outDir> [plain|hostile]");
	process.exit(2);
}
mkdirSync(outDir, { recursive: true });
for (const old of readdirSync(outDir)) {
	if (old.endsWith(".py")) rmSync(join(outDir, old));
}

const { scripts, errors } = await collectScripts(registerAllTools as never, testConfig(), mode);
let n = 0;
for (const s of scripts) {
	const safe = `${s.tool}__${s.variant}`.replace(/[^a-zA-Z0-9_.=#-]+/g, "_");
	writeFileSync(join(outDir, `${safe}.py`), s.python.endsWith("\n") ? s.python : `${s.python}\n`);
	n++;
}
console.error(`wrote ${n} scripts to ${outDir}; ${errors.length} handler errors`);
for (const e of errors) console.error(`  ${e.tool} [${e.variant}]: ${e.error}`);
