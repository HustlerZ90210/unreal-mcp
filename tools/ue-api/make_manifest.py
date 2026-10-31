"""Work out which Unreal API every tool's generated Python uses, and write src/tools/api-manifest.ts.

usage: make_manifest.py <script_dir> [out.ts]

For each script, every `base.attr` base expression is wrapped as `reveal_type(base).attr`, pyright runs
against the generated `unreal` stub, and the revealed types say which class each attribute belongs to.
The result is a list of (Class, member) pairs and top-level `unreal.<Symbol>` names per tool, which the
check_ue_compat tool tests against a running editor.
"""
import ast
import collections
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import common

here = Path(__file__).resolve().parent
snip_dir = sys.argv[1]
out_ts = Path(sys.argv[2]) if len(sys.argv) > 2 else common.ROOT / "src" / "tools" / "api-manifest.ts"
stub_dir = str(common.STUB)
pyright_bin = common.PYRIGHT
work = str(common.WORK / "manifest")
shutil.rmtree(work, ignore_errors=True)
os.makedirs(work + "/inst")

OPEN = b"reveal_type("
CLOSE = b")"

records = {}  # file -> list of (line, argstart, member, kind)
for fn in sorted(os.listdir(snip_dir)):
    if not fn.endswith(".py"):
        continue
    src = open(os.path.join(snip_dir, fn), "rb").read()
    try:
        tree = ast.parse(src)
    except SyntaxError:
        continue
    lines = src.split(b"\n")
    nodes = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Attribute) and isinstance(n.ctx, ast.Load):
            v = n.value
            if v.lineno != v.end_lineno:
                continue  # multi-line base: skip
            nodes.append((v.lineno, v.col_offset, v.end_col_offset, n.attr))
    per_line = collections.defaultdict(list)
    for (ln, s, e, attr) in nodes:
        per_line[ln].append((s, e, attr))
    out_lines = list(lines)
    recs = []
    for ln, items in per_line.items():
        ins = []  # (col, order, tiebreak, bytes, node_idx)
        for idx, (s, e, attr) in enumerate(items):
            ins.append((s, 1, -e, OPEN, idx))
            ins.append((e, 0, 0, CLOSE, idx))
        ins.sort(key=lambda t: (t[0], t[1], t[2]))
        shift = 0
        newpos = {}
        for (col, order, tb, text, idx) in ins:
            start = col + shift
            if text is OPEN:
                newpos[idx] = start + len(OPEN)
            shift += len(text)
        line = lines[ln - 1]
        res = bytearray()
        last = 0
        for (col, order, tb, text, idx) in ins:
            res += line[last:col]
            res += text
            last = col
        res += line[last:]
        out_lines[ln - 1] = bytes(res)
        for idx, (s, e, attr) in enumerate(items):
            recs.append((ln, newpos[idx], attr))
    header = b"from typing import reveal_type\n"
    open(os.path.join(work, "inst", fn), "wb").write(header + b"\n".join(out_lines))
    records[fn] = [(ln + 1, c, a) for (ln, c, a) in recs]  # +1 for header line

cfg = {"include": ["inst"], "extraPaths": [stub_dir], "pythonVersion": "3.11", "typeCheckingMode": "off",
       "reportUndefinedVariable": "none"}
json.dump(cfg, open(work + "/pyrightconfig.json", "w"))
subprocess.run([*pyright_bin.split(), "--outputjson", "-p", work], stdout=open(work + "/out.json", "w"),
               stderr=subprocess.DEVNULL)
diag = json.load(open(work + "/out.json"))["generalDiagnostics"]
types = {}
for g in diag:
    m = re.match(r'Type of "(.*)" is "(.*)"$', g["message"].split("\n")[0], re.S)
    if not m:
        continue
    fn = os.path.basename(g["file"])
    types[(fn, g["range"]["start"]["line"] + 1, g["range"]["start"]["character"])] = m.group(2)

BUILTIN = {"str", "int", "float", "bool", "list", "dict", "set", "tuple", "type", "bytes", "None", "Module",
           "Array", "Set", "Map", "Unknown", "Any", "Never", "object", "Text", "Name", "Optional"}
stub_file = next(f for f in (stub_dir + "/unreal/__init__.pyi", stub_dir + "/unreal/unreal.py") if os.path.exists(f))
stub_text = open(stub_file, encoding="utf-8-sig").read()
stub_classes = set(re.findall(r"^class (\w+)\(", stub_text, re.M))

def classes_of(t):
    out = []
    for part in re.split(r"\s*\|\s*", t):
        part = part.strip()
        m = re.match(r"(?:type\[)?(?:Optional\[)?(\w+)\]*$", part)
        if m and m.group(1) in stub_classes:
            out.append(m.group(1))
    return out

result = collections.defaultdict(set)
modsyms = collections.defaultdict(set)
unresolved = collections.Counter()
for fn, recs in records.items():
    tool = fn.split("__")[0]
    for (ln, col, attr) in recs:
        t = types.get((fn, ln, col))
        if t is None:
            unresolved["no-type"] += 1
            continue
        if t.startswith('Module("unreal")'):
            modsyms[tool].add(attr)
            continue
        for c in classes_of(t):
            result[tool].add((c, attr))
        if not classes_of(t):
            unresolved[t.split("[")[0][:40]] += 1

# skip tools that run the caller's own code
for skipped in ("execute_python",):
    result.pop(skipped, None)
    modsyms.pop(skipped, None)

gated = {k: v for k, v in json.loads((here / "known-gated.json").read_text()).items() if k != "_comment"}
manifest = {
    "version": common.VERSION,
    "tools": {t: sorted([c, a] for c, a in v if c != "Object") for t, v in sorted(result.items())},
    "symbols": {t: sorted(v) for t, v in sorted(modsyms.items())},
    "gated": gated,
}
pairs = {(c, a) for v in manifest["tools"].values() for c, a in v}
symbols = {x for v in manifest["symbols"].values() for x in v}

out_ts.write_text(
    "// Generated by tools/ue-api/make_manifest.py from the Python the tools generate. Do not edit.\n"
    "// The Unreal Python API each tool calls, so check_ue_compat can test a running editor for it.\n\n"
    "export interface ApiManifest {\n"
    "\t/** Engine version the manifest was checked against */\n\tversion: string;\n"
    "\t/** Per tool: [class, member] pairs that must exist, e.g. [\"EditorAssetLibrary\", \"load_asset\"] */\n"
    "\ttools: Record<string, [string, string][]>;\n"
    "\t/** Per tool: names that must exist directly on the unreal module */\n"
    "\tsymbols: Record<string, string[]>;\n"
    "\t/** Per tool: Class.member entries the tool only uses after checking the engine has them */\n"
    "\tgated: Record<string, string[]>;\n"
    "}\n\n"
    f"export const API_MANIFEST: ApiManifest = {json.dumps(manifest, indent=1)};\n"
)
print("tools:", len(manifest["tools"]), "pairs:", len(pairs), "symbols:", len(symbols))
print("unresolved types (top):", unresolved.most_common(8))
