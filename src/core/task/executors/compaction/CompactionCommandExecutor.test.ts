import { Logger } from "@shared/services/Logger"
import { describe, expect, it, vi } from "vitest"
import type { CompactionRunCommand, TaskEvent } from "../../kernel"
import { CompactionCommandExecutor, CompactionRunFailedError } from "./CompactionCommandExecutor"

function command(attempt = "attempt-1", contextRef = "manual:ctx"): CompactionRunCommand {
	return {
		commandId: `compaction:${attempt}`,
		originRevision: 1,
		generation: 0,
		type: "compaction.run",
		compactionId: "compact-1",
		attempt,
		contextRef,
	}
}

function recorder() {
	const events: TaskEvent[] = []
	return {
		events,
		sink: {
			submit: vi.fn(async (event: TaskEvent) => {
				events.push(event)
				return { kind: "accepted" as const }
			}),
		},
	}
}

describe("CompactionCommandExecutor", () => {
	it.each([
		"auto:ctx",
		"manual:ctx",
		"mode:ctx",
		"profile:ctx",
	])("passes opaque %s context to the injected port", async (contextRef) => {
		const recorded = recorder()
		const run = vi.fn(async () => ({ resultRef: "summary:1" }))
		await new CompactionCommandExecutor({ run }, recorded.sink).execute(command("attempt-1", contextRef))
		expect(run).toHaveBeenCalledWith(expect.objectContaining({ contextRef, signal: expect.any(AbortSignal) }))
		expect(recorded.events.map((event) => event.type)).toEqual(["compaction.started", "compaction.completed"])
	})

	it("does not execute the port when compaction.started is rejected and releases ownership", async () => {
		const run = vi.fn(async () => ({ resultRef: "summary:1" }))
		let rejectStarted = true
		const sink = {
			submit: vi.fn(async () => {
				if (rejectStarted) return { kind: "rejected" as const }
				return { kind: "accepted" as const }
			}),
		}
		const executor = new CompactionCommandExecutor({ run }, sink)
		await executor.execute(command())
		expect(run).not.toHaveBeenCalled()
		rejectStarted = false
		await executor.execute(command())
		expect(run).toHaveBeenCalledTimes(1)
	})

	it("emits sanitized failure feedback", async () => {
		const recorded = recorder()
		const executor = new CompactionCommandExecutor(
			{ run: vi.fn(async () => Promise.reject(new Error("secret-context"))) },
			recorded.sink,
		)
		await executor.execute(command())
		expect(recorded.events).toEqual([
			expect.objectContaining({ type: "compaction.started", attempt: "attempt-1" }),
			expect.objectContaining({ type: "compaction.failed", message: "compaction execution failed (Error)" }),
		])
		expect(JSON.stringify(recorded.events)).not.toContain("secret-context")
	})

	it("records a run failure its port already presented as a warning, not an error", async () => {
		const error = vi.spyOn(Logger, "error").mockImplementation(() => undefined)
		const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
		try {
			const recorded = recorder()
			const executor = new CompactionCommandExecutor(
				{ run: vi.fn(async () => Promise.reject(new CompactionRunFailedError("Provider rejected the Pass"))) },
				recorded.sink,
			)
			await executor.execute(command())
			expect(recorded.events).toEqual([
				expect.objectContaining({ type: "compaction.started" }),
				expect.objectContaining({
					type: "compaction.failed",
					message: "compaction execution failed (CompactionRunFailed)",
				}),
			])
			expect(error).not.toHaveBeenCalled()
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("Provider rejected the Pass"))
		} finally {
			error.mockRestore()
			warn.mockRestore()
		}
	})

	it("rejects a concurrent replacement and leaves attempt ownership to the kernel", async () => {
		const recorded = recorder()
		let started!: () => void
		const ready = new Promise<void>((resolve) => (started = resolve))
		const executor = new CompactionCommandExecutor(
			{
				run: async ({ signal }) => {
					started()
					await new Promise<void>((_resolve, reject) =>
						signal.addEventListener(
							"abort",
							() => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
							{ once: true },
						),
					)
					return { resultRef: "unreachable" }
				},
			},
			recorded.sink,
		)
		const first = executor.execute(command("attempt-1"))
		await ready
		await expect(executor.execute(command("attempt-2"))).rejects.toThrow("already active")
		executor.cancel("compact-1")
		await first
	})

	it("emits expired feedback and fences late projection when the active attempt is cancelled", async () => {
		const recorded = recorder()
		const projection = vi.fn()
		let started!: () => void
		let latePublish!: (value: Readonly<Record<string, unknown>>) => void
		const ready = new Promise<void>((resolve) => (started = resolve))
		const executor = new CompactionCommandExecutor(
			{
				run: async ({ signal, publish }) => {
					latePublish = publish
					started()
					await new Promise<void>((_resolve, reject) =>
						signal.addEventListener(
							"abort",
							() => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })),
							{ once: true },
						),
					)
					return { resultRef: "unreachable" }
				},
			},
			recorded.sink,
			projection,
		)
		const execution = executor.execute(command())
		await ready
		expect(executor.cancel("compact-1")).toBe(true)
		await execution
		latePublish({ text: "late" })
		expect(projection).not.toHaveBeenCalled()
		expect(recorded.events.at(-1)).toMatchObject({ type: "compaction.expired", attempt: "attempt-1" })
	})
})
