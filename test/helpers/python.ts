import { spawnSync } from "node:child_process";

/**
 * Static checks on generated Python, run with the system interpreter (no Unreal needed).
 * One interpreter process checks every script, so the whole suite stays fast.
 */

const PROGRAM = String.raw`
import ast, builtins, collections, json, sys

items = json.load(sys.stdin)
known = set(dir(builtins)) | {"unreal", "json"}

def stored_names(tree):
    names = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            names.add(n.id)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(n.name)
            if not isinstance(n, ast.ClassDef):
                a = n.args
                for arg in a.posonlyargs + a.args + a.kwonlyargs + [x for x in (a.vararg, a.kwarg) if x]:
                    names.add(arg.arg)
        elif isinstance(n, ast.Lambda):
            a = n.args
            for arg in a.posonlyargs + a.args + a.kwonlyargs + [x for x in (a.vararg, a.kwarg) if x]:
                names.add(arg.arg)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for alias in n.names:
                names.add((alias.asname or alias.name).split(".")[0])
        elif isinstance(n, ast.ExceptHandler) and n.name:
            names.add(n.name)
    return names

out = []
for item in items:
    try:
        tree = ast.parse(item["source"])
    except SyntaxError as e:
        out.append({"id": item["id"], "syntax": "%s (line %s)" % (e.msg, e.lineno)})
        continue
    defined = known | stored_names(tree)
    undefined = sorted({n.id for n in ast.walk(tree)
                        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in defined})
    shape = collections.Counter(type(n).__name__ for n in ast.walk(tree) if not isinstance(n, ast.Constant))
    out.append({"id": item["id"], "undefined": undefined, "shape": dict(shape)})
json.dump(out, sys.stdout)
`;

export interface PythonCheck {
	id: string;
	/** Syntax error message, if the script does not parse. */
	syntax?: string;
	/** Names that are read but never assigned, imported or built in (typos, JavaScript literals). */
	undefined?: string[];
	/** Count of syntax tree node types, ignoring constants, to compare script structure. */
	shape?: Record<string, number>;
}

function findPython(): string | undefined {
	for (const exe of ["python3", "python"]) {
		const r = spawnSync(exe, ["-I", "-c", "import ast"], { encoding: "utf-8" });
		if (r.status === 0) return exe;
	}
	return undefined;
}

export const PYTHON = findPython();

export function checkPython(scripts: { id: string; source: string }[]): PythonCheck[] {
	if (!PYTHON) throw new Error("No Python interpreter found");
	const r = spawnSync(PYTHON, ["-I", "-c", PROGRAM], {
		input: JSON.stringify(scripts),
		encoding: "utf-8",
		maxBuffer: 256 * 1024 * 1024,
	});
	if (r.status !== 0) throw new Error(`Python check failed: ${r.stderr}`);
	return JSON.parse(r.stdout) as PythonCheck[];
}
