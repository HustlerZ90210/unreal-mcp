# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP (Model Context Protocol) server for Unreal Engine — 132 tools across 18 subsystems. TypeScript/Node.js, ESM, communicates with UE via four transport layers.

## Commands

```bash
npm run dev        # Watch-mode dev server (tsx)
npm run build      # Compile TypeScript → dist/
npm start          # Run compiled server
npm test           # Run tests (vitest)
npm run lint       # Biome check src/
npm run fmt        # Biome format --write src/
npm run check:ue-api  # Type-check every tool's Python against the UE 5.3 Python API docs
npm run api:manifest  # Regenerate src/tools/api-manifest.ts after changing a tool
```

## Architecture

```
stdio (MCP protocol)
  → bin.ts                    # CLI entry, creates server + StdioTransport
  → index.ts                  # createServer() factory, registers tools & resources
  → ConnectionManager         # Orchestrates all 4 transports
  → 17 Tool Modules           # Each exports register*Tools(server, manager, config)
  → 4 Transports → Unreal Engine
```

### Transports (src/transports/)

| Transport | Protocol | Port | Requires |
|-----------|----------|------|----------|
| RemoteControlClient | HTTP to UE Remote Control API | 30010 | Remote Control API plugin (built-in) |
| PythonExecClient | UDP multicast discovery + inverted TCP | 6776 | Python Editor Script Plugin w/ Remote Execution |
| PluginBridgeClient | TCP, length-prefixed JSON | 55557 | Optional C++ plugin for deep Blueprint/K2 access |
| SubprocessRunner | Spawns UAT/UBT processes | N/A | Engine path only (no editor needed) |

Tools gracefully degrade: plugin bridge → Python → Remote Control → subprocess. Not all transports need to be available.

### Tool Modules (src/tools/)

Each module exports a `register*Tools(server, manager, config)` function. Tools are registered via `server.tool()` with Zod parameter schemas. The `MODULE_REGISTRARS` map in `src/tools/index.ts` controls registration; only modules listed in `config.enabledModules` are loaded.

### Configuration (src/config.ts)

Three-layer priority: CLI args (`--rc-port`) > env vars (`UNREAL_MCP_*`) > config file (`.unrealmcp.json` in cwd or home) > defaults. Engine path is auto-detected from `.uproject` EngineAssociation.

### Utilities (src/utils/)

- **errors.ts** — Error class hierarchy (`UnrealMcpError`, `BuildError`, `TimeoutError`, etc.), each with `toToolResult()` for MCP responses
- **output-parser.ts** — Parses MSVC/Clang build output into structured diagnostics
- **template.ts** — `inlineScript()`/`renderScript()` for Python script templating with `{{var}}` substitution and injection-safe escaping

## Reference Projects

This project was built referencing four existing Unreal MCP implementations:

| Project | Language | Tools | Transport | Notes |
|---------|----------|-------|-----------|-------|
| [flopperam/unreal-engine-mcp](https://github.com/flopperam/unreal-engine-mcp) | Python + C++ | ~30 | TCP socket to C++ plugin | Autonomous agent workflows, multi-model routing |
| [chongdashu/unreal-mcp](https://github.com/chongdashu/unreal-mcp) | Python + C++ | ~20 | TCP on port 55557 | Inspired our plugin bridge protocol |
| [kvick-games/UnrealMCP](https://github.com/kvick-games/UnrealMCP) | C++ | ~5 | TCP on port 13377 | Early WIP, minimal toolset |
| [ChiR24/Unreal_mcp](https://github.com/ChiR24/Unreal_mcp) | TypeScript + C++ | 36 | TCP on port 8091 | Action-based dispatch, good security defaults |

Our differentiator: 132 tools, 4 transport layers (most projects have 1), graceful degradation, no mandatory C++ plugin.

## Plugin Enhancement Layer

The C++ plugin is optional. The architecture supports two paths:

- **Core path** (no plugin): Python Remote Execution + Remote Control API. Covers ~95% of tools. Zero-install beyond enabling built-in UE plugins.
- **Plugin path** (optional): C++ plugin on port 55557 adds K2 node graph manipulation, faster operations, and editor UI integration.

The `PluginBridgeClient` supports:
- **Capability negotiation**: On connect, sends `get_capabilities` to learn what the plugin supports
- **Persistent connection**: Reuses TCP socket across commands with auto-reconnect
- **Request IDs**: Each command gets a UUID for response matching
- **Streaming frame parser**: Proper length-prefix parsing for the receive path

Tools use `manager.executeWithPluginFallback()` for the dual-path pattern: tries plugin first, falls back to Python on failure or absence. Always pass all Python scripts through `inlineScript()` with `{{var}}` — never put a tool parameter into Python with raw `${var}`. Static helper constants (like `MATERIAL_HELPERS_PY`) may be interpolated.

## Content protection and the ron module

- `src/tools/guard.ts` wraps the server so tools that change assets are checked against `src/utils/protect.ts` first. A tool that saves, creates, renames, deletes or edits assets must be listed in `WRITE_PARAMS` (a test fails otherwise).
- `src/tools/pak.ts` and `src/pak/unrealpak.ts` read .pak files through `UnrealPak -List` (read only). The listing is read as a stream; a listing that looks like files but cannot be parsed is an error, never an empty pak.
- `src/tools/ron.ts` is the optional Ready or Not module (off until enabled). It runs `ronfw` through `src/utils/jobs.ts`, which keeps long commands running as jobs. See `docs/ron.md`.

## Targeting Unreal Engine 5.3.2

The target engine is 5.3.2 (see `docs/ue-compat.md`). Before using an `unreal.*` API in a tool, confirm it exists in the 5.3 Python docs (`https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/<Class>?application_version=5.3`). Many functions return several values as a tuple (`handle, fail_reason = subsystem.add_new_subobject(params)`), and structs do not have the C++ helper methods (`handle.is_valid()` does not exist; use the function library). If a tool must use something newer, check for it with `getattr(unreal, ...)` in the script, call `manager.requireEngineAtLeast()`, and list it in `tools/ue-api/known-gated.json`. After changing a tool run `npm test`, `npm run check:ue-api` and `npm run api:manifest`. Nothing has been run in a real editor by the fork's maintainers, so say so when reporting results.

## Code Style

- Biome for formatting and linting: tabs, 100-char line width, recommended rules
- Import organization managed by Biome
- All tool parameters validated with Zod schemas
- stdout is reserved for MCP protocol — use stderr for logging
