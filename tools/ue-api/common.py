"""Shared paths and the cached documentation fetcher for the UE API checks."""
import os
import shutil
import time
import urllib.error
import urllib.request
from pathlib import Path

VERSION = os.environ.get("UE_API_VERSION", "5.3")
ROOT = Path(__file__).resolve().parents[2]
WORK = Path(os.environ.get("UE_API_WORK", ROOT / ".cache" / "ue-api" / VERSION))
PAGES = WORK / "pages"
STUB = WORK / "stub"
DOCS = "https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api"
PYRIGHT = os.environ.get("PYRIGHT") or (
    "pyright" if shutil.which("pyright") else "npx --yes pyright@1.1.414"
)

PAGES.mkdir(parents=True, exist_ok=True)


def get_url(url: str, cache_file: Path, delay: float = 0.15):
    """Download a documentation page once; returns None for a 404."""
    if cache_file.exists():
        return cache_file.read_text(encoding="utf-8")
    if cache_file.with_name(cache_file.name + ".404").exists():
        return None
    request = urllib.request.Request(url, headers={"User-Agent": "unreal-mcp-api-check"})
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            data = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            cache_file.with_name(cache_file.name + ".404").write_text("")
            return None
        raise
    cache_file.write_text(data, encoding="utf-8")
    time.sleep(delay)
    return data


def class_page(name: str):
    return get_url(f"{DOCS}/class/{name}?application_version={VERSION}", PAGES / f"{name}.html")


def index_page(kind: str):
    """kind: 'classes' (the class list) or 'module' (the module-level functions)."""
    path = {"classes": "", "module": "module/unreal"}[kind]
    return get_url(f"{DOCS}/{path}?application_version={VERSION}", WORK / f"index-{kind}.html")
