import { inlineScript } from "./template.js";

/**
 * Defines `run_console(cmd)`, which runs a console command against the editor world.
 * Passing no world works for some commands but not for those that need a viewport or world
 * (stat commands, map check), so always hand the editor world to the engine.
 */
export const CONSOLE_PRELUDE = `import unreal
def run_console(cmd):
    world = None
    try:
        world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    except Exception:
        pass
    unreal.SystemLibrary.execute_console_command(world, cmd)
`;

/** Like inlineScript, with run_console() available. The script body must not start with its own prelude. */
export function consoleScript(
	code: string,
	vars: Record<string, string | number | boolean> = {},
): string {
	return inlineScript(`${CONSOLE_PRELUDE}${code}`, vars);
}
