import { type RunningProcess, startProcess } from "../transports/subprocess.js";

/**
 * Long-running programs (a cook, a lighting build, a pak) outlast what an assistant can sit and wait
 * for. A job starts the program, keeps the tail of its output, and can be checked on, waited for
 * and cancelled later. Jobs keep running if the server stops.
 */

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface JobSnapshot {
	id: string;
	name: string;
	status: JobStatus;
	exitCode?: number;
	error?: string;
	startedAt: string;
	endedAt?: string;
	durationSeconds: number;
	/** Number of output lines seen so far (the tail below is only the last few). */
	outputLines: number;
	outputTail: string;
}

export interface JobSpec {
	name: string;
	command: string;
	args: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Stop the program after this long. */
	timeoutMs?: number;
}

interface Job {
	id: string;
	name: string;
	status: JobStatus;
	exitCode?: number;
	error?: string;
	startedAt: number;
	endedAt?: number;
	lines: string[];
	totalLines: number;
	partial: string;
	process?: RunningProcess;
	cancelled: boolean;
	timedOut: boolean;
	finished: Promise<void>;
}

const MAX_LINES = 5000;
const MAX_FINISHED_JOBS = 20;
const DEFAULT_TAIL_LINES = 60;

export class JobManager {
	private readonly jobs = new Map<string, Job>();
	private sequence = 0;

	/** Start a program. Returns the job id straight away, even when the program cannot start. */
	start(spec: JobSpec): string {
		const id = `job-${++this.sequence}`;
		let markFinished: () => void = () => {};
		const job: Job = {
			id,
			name: spec.name,
			status: "running",
			startedAt: Date.now(),
			lines: [],
			totalLines: 0,
			partial: "",
			cancelled: false,
			timedOut: false,
			finished: new Promise<void>((resolve) => {
				markFinished = resolve;
			}),
		};
		this.jobs.set(id, job);

		const finish = (status: JobStatus, exitCode?: number, error?: string) => {
			if (job.status !== "running") return;
			this.flushPartial(job);
			job.status = status;
			job.exitCode = exitCode;
			job.error = error;
			job.endedAt = Date.now();
			markFinished();
			this.prune();
		};

		try {
			job.process = startProcess(spec.command, spec.args, {
				cwd: spec.cwd,
				env: spec.env,
				onData: (chunk) => this.append(job, chunk),
			});
		} catch (error) {
			finish("failed", undefined, error instanceof Error ? error.message : String(error));
			return id;
		}

		let timer: NodeJS.Timeout | undefined;
		if (spec.timeoutMs) {
			timer = setTimeout(() => {
				job.timedOut = true;
				job.process?.kill();
			}, spec.timeoutMs);
		}

		job.process.done.then(
			(exitCode) => {
				if (timer) clearTimeout(timer);
				if (job.cancelled) finish("cancelled", exitCode);
				else if (job.timedOut) finish("timed_out", exitCode);
				else finish(exitCode === 0 ? "succeeded" : "failed", exitCode);
			},
			(error) => {
				if (timer) clearTimeout(timer);
				finish("failed", undefined, error instanceof Error ? error.message : String(error));
			},
		);
		return id;
	}

	get(id: string, tailLines = DEFAULT_TAIL_LINES): JobSnapshot | undefined {
		const job = this.jobs.get(id);
		return job ? this.snapshot(job, tailLines) : undefined;
	}

	list(): JobSnapshot[] {
		return [...this.jobs.values()].map((job) => this.snapshot(job, 0));
	}

	/** Stop a running job. Returns its state, or undefined for an unknown id. */
	cancel(id: string): JobSnapshot | undefined {
		const job = this.jobs.get(id);
		if (!job) return undefined;
		if (job.status === "running") {
			job.cancelled = true;
			job.process?.kill();
		}
		return this.snapshot(job, DEFAULT_TAIL_LINES);
	}

	/** Wait until the job ends or the time is up, whichever comes first. */
	async waitFor(
		id: string,
		maxMs: number,
		tailLines = DEFAULT_TAIL_LINES,
	): Promise<JobSnapshot | undefined> {
		const job = this.jobs.get(id);
		if (!job) return undefined;
		if (job.status === "running" && maxMs > 0) {
			let timer: NodeJS.Timeout | undefined;
			const timeout = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, maxMs);
			});
			await Promise.race([job.finished, timeout]);
			if (timer) clearTimeout(timer);
		}
		return this.snapshot(job, tailLines);
	}

	private snapshot(job: Job, tailLines: number): JobSnapshot {
		const end = job.endedAt ?? Date.now();
		const lines = job.partial ? [...job.lines, job.partial] : job.lines;
		return {
			id: job.id,
			name: job.name,
			status: job.status,
			exitCode: job.exitCode,
			error: job.error,
			startedAt: new Date(job.startedAt).toISOString(),
			endedAt: job.endedAt ? new Date(job.endedAt).toISOString() : undefined,
			durationSeconds: Math.round((end - job.startedAt) / 1000),
			outputLines: job.totalLines + (job.partial ? 1 : 0),
			outputTail: tailLines > 0 ? lines.slice(-tailLines).join("\n") : "",
		};
	}

	private append(job: Job, chunk: string): void {
		const parts = (job.partial + chunk).split("\n");
		job.partial = parts.pop() ?? "";
		for (const part of parts) this.pushLine(job, part);
	}

	private flushPartial(job: Job): void {
		if (job.partial) {
			this.pushLine(job, job.partial);
			job.partial = "";
		}
	}

	private pushLine(job: Job, raw: string): void {
		// A carriage return rewrites the line (progress bars), so only the last version is kept.
		const line = raw.replace(/\r+$/, "");
		const text = line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line;
		job.lines.push(text);
		job.totalLines++;
		if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
	}

	private prune(): void {
		const finished = [...this.jobs.values()].filter((job) => job.status !== "running");
		for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) {
			this.jobs.delete(job.id);
		}
	}
}

/** The jobs of this server process. */
export const jobs = new JobManager();
