import { describe, expect, it } from "vitest";
import { JobManager } from "../src/utils/jobs.js";

const node = (code: string) => ({ command: process.execPath, args: ["-e", code] });

describe("JobManager", () => {
	it("runs a program and keeps its output", async () => {
		const jobs = new JobManager();
		const id = jobs.start({ name: "hello", ...node("console.log('one'); console.log('two')") });
		const done = await jobs.waitFor(id, 10_000);
		expect(done).toMatchObject({ id, name: "hello", status: "succeeded", exitCode: 0 });
		expect(done?.outputTail).toBe("one\ntwo");
		expect(done?.outputLines).toBe(2);
		expect(done?.endedAt).toBeDefined();
	});

	it("reports a failing program with its exit code", async () => {
		const jobs = new JobManager();
		const id = jobs.start({ name: "fail", ...node("console.error('nope'); process.exit(7)") });
		const done = await jobs.waitFor(id, 10_000);
		expect(done).toMatchObject({ status: "failed", exitCode: 7 });
		expect(done?.outputTail).toContain("nope");
	});

	it("reports a program that cannot start", async () => {
		const jobs = new JobManager();
		const id = jobs.start({ name: "missing", command: "no-such-program-here", args: [] });
		const done = await jobs.waitFor(id, 10_000);
		expect(done?.status).toBe("failed");
		expect(done?.error).toMatch(/spawn/i);
	});

	it("returns early with a running job when the wait is over", async () => {
		const jobs = new JobManager();
		const id = jobs.start({
			name: "slow",
			...node("console.log('started'); setTimeout(() => console.log('finished'), 600)"),
		});
		const early = await jobs.waitFor(id, 150);
		expect(early?.status).toBe("running");
		expect(early?.endedAt).toBeUndefined();
		const done = await jobs.waitFor(id, 10_000);
		expect(done?.status).toBe("succeeded");
		expect(done?.outputTail).toContain("finished");
	});

	it("cancels a running job", async () => {
		const jobs = new JobManager();
		const id = jobs.start({ name: "hang", ...node("setInterval(() => {}, 1000)") });
		await jobs.waitFor(id, 100);
		jobs.cancel(id);
		const done = await jobs.waitFor(id, 10_000);
		expect(done?.status).toBe("cancelled");
	});

	it("stops a job that runs past its time limit", async () => {
		const jobs = new JobManager();
		const id = jobs.start({
			name: "limit",
			...node("setInterval(() => {}, 1000)"),
			timeoutMs: 200,
		});
		const done = await jobs.waitFor(id, 10_000);
		expect(done?.status).toBe("timed_out");
	});

	it("keeps the last version of a line that is rewritten with a carriage return", async () => {
		const jobs = new JobManager();
		const id = jobs.start({
			name: "progress",
			...node("process.stdout.write('10%\\r50%\\r100%\\ndone\\n')"),
		});
		const done = await jobs.waitFor(id, 10_000);
		expect(done?.outputTail).toBe("100%\ndone");
	});

	it("keeps the end of very long output and counts every line", async () => {
		const jobs = new JobManager();
		const id = jobs.start({
			name: "flood",
			...node("for (let i = 1; i <= 7000; i++) console.log('line ' + i)"),
		});
		const done = await jobs.waitFor(id, 30_000, 3);
		expect(done?.outputLines).toBe(7000);
		expect(done?.outputTail).toBe("line 6998\nline 6999\nline 7000");
	});

	it("shows output that has no trailing newline yet", async () => {
		const jobs = new JobManager();
		const id = jobs.start({
			name: "prompt",
			...node("process.stdout.write('waiting for'); setInterval(() => {}, 1000)"),
		});
		await jobs.waitFor(id, 400);
		expect(jobs.get(id)?.outputTail).toBe("waiting for");
		jobs.cancel(id);
		await jobs.waitFor(id, 10_000);
	});

	it("forgets old finished jobs but never a running one", async () => {
		const jobs = new JobManager();
		const running = jobs.start({ name: "keep", ...node("setInterval(() => {}, 1000)") });
		const ids: string[] = [];
		for (let i = 0; i < 25; i++) ids.push(jobs.start({ name: `quick ${i}`, ...node("0") }));
		await Promise.all(ids.map((id) => jobs.waitFor(id, 20_000)));
		const listed = jobs.list();
		expect(listed.length).toBeLessThanOrEqual(21);
		expect(listed.some((job) => job.id === running)).toBe(true);
		expect(jobs.get(ids[0])).toBeUndefined();
		expect(jobs.get(ids[24])?.status).toBe("succeeded");
		jobs.cancel(running);
		await jobs.waitFor(running, 10_000);
	});

	it("answers for an unknown job", async () => {
		const jobs = new JobManager();
		expect(jobs.get("job-99")).toBeUndefined();
		expect(jobs.cancel("job-99")).toBeUndefined();
		expect(await jobs.waitFor("job-99", 10)).toBeUndefined();
	});
});
