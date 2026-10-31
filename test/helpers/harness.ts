import { type ZodTypeAny, z } from "zod";
import { ALL_MODULES, type UnrealMcpConfig } from "../../src/types.js";
import { parseEngineVersion } from "../../src/utils/engine-version.js";

/**
 * A recording stand-in for the MCP server and the Unreal connection.
 *
 * Every registered tool handler can be run with generated arguments. The Python it would
 * send to the editor, the Remote Control calls and the subprocess calls it would make are
 * recorded instead of executed. This lets tests check the generated Python without an editor.
 */

export interface RegisteredTool {
	name: string;
	description: string;
	shape: Record<string, ZodTypeAny>;
	handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface Recording {
	python: string[];
	calls: { target: string; method: string; args: unknown[] }[];
}

export function testConfig(overrides: Partial<UnrealMcpConfig> = {}): UnrealMcpConfig {
	return {
		projectPath: "/projects/Sample/Sample.uproject",
		enginePath: "/engines/UE_5.3",
		engineVersion: "5.3.2",
		remoteControlPort: 30010,
		remoteControlWsPort: 30020,
		pythonExecPort: 6776,
		pluginBridgePort: 55557,
		platform: "Win64",
		configuration: "Development",
		enabledModules: [...ALL_MODULES],
		timeouts: { build: 1000, cook: 1000, remoteControl: 1000, pythonExec: 1000 },
		...overrides,
	};
}

export function createFakeServer() {
	const tools = new Map<string, RegisteredTool>();
	const server = {
		// biome-ignore lint/suspicious/noExplicitAny: mirrors the overloaded McpServer.tool signature
		tool(name: string, ...rest: any[]) {
			const handler = rest[rest.length - 1];
			const middle = rest.slice(0, -1);
			const description = typeof middle[0] === "string" ? (middle.shift() as string) : "";
			const shape = (middle[0] ?? {}) as Record<string, ZodTypeAny>;
			if (tools.has(name)) throw new Error(`duplicate tool name: ${name}`);
			tools.set(name, { name, description, shape, handler });
		},
		resource() {},
	};
	return { server, tools };
}

/**
 * A fake ConnectionManager. Anything not listed explicitly is a recording no-op that resolves
 * to an empty JSON object, so tools that parse results keep working.
 */
export function createFakeManager(recording: Recording, opts: { hasPlugin?: boolean } = {}) {
	const recorder = (target: string) =>
		new Proxy(
			{},
			{
				get: (_t, method: string) => {
					if (method === "then") return undefined;
					return async (...args: unknown[]) => {
						recording.calls.push({ target, method, args });
						if (target === "subprocess")
							return { exitCode: 0, stdout: "", stderr: "", duration: 0 };
						if (/^(list|search|batch)/.test(method)) return [];
						return {};
					};
				},
			},
		);

	const manager = {
		requireEditor() {},
		hasPlugin: opts.hasPlugin ?? false,
		pluginCapabilities: null,
		status: { remoteControl: true, pythonExec: true, pluginBridge: false, editorRunning: true },
		async refreshStatus() {
			return manager.status;
		},
		engineVersion: parseEngineVersion("5.3.2"),
		async detectEngineVersion() {
			return manager.engineVersion;
		},
		async requireEngineAtLeast() {},
		async runPython(code: string) {
			recording.python.push(code);
			return "{}";
		},
		async executeWithPluginFallback(options: {
			pluginCommand: string;
			pluginParams: Record<string, unknown>;
			pythonFallback: () => Promise<string>;
		}) {
			recording.calls.push({
				target: "manager",
				method: `executeWithPluginFallback:${options.pluginCommand}`,
				args: [options.pluginParams],
			});
			return options.pythonFallback();
		},
		rc: recorder("rc"),
		python: recorder("python"),
		plugin: recorder("plugin"),
		subprocess: recorder("subprocess"),
	};
	return manager;
}

// --- argument generation from zod shapes ---------------------------------------------------

export const HOSTILE_STRING = `it's a "test" \\ {{x}} \${y} \n line2 ; import os #`;

type Mode = "plain" | "hostile";

// biome-ignore lint/suspicious/noExplicitAny: zod internals are inspected structurally
function def(schema: ZodTypeAny): any {
	// biome-ignore lint/suspicious/noExplicitAny: zod internals
	return (schema as any)._def;
}

export function sampleValue(
	schema: ZodTypeAny,
	mode: Mode,
	overrides: { boolean?: boolean; enumIndex?: number } = {},
): unknown {
	const d = def(schema);
	switch (d.typeName) {
		case "ZodString":
			return mode === "hostile" ? HOSTILE_STRING : "SampleName";
		case "ZodNumber":
			return 2;
		case "ZodBoolean":
			return overrides.boolean ?? true;
		case "ZodEnum":
			return d.values[Math.min(overrides.enumIndex ?? 0, d.values.length - 1)];
		case "ZodNativeEnum":
			return Object.values(d.values)[0];
		case "ZodLiteral":
			return d.value;
		case "ZodArray":
			return [sampleValue(d.type, mode, overrides)];
		case "ZodObject": {
			const shape = d.shape() as Record<string, ZodTypeAny>;
			return Object.fromEntries(
				Object.entries(shape).map(([k, v]) => [k, sampleValue(v, mode, overrides)]),
			);
		}
		case "ZodRecord":
			return { key: sampleValue(d.valueType, mode, overrides) };
		case "ZodOptional":
		case "ZodNullable":
			return sampleValue(d.innerType, mode, overrides);
		case "ZodDefault":
			return sampleValue(d.innerType, mode, overrides);
		case "ZodUnion":
			return sampleValue(d.options[0], mode, overrides);
		case "ZodEffects":
			return sampleValue(d.schema, mode, overrides);
		default:
			return mode === "hostile" ? HOSTILE_STRING : "SampleValue";
	}
}

function enumFields(shape: Record<string, ZodTypeAny>): [string, number][] {
	const out: [string, number][] = [];
	for (const [k, v] of Object.entries(shape)) {
		let s = v;
		while (["ZodOptional", "ZodDefault", "ZodNullable"].includes(def(s).typeName))
			s = def(s).innerType;
		if (def(s).typeName === "ZodEnum") out.push([k, def(s).values.length]);
	}
	return out;
}

function booleanFields(shape: Record<string, ZodTypeAny>): string[] {
	const out: string[] = [];
	for (const [k, v] of Object.entries(shape)) {
		let s = v;
		while (["ZodOptional", "ZodDefault", "ZodNullable"].includes(def(s).typeName))
			s = def(s).innerType;
		if (def(s).typeName === "ZodBoolean") out.push(k);
	}
	return out;
}

function optionalFields(shape: Record<string, ZodTypeAny>): string[] {
	return Object.entries(shape)
		.filter(([, v]) => ["ZodOptional", "ZodDefault"].includes(def(v).typeName))
		.map(([k]) => k);
}

export interface ArgVariant {
	label: string;
	args: Record<string, unknown>;
}

/** Generate argument sets that exercise each branch of a tool: booleans, enums, optionals. */
export function argVariants(shape: Record<string, ZodTypeAny>, mode: Mode = "plain"): ArgVariant[] {
	const build = (overrides: { boolean?: boolean; enumIndex?: number }, omit: string[] = []) =>
		Object.fromEntries(
			Object.entries(shape)
				.filter(([k]) => !omit.includes(k))
				.map(([k, v]) => [k, sampleValue(v, mode, overrides)]),
		);

	const variants: ArgVariant[] = [{ label: "base", args: build({}) }];
	for (const f of booleanFields(shape)) {
		const args = build({});
		args[f] = false;
		variants.push({ label: `${f}=false`, args });
	}
	for (const [f, count] of enumFields(shape)) {
		for (let i = 1; i < count; i++) {
			const args = build({ enumIndex: 0 });
			args[f] = sampleValue(shape[f], mode, { enumIndex: i });
			variants.push({ label: `${f}#${i}`, args });
		}
	}
	for (const f of optionalFields(shape)) {
		variants.push({ label: `omit ${f}`, args: build({}, [f]) });
	}
	return variants;
}

export interface RenderedScript {
	tool: string;
	variant: string;
	python: string;
}

/** Register every module, run every tool with generated arguments, and collect the Python. */
export async function collectScripts(
	registerAll: (server: never, manager: never, config: UnrealMcpConfig) => void,
	config: UnrealMcpConfig,
	mode: Mode = "plain",
): Promise<{
	scripts: RenderedScript[];
	errors: { tool: string; variant: string; error: string }[];
}> {
	const { server, tools } = createFakeServer();
	const recording: Recording = { python: [], calls: [] };
	const manager = createFakeManager(recording);
	registerAll(server as never, manager as never, config);

	const scripts: RenderedScript[] = [];
	const errors: { tool: string; variant: string; error: string }[] = [];
	for (const tool of tools.values()) {
		for (const v of argVariants(tool.shape, mode)) {
			recording.python.length = 0;
			try {
				// Apply zod defaults the way the MCP SDK does before calling a handler.
				await tool.handler(z.object(tool.shape).parse(v.args));
			} catch (e) {
				errors.push({ tool: tool.name, variant: v.label, error: String(e) });
			}
			for (const python of recording.python) {
				scripts.push({ tool: tool.name, variant: v.label, python });
			}
		}
	}
	return { scripts, errors };
}
