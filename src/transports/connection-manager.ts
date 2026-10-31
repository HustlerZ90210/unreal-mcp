import type { ConnectionStatus, PluginCapabilities, UnrealMcpConfig } from "../types.js";
import {
	type EngineVersion,
	formatVersion,
	isAtLeast,
	parseEngineVersion,
} from "../utils/engine-version.js";
import { UnsupportedEngineError } from "../utils/errors.js";
import { PluginBridgeClient } from "./plugin-bridge.js";
import { PythonExecClient } from "./python-exec.js";
import { RemoteControlClient } from "./remote-control.js";
import { SubprocessRunner } from "./subprocess.js";

/**
 * Orchestrates all transport connections to Unreal Engine.
 * Handles initialization, health checks, and graceful degradation.
 */
export class ConnectionManager {
	public rc!: RemoteControlClient;
	public python!: PythonExecClient;
	public plugin!: PluginBridgeClient;
	public subprocess!: SubprocessRunner;

	private _engineVersion?: EngineVersion;
	private _versionProbedFromEditor = false;
	private _lastVersionProbe = 0;

	private _status: ConnectionStatus = {
		remoteControl: false,
		pythonExec: false,
		pluginBridge: false,
		editorRunning: false,
	};

	async initialize(config: UnrealMcpConfig): Promise<void> {
		this._engineVersion = parseEngineVersion(config.engineVersion);

		// Initialize all transports
		this.rc = new RemoteControlClient({
			host: "127.0.0.1",
			port: config.remoteControlPort,
			timeout: config.timeouts.remoteControl,
		});

		this.python = new PythonExecClient({
			host: "127.0.0.1",
			port: config.pythonExecPort,
			timeout: config.timeouts.pythonExec,
		});

		this.plugin = new PluginBridgeClient({
			host: "127.0.0.1",
			port: config.pluginBridgePort,
			timeout: config.timeouts.remoteControl,
		});

		this.subprocess = new SubprocessRunner({
			enginePath: config.enginePath,
			projectPath: config.projectPath,
			platform: config.platform,
			configuration: config.configuration,
			timeouts: {
				build: config.timeouts.build,
				cook: config.timeouts.cook,
			},
		});

		// Probe connections (non-blocking — tools handle failures gracefully)
		await this.refreshStatus();
	}

	/**
	 * Check all transport connections and update status.
	 */
	async refreshStatus(): Promise<ConnectionStatus> {
		const [rcAvailable, pythonAvailable, pluginAvailable] = await Promise.all([
			this.rc.isAvailable().catch(() => false),
			this.python.isAvailable().catch(() => false),
			this.plugin.isAvailable().catch(() => false),
		]);

		this._status = {
			remoteControl: rcAvailable,
			pythonExec: pythonAvailable,
			pluginBridge: pluginAvailable,
			editorRunning: rcAvailable || pythonAvailable,
		};

		return this._status;
	}

	get status(): ConnectionStatus {
		return { ...this._status };
	}

	/**
	 * Ensure the editor is connected via at least one transport.
	 * Throws if no editor connection is available.
	 */
	requireEditor(): void {
		if (!this._status.editorRunning) {
			throw new Error(
				"Unreal Editor is not connected. Make sure the editor is running with " +
					"Remote Control API and/or Python Editor Script plugins enabled.",
			);
		}
	}

	/**
	 * The engine version, if known. It comes from the config (set explicitly, read from the
	 * engine install, or taken from the project's EngineAssociation) until the running editor has
	 * been asked, and from the editor after that.
	 */
	get engineVersion(): EngineVersion | undefined {
		return this._engineVersion;
	}

	/**
	 * Ask the running editor for its version once (retrying at most every 30 s after a failure).
	 * The editor is authoritative: a project may be opened with a different engine than it names.
	 */
	async detectEngineVersion(): Promise<EngineVersion | undefined> {
		if (
			!this._versionProbedFromEditor &&
			this._status.editorRunning &&
			Date.now() - this._lastVersionProbe > 30_000
		) {
			this._lastVersionProbe = Date.now();
			try {
				const output = await this.runPython(
					"import unreal\nprint(unreal.SystemLibrary.get_engine_version())",
				);
				const version = parseEngineVersion(output);
				if (version) {
					this._engineVersion = version;
					this._versionProbedFromEditor = true;
				}
			} catch {
				// Keep whatever the config told us
			}
		}
		return this._engineVersion;
	}

	/**
	 * Throw a clear error when the editor is older than a tool needs. An unknown version is
	 * allowed through, because the tool can still report what the editor says.
	 */
	async requireEngineAtLeast(min: string, feature: string, alternative?: string): Promise<void> {
		const version = await this.detectEngineVersion();
		if (version && isAtLeast(version, min) === false) {
			throw new UnsupportedEngineError(feature, min, formatVersion(version), alternative);
		}
	}

	/**
	 * Check if the optional C++ plugin is available.
	 */
	get hasPlugin(): boolean {
		return this._status.pluginBridge;
	}

	/**
	 * Get the plugin's negotiated capabilities, or null if plugin is not connected.
	 */
	get pluginCapabilities(): PluginCapabilities | null {
		return this.plugin?.capabilities ?? null;
	}

	/**
	 * Execute Python code using the best available transport.
	 * Tries: Python Remote Execution → Remote Control API executePython.
	 * This is the primary method tools should use instead of calling manager.python.execute() directly.
	 */
	async runPython(code: string): Promise<string> {
		// Try Python Remote Execution first (full stdout capture)
		if (this._status.pythonExec) {
			try {
				return await this.python.execute(code);
			} catch (error) {
				// If Python exec fails, fall through to RC if available
				if (!this._status.remoteControl) throw error;
				console.error(`[unreal-mcp] Python exec failed, falling back to Remote Control: ${error}`);
			}
		}

		// Fall back to Remote Control API
		if (this._status.remoteControl) {
			return this.rc.executePython(code);
		}

		throw new Error(
			"No Python execution transport available. Enable Python Editor Script Plugin with Remote Execution, " +
				"or enable the Remote Control API plugin.",
		);
	}

	/**
	 * Execute an operation with plugin-first, Python-fallback strategy.
	 *
	 * If the plugin is available and supports the given command, it is used.
	 * On plugin failure or absence, the pythonFallback function is called instead.
	 * This centralizes the dual-path pattern used across tool modules.
	 */
	async executeWithPluginFallback(options: {
		pluginCommand: string;
		pluginParams: Record<string, unknown>;
		pythonFallback: () => Promise<string>;
	}): Promise<string> {
		if (this.hasPlugin && this.plugin.hasCapability(options.pluginCommand)) {
			try {
				const response = await this.plugin.sendCommand({
					command: options.pluginCommand,
					params: options.pluginParams,
				});
				if (response.success) {
					return typeof response.data === "string"
						? response.data
						: JSON.stringify(response.data, null, 2);
				}
				// Plugin returned an error — fall through to Python
				console.error(
					`[unreal-mcp] Plugin command ${options.pluginCommand} failed: ${response.error}, falling back to Python`,
				);
			} catch (error) {
				console.error(
					`[unreal-mcp] Plugin command ${options.pluginCommand} error: ${error}, falling back to Python`,
				);
			}
		}

		return options.pythonFallback();
	}

	async shutdown(): Promise<void> {
		await Promise.all([this.python.disconnect(), this.plugin.disconnect()]);
	}
}
