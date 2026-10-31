"""Parse the Unreal Python API documentation (Sphinx HTML) into a small model."""
import ast
import re

from bs4 import BeautifulSoup

import common

def _txt(el): return el.get_text("", strip=True) if el else ""

def _split_default(n, d):
    """Docs sometimes leave `name=default` unsplit inside the name span."""
    if d is None and "=" in n and not n.startswith(("(", ")")):
        a, b = n.split("=", 1)
        return a.strip(), b.strip()
    return n, d

def fix_sig(params, ret):
    """Epic's docs write `f(a, b)->(T, out=U)` as one parenthesised list, which Sphinx then splits at the
    commas as if it were all parameters. Rebuild the real parameters and the tuple return type."""
    items = None
    for i, (n, d) in enumerate(params):
        if ")->(" in n:
            left, right = n.split(")->(", 1)
            items = [right] + [x for x, _ in params[i + 1:]]
            params = params[:i] + ([(left, d)] if left else [])
            break
    if items is not None:
        ret = "(" + ",".join(items) + ")"
    return [_split_default(n, d) for n, d in params], ret

def parse_doc_class(html, expect=None):
    s = BeautifulSoup(html, "lxml")
    top = s.find("dl", class_="py class")
    if top is None: return None
    dt = top.find("dt")
    name = dt.get("id", "").replace("unreal.", "")
    # constructor params
    ctor = []
    for p in dt.find_all("em", class_="sig-param"):
        n = _txt(p.find("span", class_="n"))
        d = p.find("span", class_="default_value")
        ctor.append((n, _txt(d) if d else None))
    dd = top.find("dd")
    bases = []
    for p in dd.find_all("p", limit=3):
        t = p.get_text(" ", strip=True)
        if t.startswith("Bases:"):
            bases = [b.strip() for b in t[len("Bases:"):].split(",") if b.strip()]
            break
    methods, props, enums = {}, {}, []
    for d in dd.find_all("dl", class_="py"):
        classes = d.get("class", [])
        sig = d.find("dt", class_="sig")
        if sig is None: continue
        ident = sig.get("id", "")
        mname = ident.split(".")[-1]
        if "method" in classes:
            params = []
            for p in sig.find_all("em", class_="sig-param"):
                n = _txt(p.find("span", class_="n"))
                dv = p.find("span", class_="default_value")
                params.append((n, _txt(dv) if dv else None))
            ret = _txt(sig.find("span", class_="sig-return-typehint"))
            params, ret = fix_sig(params, ret)
            prop_em = [_txt(e) for e in sig.find_all("em", class_="property")]
            methods[mname] = {"params": params, "ret": ret, "classmethod": any("classmethod" in e or "static" in e for e in prop_em)}
        elif "property" in classes:
            ems = sig.find_all("em", class_="property")
            typ = _txt(ems[-1]).lstrip(":").strip() if len(ems) > 1 else ""
            desc = _txt(d.find("dd"))[:60]
            props[mname] = {"type": typ, "rw": "Read-Write" in desc, "ro": "Read-Only" in desc}
        elif "attribute" in classes:
            enums.append(mname)
    return {"name": name, "bases": bases, "ctor": ctor, "methods": methods, "props": props, "enum": enums}

def load53(cls):
    html = common.class_page(cls)
    return None if html is None else parse_doc_class(html)

def chain53(cls, seen=None):
    """Yield (class, model) for cls and its documented bases."""
    seen = seen if seen is not None else set()
    if cls in seen: return
    seen.add(cls)
    m = load53(cls)
    if m is None: return
    yield cls, m
    for b in m["bases"]:
        yield from chain53(b, seen)

def parse_stub_file(path):
    src = open(path, encoding="utf-8-sig").read()
    tree = ast.parse(src)
    out = {}
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            bases = [b.id for b in node.bases if isinstance(b, ast.Name)]
            methods, props, enums = {}, set(), []
            for it in node.body:
                if isinstance(it, ast.FunctionDef):
                    decos = [ast.unparse(d) for d in it.decorator_list]
                    if any(d.endswith(".setter") for d in decos): continue
                    if "property" in decos:
                        props.add(it.name); continue
                    a = it.args
                    names = [x.arg for x in a.posonlyargs + a.args]
                    if names and names[0] in ("self", "cls"): names = names[1:]
                    nd = len(a.defaults)
                    params = [(n, None) for n in names]
                    for i in range(nd):
                        params[len(params) - nd + i] = (params[len(params) - nd + i][0], "...")
                    methods[it.name] = {"params": params, "classmethod": "classmethod" in decos or "staticmethod" in decos,
                                         "ret": ast.unparse(it.returns) if it.returns else ""}
                elif isinstance(it, ast.AnnAssign) and isinstance(it.target, ast.Name):
                    enums.append(it.target.id)
                elif isinstance(it, ast.Assign):
                    for t in it.targets:
                        if isinstance(t, ast.Name): enums.append(t.id)
            out[node.name] = {"bases": bases, "methods": methods, "props": props, "enum": enums}
    return out
