# Changelog

## Unreleased

### Ready or Not

- Content protection: tools that save, create, rename or delete assets refuse to change engine content,
  `protectedPaths`, anything in the exported game content, and anything hard-linked to another file.
  See [docs/ron.md](docs/ron.md).
- Optional `ron` module (off until enabled) that runs the framework's `ronfw` tool: `ron_status`,
  `ron_check_map`, `ron_build_map`, `ron_light_map`, `ron_conflicts`, `ron_official_levels`,
  `ron_testmode`, `ron_verify_content`, `ron_run`, `ron_job`.
- Long-running commands run as jobs that can be waited for, followed and cancelled.
- `--modules all` enables every module, including optional ones.

### Unreal Engine 5.3.2

- Every tool's Python is checked against the Unreal 5.3 Python API (`npm run check:ue-api`). Calls to
  APIs that 5.3 does not have were replaced; see [docs/ue-compat.md](docs/ue-compat.md) for the
  per-tool differences and what has not been verified.
- New `diagnostics` module: `get_engine_info` and `check_ue_compat`, which tests a running editor
  for every Unreal API the tools use.
- Engine version detection from the config, the engine install (`Build.version`), the project's
  `EngineAssociation`, and the running editor. Tools that need a newer engine now say so.
- Tests (`npm test`) for templating, process spawning, configuration, engine versions and the Python
  every tool generates.

### Fixes

- Boolean tool parameters were sent to the editor as `true`/`false`, which is not valid Python
  (`spawn_actor`, `set_actor_transform` and others).
- Build tools passed target types to UnrealBuildTool instead of target names, and an invalid project
  argument.
- Subprocesses are no longer started through a shell, which broke on paths with spaces, including the
  default Windows engine folder. Batch files are started through `cmd.exe` with checked quoting.
- Commandlet and BuildCookRun arguments (project path, `-unattended`, `-nop4`, `-utf8output`, pak).
- `findUproject` used `require` in an ES module.
- `add_blueprint_variable` generated Python with a syntax error.
- Removed a stray `stderr.tmp` from the repository.
