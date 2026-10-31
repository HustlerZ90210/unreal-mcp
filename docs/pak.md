# Looking inside .pak files

Three read-only tools that use `UnrealPak` (`<engine>/Engine/Binaries/Win64/UnrealPak.exe`). They never
create or change a pak.

| Tool | What it does |
|---|---|
| `pak_list` | How many files a pak holds, their total size, the biggest folders, and the files (with a filter and a limit) |
| `pak_audit` | Checks that a pak only holds files under the folders you allow, and lists every file outside them |
| `pak_conflicts` | Finds files that more than one pak provides. Give the paks, or a folder to take every `.pak` from |

`pak_audit` is the check to run on a mod pak before you share it. For a Ready or Not mod that should hold
nothing but its own folders:

```
pak_audit  pak: ...\pakchunk99-Mod_MyMap.pak
           allowed_prefixes: ["ReadyOrNot/Content/Mods/YourName/", "ReadyOrNot/Config/Difficulties/"]
```

A folder in `allowed_prefixes` is a game path. `*` stands for any one folder name, so
`*/Content/Mods/YourName/` also works. Case, a leading `/` and a leading `../../../` do not matter, and a
pak that mounts below the game folder is compared by the full path of its files.

`pak_conflicts` does not say which pak wins: that depends on the order the game loads them. For installed
Ready or Not mods use `ron_conflicts` (module `ron`), which knows that order and also checks the game's own
files.

## Setup

UnrealPak is found under `enginePath`; set `unrealPakPath` (`UNREAL_MCP_UNREAL_PAK`, `--unreal-pak`) if it
is somewhere else.

## What has and has not been checked

The tools are tested with a stand-in UnrealPak that prints a prepared listing. That covers reading the
listing (including a 60,000-file pak, which is more output than a buffered read keeps), the audit and
conflict logic, and the error cases. Not covered: **what a real UE 5.3.2 `UnrealPak -List` prints.** The
reader was written from a public script that parses the UE 4.25 output
(`"path" offset: N, size: N bytes, ...`), and accepts the extra fields newer engines add.

If UnrealPak prints lines that look like files but cannot be read, the tools stop with an error that shows
example lines, rather than report an empty pak or "no conflicts". If you see that error, send those lines.

Also true:

- A pak whose contents are encrypted (the game's own paks) cannot be listed; the tools do not take keys.
- The mount point is read from the listing when UnrealPak prints it. If it does not, paths are used as
  printed.
