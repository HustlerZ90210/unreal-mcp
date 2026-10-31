# Ready or Not modding

Two things for people making [Ready or Not](https://store.steampowered.com/app/1144200/) mods with the
Community Mapping Framework (Unreal Engine 5.3.2):

1. **Content protection**, on for everyone. The tools refuse to change content that must not change, such
   as the game files that the framework hard-links into your project.
2. **The `ron` module**, off until you turn it on. It runs the framework's `ronfw` tool, so an assistant
   can check, build and install maps the way you do from the command line.

## Status

Neither part has been run against a real framework install with the Unreal editor. They are tested
against what can be built without one:

- The protection rules run against real files and **real hard links** on disk, on Linux and Windows
  (CI), including plugin (DLC) content and files that were re-saved and lost their link.
- The `ron` tools run a **stand-in `ronfw.py`** that prints the arguments it was given. That proves the
  arguments, working folder, encoding settings, failure reporting, long-running jobs and cancelling work.
  It does not prove what the real `ronfw` does with them: the commands and flags come from reading
  `Tools/ronfw.py` (framework 0.5.0) and `Tools/README.md`, not from running them.

Please report anything that differs on your machine.

## Content protection

A framework project links your game export into its content folder, so a file in the project and the same
file in the export are one file on disk. Saving, renaming or deleting it from the editor, a script or an
assistant changes your export. The tools that change content now check first and refuse with an
explanation:

```
Refusing to change /Game/ReadyOrNot/Props/Chair: it is hard-linked to another file (an exported copy of
game content). Make a copy under your own folder (for example /Game/Mods/<YourName>/) and change that.
To lift the protection, edit protectedPaths or protectLinkedContent in the configuration.
```

A content path is protected when:

| Rule | Detail |
|---|---|
| Engine content | Anything under `/Engine`, always |
| `protectedPaths` | Prefixes you list, for example `["/Game/ReadyOrNot"]` (case does not matter) |
| In your game export | The asset or folder also exists in the exported game content that `ronfw setup` recorded. This still protects a file the editor re-saved, which has lost its link |
| Hard-linked | The asset's `.uasset` / `.umap` has more than one hard link, or a folder holds such files |

Your own assets under `/Game/Mods/...` have one link and stay editable, and so does a folder you are
about to create.

Covered: the tools that save, create, rename, duplicate, delete or import assets, and those that edit
Blueprints, materials, sequences, animations and meshes (the list is `WRITE_PARAMS` in
`src/tools/guard.ts`, and a test fails if a tool that writes assets is missing from it). `resave_packages`
without a folder counts as the whole project.

**Not covered:** `execute_python` and the Editor Utility tools run whatever code they are given, and
edits to actors in the open level are changes in memory until a level is saved (use **File > Save
Current Level**, never Save All with an official level loaded). `ronfw verify-content` restores a game
file the editor re-saved; it is available as `ron_verify_content`.

Settings:

| Setting | Env variable | Argument | Default |
|---|---|---|---|
| `protectedPaths` | `UNREAL_MCP_PROTECTED_PATHS` | `--protected-paths` | none (comma separated) |
| `protectLinkedContent` | `UNREAL_MCP_PROTECT_LINKED_CONTENT` (`0` turns it off) | `--no-protect-linked-content` | on |

## The `ron` module

Turn it on with `--modules all`, or list it: `"enabledModules": ["console", "actor", "asset", "ron"]`
(`UNREAL_MCP_MODULES=all` works too).

Where the framework is: set `ronFrameworkPath` (`UNREAL_MCP_RON_FRAMEWORK`, `--ron-framework`) to the
folder that holds `Tools`, or just use the framework's own `ReadyOrNot.uproject` as `projectPath` and it
is found next to it. `ronfw` runs with `ronPython` (`UNREAL_MCP_RON_PYTHON`, `--ron-python`) if set, else
the Python that ships with the engine (`Engine/Binaries/ThirdParty/Python3`), else `python` on your PATH.
Run `python ronfw.py setup` once yourself first.

| Tool | Runs | Notes |
|---|---|---|
| `ron_status` | (reads files) | Framework version and location, what `setup` found, your profiles, protection settings, running jobs |
| `ron_check_map` | `check-map <map>` | |
| `ron_build_map` | `build <map> [flags]` | Check, cook, pak, install. `launch` starts the game through Steam |
| `ron_light_map` | `light <map> --quality ...` | Lightmass build |
| `ron_conflicts` | `conflicts --show N` | Files several installed paks provide |
| `ron_official_levels` | `official --list [--check]` | |
| `ron_testmode` | `testmode on\|off\|status [maps]` | Moves other mods' paks to `Paks_parked` and back |
| `ron_verify_content` | `verify-content` | Restores re-saved game files |
| `ron_run` | any of: `new-map`, `new-profile`, `namespace`, `mission`, `qsm`, `bake`, `spawn-limits`, `remove-actors`, `official`, `remix`, `variant`, `port-volumes`, `view`, `check-refs`, `uninstall`, `link-content`, `content`, `live status\|rooms` | Arguments go to `ronfw` as they are |
| `ron_job` | | Follow, wait for, cancel or list long commands |

Left out on purpose: `setup`, `export-game` (about 100 GB), `package`, `launcher`, `editor-plugin`,
`kit-module`, `selftest` (hours), `test` (needs UE4SS in the game), `restore-ue4ss` and `live run` (use
`execute_python`). Run those yourself.

A map is a profile name (`MyMap`) or a `/Game/...` path. Names that start with `-` or contain `..` are
refused.

### Long commands

A build or lighting run can take far longer than an assistant can wait. Every `ron` command is a job:
it waits for `wait_seconds` (a default per command) and, if the command has not finished, returns
`status: "running"` with a `job_id` and the end of the output so far. `ron_job` then shows the state
(`status`), waits longer (`wait`), cancels (`cancel`), or lists the jobs of this session (`list`).
Cancelling stops `ronfw` and the programs it started. Jobs keep running if the server stops, and
finished jobs are forgotten after 20.

A command that fails (non-zero exit) comes back as an error with its exit code and the end of its
output.

## Why not more

The framework already has an editor menu, a tools window and a live link to an open editor. This module
does not replace them: it lets an assistant use the same tool, and the protection makes the general
tools safe in a project that has game content linked in.
