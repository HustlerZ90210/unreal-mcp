# Unreal Engine 5.3.2 compatibility

This fork targets **Unreal Engine 5.3.2**. This page says what that means, how it was checked, what
was *not* checked, and how to check your own editor.

## Status

| | |
|---|---|
| Target engine | 5.3.2 |
| Checked against | The Unreal 5.3 Python API documentation, by static analysis (below) |
| Run in a real 5.3.2 editor by this fork's maintainers | **No.** The development environment has no Unreal Engine, so nothing here has been executed against a live editor yet |
| Tools that need a newer engine | `add_blueprint_variable` (5.5+). They report this instead of failing |
| Tools that need the optional C++ plugin on 5.3 | `apply_anim_modifier`, and the Blueprint graph tools as before |

Treat the checks below as strong evidence that the tools call the right API with the right
arguments, not as proof that every tool behaves correctly in your editor. Run `check_ue_compat`
(see below) and report what it finds.

## How it was checked

1. **Every tool's Python is type-checked against the 5.3 API.** `npm run check:ue-api` renders each
   tool with generated arguments (every enum value, boolean and optional parameter), builds a type
   stub from Epic's published 5.3 Python API pages, and runs `pyright` over the result. It catches
   methods that do not exist in 5.3, wrong argument names, and wrong unpacking of return values
   (many Unreal functions return several values as a tuple). The script needs Python 3 and network
   access to the documentation site, and caches what it downloads in `.cache/`.
2. **Unit tests** (`npm test`, no Unreal needed):
   - templating: strings are escaped, booleans become `True`/`False`, numbers stay numbers
   - spawning processes and quoting arguments for Windows batch files, including paths with spaces
     (the default install folder is `C:\Program Files\Epic Games\UE_5.3`)
   - engine version detection and configuration precedence
   - every tool's generated Python parses, only reads names that exist, and keeps hostile arguments
     (quotes, backslashes, `{{x}}`, code) inside their string literals
   - the `check_ue_compat` logic, run against a fake `unreal` module
3. **`check_ue_compat`**, a tool you run inside your own editor (below).

### What this does not prove

- That an API behaves as intended. A call can exist, take the right arguments and still fail for a
  reason that only shows at runtime (an asset type that does not support it, an editor state it
  needs, a plugin that is not enabled).
- That the editor connection works. Python Remote Execution depends on multicast on your network
  (see [Editor setup](#editor-setup-for-532)).
- The optional C++ plugin, which is not part of this repository.

## Check your editor

1. Start the editor with the plugins enabled ([setup](#editor-setup-for-532)) and connect the server.
2. Call `get_engine_info`. It reports the engine version, the project, and which of the four
   transports are connected. It also works when the editor is closed.
3. Call `check_ue_compat`. It looks, inside the editor, for every Unreal Python class and function
   the tools use, and returns:
   - `ok`: whether everything was found
   - `tools_that_will_fail`: tools that call an API your engine does not have
   - `missing`: each missing API and the tools that use it
   - `version_gated`: APIs that a tool only uses after checking they exist (informational)
   - `same_minor_version`: whether your engine is the version the list was built for (5.3)

   On 5.3.2 the result should be `ok: true`, with `add_blueprint_variable`'s newer APIs listed under
   `version_gated`. Anything else is a bug to report, with the output attached.

## What is different on 5.3

| Tool | Behaviour |
|---|---|
| `add_blueprint_variable` | Needs UE 5.5. On 5.3 it returns an error that says so. Add the variable in the Blueprint editor, or use the optional plugin |
| `add_blueprint_component` | Uses the subobject subsystem (`SubobjectDataSubsystem`), the way the editor's Components panel does |
| `apply_anim_modifier` | Unreal's Python API cannot apply modifiers, so this needs the optional plugin and says so without it |
| `render_sequence` | Queues a Movie Render Queue job. Needs the Movie Render Pipeline plugin. It no longer takes an `output_directory`; set the output folder in the Movie Render Queue window |
| `get_loaded_cells` | Reports whether the level uses World Partition, its bounds and actor counts. Python does not expose individual streaming cells |
| `set_data_layer_state` | Loads, unloads or shows the layer in the **editor** (the Data Layers panel). It does not change runtime state in a play session |
| `set_streaming_source` | Adds a World Partition streaming source component through the subobject subsystem and sets its radius and optional target grid |
| `generate_lods`, `generate_collision`, `generate_lightmap_uvs` | Use `StaticMeshEditorSubsystem` |
| `set_skeletal_mesh_lod` | Uses `SkeletalMeshEditorSubsystem` |
| console-based tools (`undo`, `redo`, automation, `stat`, trace, CSV profiling, map check) | Run the console command against the editor world |
| material graph tools | Use `MaterialEditingLibrary`; material properties are named as the engine names them (`MP_BASE_COLOR`) |

## Fixes that are not specific to 5.3

Found while checking against 5.3, and independent of engine version:

- Boolean tool parameters were written into Python as `true` / `false`, which Python does not
  understand (`spawn_actor`, `set_actor_transform` and others failed with a `NameError`).
- `build_target` and `clean_project` passed target types such as `Editor` to UnrealBuildTool, which
  wants a target name such as `MyGameEditor`, and used an invalid project argument.
- Processes were started through a shell, which broke on any path with a space, including the default
  engine install folder on Windows.
- `findUproject` used `require` in an ES module.
- `add_blueprint_variable` generated Python with a syntax error.

## Editor setup for 5.3.2

The README's [Unreal Editor Setup](../README.md#unreal-editor-setup) applies. The part that most often
goes wrong on 5.3:

- Enable **Python Editor Script Plugin** and **Remote Execution**, restart the editor.
- Set **Multicast Bind Address** as the README describes. On 5.3 the default can stop external tools from
  finding the editor.
- Optional: **Remote Control API** with Remote Python Execution allowed, for the Remote Control
  transport.
- `UnrealEditor-Cmd.exe` is used for commandlets when it is found under the engine path.

## Maintaining the list

Adding or changing a tool that talks to the editor:

1. Write the Python with `inlineScript()` and `{{variables}}`. Never put a tool parameter into a script
   with `${...}`; only static text may be interpolated.
2. `npm test` — the tests fail if the Python does not parse, reads an undefined name, or lets an
   argument escape its string literal.
3. `npm run check:ue-api` — fails on a call the 5.3 API does not have. If a tool deliberately calls
   something newer after checking for it, list it in `tools/ue-api/known-gated.json`.
4. `npm run api:manifest` — regenerates `src/tools/api-manifest.ts`, which `check_ue_compat` uses.
   A test fails when the manifest is out of date.

To check against another engine version, set `UE_API_VERSION` (for example `5.4`) before running the
scripts in `tools/ue-api/`.
