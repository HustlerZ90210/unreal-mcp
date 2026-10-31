"""Generate a pyright-friendly `unreal` stub from the cached Unreal Python API documentation.

Every class in the docs index exists in the stub. Classes whose page has been fetched get their real
members and signatures; the rest are shallow (attribute access on them is not checked).

usage: gen_stub.py [ClassName ...]   (fetches those classes and their bases first)
"""
import json
import keyword
import re
import sys

from bs4 import BeautifulSoup

import api_model as am
import common

OUT = common.STUB / "unreal"


def class_names():
    """Names of every class in the docs, from the class list page."""
    cache = common.WORK / "class-names.json"
    if cache.exists():
        return json.loads(cache.read_text())
    soup = BeautifulSoup(common.index_page("classes"), "lxml")
    found = set()
    for a in soup.find_all("a", href=True):
        m = re.search(r"(?:^|/)class/([A-Za-z_]\w*)\.html", a["href"])
        if m:
            found.add(m.group(1))
    if len(found) < 1000:
        raise SystemExit(
            f"Found only {len(found)} classes in the documentation index; the page layout may have changed."
        )
    names = sorted(found)
    cache.write_text(json.dumps(names))
    return names


names = class_names()
nameset = set(names)
for wanted in sys.argv[1:]:
    for _ in am.chain53(wanted):
        pass
fetched = {}
for n in names:
    p = common.PAGES / (n + ".html")
    if p.exists():
        m = am.parse_doc_class(p.read_text(encoding="utf-8"))
        if m:
            fetched[n] = m

def pyname(n):
    n = re.sub(r"\W", "_", n)
    return n + "_" if keyword.iskeyword(n) or n in ("None",) else n

DYNAMIC = {"Object", "ActorComponent", "SceneComponent", "PrimitiveComponent", "MeshComponent", "Class", "Struct"}

SCALARS = {"str": "str", "int": "int", "float": "float", "bool": "bool", "bytes": "bytes", "double": "float",
           "int8": "int", "int16": "int", "int32": "int", "int64": "int", "uint8": "int", "uint16": "int",
           "uint32": "int", "uint64": "int", "byte": "int"}

def split_top(text):
    """Split on commas that are not inside brackets."""
    parts, depth, cur = [], 0, ""
    for ch in text:
        if ch in "[(": depth += 1
        elif ch in "])": depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur); cur = ""
        else:
            cur += ch
    if cur.strip(): parts.append(cur)
    return parts

def map_type(text, defined):
    """Map a docs type string to a stub annotation; anything unclear becomes Any."""
    t = (text or "").strip()
    if not t: return "_t.Any"
    opt = False
    stripped = re.sub(r"\s*(?:or|\|)\s*None$", "", t)
    if stripped != t: t = stripped.strip(); opt = True
    if t.startswith("(") and t.endswith(")"):
        # several return values: `(value, out_name=Type)` is returned as a tuple
        inner = [map_type(p.split("=", 1)[1] if "=" in p else p, defined) for p in split_top(t[1:-1])]
        if not inner: return "_t.Any"
        r = inner[0] if len(inner) == 1 else "_t.Tuple[" + ", ".join(inner) + "]"
        return f"_t.Optional[{r}]" if opt and r != "_t.Any" else r
    if "(" in t or "," in t and not t.startswith(("Array", "Set", "Map")): return "_t.Any"
    m = re.fullmatch(r"(Array|Set)\[(\w+)\]", t)
    if m and m.group(2) in DYNAMIC:
        r = f"{m.group(1)}[_t.Any]"
    elif m:
        inner = map_type(m.group(2), defined)
        r = f"{m.group(1)}[{inner}]"
    elif t in SCALARS:
        r = SCALARS[t]
    elif t in DYNAMIC:
        r = "_t.Any"
    elif t in defined:
        r = t
    else:
        r = "_t.Any"
    return f"_t.Optional[{r}]" if opt and r != "_t.Any" else r

def render_params(params, first):
    out = [first] if first else []
    seen = set()
    for n, d in params:
        pn = pyname(n)
        if not pn or pn in seen or "___" in pn or len(pn) > 40 or pn in ("cls", "self"): continue
        seen.add(pn)
        out.append(pn + (": _t.Any = ..." if d is not None else ": _t.Any"))
    return ", ".join(out)

defined = set(nameset)
lines = ["import typing as _t", "T = _t.TypeVar('T')", "K = _t.TypeVar('K')", "V = _t.TypeVar('V')", "",
 "class Array(_t.Generic[T]):",
 "    def __init__(self, *a: _t.Any) -> None: ...",
 "    def __getitem__(self, i: _t.Any) -> T: ...",
 "    def __setitem__(self, i: _t.Any, v: T) -> None: ...",
 "    def __iter__(self) -> _t.Iterator[T]: ...",
 "    def __len__(self) -> int: ...",
 "    def __contains__(self, v: _t.Any) -> bool: ...",
 "    def append(self, v: T) -> None: ...",
 "    def extend(self, v: _t.Any) -> None: ...",
 "    def __getattr__(self, n: str) -> _t.Any: ...",
 "class Set(_t.Generic[T]):",
 "    def __init__(self, *a: _t.Any) -> None: ...",
 "    def __iter__(self) -> _t.Iterator[T]: ...",
 "    def __len__(self) -> int: ...",
 "    def __getattr__(self, n: str) -> _t.Any: ...",
 "class Map(_t.Generic[K, V]):",
 "    def __init__(self, *a: _t.Any) -> None: ...",
 "    def __getitem__(self, k: K) -> V: ...",
 "    def __iter__(self) -> _t.Iterator[K]: ...",
 "    def __getattr__(self, n: str) -> _t.Any: ...",
 ""]
SKIP = {"Array", "Set", "Map"}
for n in sorted(names):
    if n in SKIP: continue
    if n not in fetched:
        lines.append(f"class {n}(_t.Any): ...")  # shallow: any attribute allowed
        continue
    m = fetched[n]
    bases = [b for b in m["bases"] if b in defined and b != n]
    lines.append(f"class {n}({', '.join(bases) if bases else 'object'}):")
    body = []
    is_enum = "EnumBase" in m["bases"]
    for e in m["enum"]:
        body.append(f"    {pyname(e)}: {n}")
    for pn, pd in m["props"].items():
        body.append(f"    {pyname(pn)}: {map_type(pd['type'], defined)}")
    ctor = render_params(m["ctor"], "self")
    if not is_enum:
        body.append(f"    def __init__({ctor}) -> None: ...")
    for mn, md in m["methods"].items():
        if mn.startswith("__") and mn != "__init__": continue
        ret = map_type(md["ret"], defined)
        params = [(a, d) for a, d in md["params"] if a != "self"]
        if md["classmethod"]:
            body.append("    @classmethod")
            body.append(f"    def {pyname(mn)}({render_params(params, 'cls')}) -> {ret}: ...")
        else:
            body.append(f"    def {pyname(mn)}({render_params(params, 'self')}) -> {ret}: ...")
    if not is_enum:
        # instances of real classes keep unknown-attribute checking; Object-like roots allow extension methods
        pass
    lines += body or ["    pass"]
# module functions
mod = BeautifulSoup(common.index_page("module"), "lxml")
lines.append("")
SUBSYS = {"get_editor_subsystem", "get_engine_subsystem"}
for d in mod.find_all("dl", class_="py function"):
    sig = d.find("dt", class_="sig")
    fn = sig.get("id", "").replace("unreal.", "")
    if fn in SUBSYS:
        lines.append(f"def {fn}(subsystem_type: _t.Type[T]) -> T: ...")
        continue
    params = []
    for p in sig.find_all("em", class_="sig-param"):
        pn = p.find("span", class_="n")
        dv = p.find("span", class_="default_value")
        if pn: params.append((pn.get_text("", strip=True), dv.get_text("", strip=True) if dv else None))
    ret = map_type((sig.find("span", class_="sig-return-typehint") or sig).get_text("", strip=True) if sig.find("span", class_="sig-return-typehint") else "", defined)
    lines.append(f"def {pyname(fn)}({render_params(params, '')}) -> _t.Any: ...")
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "__init__.pyi").write_text("\n".join(lines) + "\n")
print("classes:", len(names), "with real members:", len(fetched), "stub lines:", len(lines))
