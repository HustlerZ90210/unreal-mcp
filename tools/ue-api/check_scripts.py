"""Type-check the Python that the tools generate against the Unreal Python API docs.

usage: check_scripts.py <script_dir>

Dump the scripts first:  npx tsx test/helpers/dump-snippets.ts <script_dir>
Every `unreal.<Class>` the scripts name is fetched from the docs (with its base classes), a stub is
generated, and pyright reports calls to methods or attributes the engine does not have. Anything
listed in known-gated.json is hidden: those calls sit behind a version check in the tool itself.
"""
import collections
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import api_model as am
import common

here = Path(__file__).resolve().parent
snippets = Path(sys.argv[1]).resolve()
names = set(json.loads((common.WORK / "class-names.json").read_text())) if (
    common.WORK / "class-names.json"
).exists() else None
if names is None:
    subprocess.run([sys.executable, str(here / "gen_stub.py")], check=True, stdout=subprocess.DEVNULL)
    names = set(json.loads((common.WORK / "class-names.json").read_text()))

used = set()
for script in snippets.glob("*.py"):
    used |= set(re.findall(r"unreal\.([A-Za-z_]\w*)", script.read_text()))
for cls in sorted(used & names):
    for _ in am.chain53(cls):
        pass
subprocess.run([sys.executable, str(here / "gen_stub.py")], check=True, stdout=subprocess.DEVNULL)

config = {
    "include": ["scripts"],
    "extraPaths": [str(common.STUB)],
    "pythonVersion": "3.9",
    "typeCheckingMode": "basic",
    # the scripts print JSON and branch on None freely; only API mistakes matter here
    **{
        rule: "none"
        for rule in (
            "reportOptionalMemberAccess", "reportOptionalSubscript", "reportOptionalIterable",
            "reportOptionalOperand", "reportPossiblyUnbound", "reportUnusedExpression",
            "reportSelfClsParameterName", "reportIndexIssue", "reportArgumentType",
            "reportAssignmentType", "reportReturnType", "reportRedeclaration",
            "reportOperatorIssue", "reportTypedDictNotRequiredAccess",
        )
    },
}
work = common.WORK / "pyright"
work.mkdir(parents=True, exist_ok=True)
link = work / "scripts"
if link.is_symlink() or link.exists():
    link.unlink()
link.symlink_to(snippets, target_is_directory=True)
(work / "pyrightconfig.json").write_text(json.dumps(config))
run = subprocess.run(
    [*common.PYRIGHT.split(), "--outputjson", "-p", str(work)], capture_output=True, text=True
)
diagnostics = json.loads(run.stdout)["generalDiagnostics"]

gated = json.loads((here / "known-gated.json").read_text())
hidden = {(tool, member) for tool, members in gated.items() if tool != "_comment" for member in members}
groups = collections.defaultdict(set)
count = 0
for d in diagnostics:
    tool = os.path.basename(d["file"]).split("__")[0]
    if tool == "execute_python":
        continue  # runs the caller's own code
    message = d["message"].split("\n")[0][:220]
    if any(t == tool and member.split(".")[-1] in message for t, member in hidden):
        continue
    count += 1
    groups[(d.get("rule", "?"), message)].add(tool)

print(f"{count} problems across {len({t for v in groups.values() for t in v})} tools")
for (rule, message), tools in sorted(groups.items()):
    print(f"  {rule}: {message}\n        tools: {', '.join(sorted(tools))[:200]}")
sys.exit(1 if count else 0)
