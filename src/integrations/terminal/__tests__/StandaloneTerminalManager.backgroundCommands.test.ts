import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import os from "node:os"
import * as path from "node:path"
import { DlineRuntimeFileManager } from "@services/runtime-files"
import { afterEach, describe, it, vi } from "vitest"
import { StandaloneTerminalManager } from "../standalone/StandaloneTerminalManager"
import type { BackgroundCommand, TerminalProcessResultPromise } from "../types"

/**
 * Create a background command record for state transition tests.
 * @param id Command identifier.
 * @returns Background command record with pending injection state.
 */
function createCommand(id: string): BackgroundCommand {
	return {
		id,
		command: "npm test",
		startTime: Date.now(),
		status: "completed",
		origin: "explicit_background",
		cancellationOwner: "explicit",
		logFilePath: "logs/command.log",
		lineCount: 1,
		injectionState: "pending",
		process: {} as TerminalProcessResultPromise,
	}
}

describe("StandaloneTerminalManager background command injection state", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("uses the original command deadline instead of restarting a fixed timeout at handoff", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(10_000)
		const manager = new StandaloneTerminalManager()
		const terminate = vi.fn()
		const process = Object.assign(new EventEmitter(), { terminate }) as unknown as TerminalProcessResultPromise

		try {
			const command = manager.trackBackgroundCommand(process, "npm test", "command_deadline", [], {
				origin: "foreground",
				cancellationOwner: "task",
				startedAt: 0,
				deadlineAt: 60_000,
			})

			await vi.advanceTimersByTimeAsync(49_999)
			assert.equal(command.status, "running")
			assert.equal(terminate.mock.calls.length, 0)

			await vi.advanceTimersByTimeAsync(1)
			assert.equal(command.status, "timed_out")
			assert.equal(terminate.mock.calls.length, 1)
		} finally {
			await manager.disposeBackgroundCommands()
		}
	})

	it("creates the activity-owned log when background tracking starts", async () => {
		const manager = new StandaloneTerminalManager()
		const process = new EventEmitter() as TerminalProcessResultPromise
		let logFilePath: string | undefined
		const expectedLogPath = path.join(DlineRuntimeFileManager.getTempDir(), "command_100_1.log")
		await fs.rm(expectedLogPath, { force: true })

		try {
			const command = manager.trackBackgroundCommand(process, "npm test", "command_100_1", [], undefined, {
				onLogFileCreated: (createdPath) => {
					logFilePath = createdPath
				},
			})

			assert.equal(path.basename(command.logFilePath ?? ""), "command_100_1.log")
			assert.equal(logFilePath, command.logFilePath)
			process.emit("line", "one", "stdout")
			process.emit("line", "two", "stderr")
			process.emit("line", "three", "stdout")
			process.emit("completed", { exitCode: 0, signal: null })

			assert.equal(await manager.readBackgroundCommandOutput(command.id), "[O] one\n[E] two\n[O] three\n")
		} finally {
			await manager.disposeBackgroundCommands()
			await fs.rm(expectedLogPath, { force: true })
		}
	})

	it("writes the owned log into the task temp storage when a task owns the command", async () => {
		const documentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-background-log-docs-"))
		vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
		const manager = new StandaloneTerminalManager()
		const process = new EventEmitter() as TerminalProcessResultPromise

		try {
			const command = manager.trackBackgroundCommand(process, "npm test", "command_task_owned", [], {
				origin: "explicit_background",
				cancellationOwner: "explicit",
				taskId: "task-owning-log",
			})

			assert.equal(
				command.logFilePath,
				path.join(documentsRoot, "tasks", "task-owning-log", "tmp", "command-logs", "command_task_owned.log"),
			)

			process.emit("line", "one", "stdout")
			process.emit("completed", { exitCode: 0, signal: null })

			assert.equal(await manager.readBackgroundCommandOutput(command.id), "[O] one\n")
		} finally {
			await manager.disposeBackgroundCommands()
			vi.unstubAllEnvs()
			await fs.rm(documentsRoot, { recursive: true, force: true })
		}
	})

	it("publishes one output frame and drains it before completion closes the log", async () => {
		const manager = new StandaloneTerminalManager()
		const process = new EventEmitter() as TerminalProcessResultPromise
		const onOutputFrame = vi.fn()
		const expectedLogPath = path.join(DlineRuntimeFileManager.getTempDir(), "command_frame_completion.log")
		await fs.rm(expectedLogPath, { force: true })

		try {
			const command = manager.trackBackgroundCommand(process, "npm test", "command_frame_completion", [], undefined, {
				onOutputFrame,
			})
			process.emit("line", "one", "stdout")
			process.emit("line", "two", "stderr")
			process.emit("line", "three", "stdout")
			process.emit("completed", { exitCode: 0, signal: null })

			await manager.readBackgroundCommandOutput(command.id)
			assert.equal(onOutputFrame.mock.calls.length, 1)
			assert.deepEqual(onOutputFrame.mock.calls[0][0], [
				{ line: "one", stream: "stdout" },
				{ line: "two", stream: "stderr" },
				{ line: "three", stream: "stdout" },
			])
		} finally {
			await manager.disposeBackgroundCommands()
			await fs.rm(expectedLogPath, { force: true })
		}
	})

	it("drains pending output before cancellation closes the log", async () => {
		const manager = new StandaloneTerminalManager()
		const terminate = vi.fn()
		const process = Object.assign(new EventEmitter(), { terminate }) as unknown as TerminalProcessResultPromise
		const expectedLogPath = path.join(DlineRuntimeFileManager.getTempDir(), "command_frame_cancel.log")
		await fs.rm(expectedLogPath, { force: true })

		try {
			const command = manager.trackBackgroundCommand(process, "npm test", "command_frame_cancel")
			process.emit("line", "tail", "stdout")
			assert.equal(await manager.cancelBackgroundCommand(command.id), true)

			assert.equal(
				await manager.readBackgroundCommandOutput(command.id),
				"[O] tail\n\n[CANCELLED] Command cancelled by user\n",
			)
			assert.equal(terminate.mock.calls.length, 1)
		} finally {
			await manager.disposeBackgroundCommands()
			await fs.rm(expectedLogPath, { force: true })
		}
	})

	it("waits for asynchronous process termination before reporting cancellation complete", async () => {
		const manager = new StandaloneTerminalManager()
		let resolveTermination: (() => void) | undefined
		const terminate = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveTermination = resolve
				}),
		)
		const process = Object.assign(new EventEmitter(), { terminate }) as unknown as TerminalProcessResultPromise
		const expectedLogPath = path.join(DlineRuntimeFileManager.getTempDir(), "command_async_cancel.log")
		await fs.rm(expectedLogPath, { force: true })

		try {
			const command = manager.trackBackgroundCommand(process, "npm test", "command_async_cancel")
			let cancellationSettled = false
			const cancellation = manager.cancelBackgroundCommand(command.id).then((result) => {
				cancellationSettled = true
				return result
			})

			await vi.waitFor(() => assert.equal(terminate.mock.calls.length, 1))
			assert.equal(command.status, "cancelled")
			assert.equal(cancellationSettled, false)

			resolveTermination?.()
			assert.equal(await cancellation, true)
			assert.equal(cancellationSettled, true)
		} finally {
			resolveTermination?.()
			await manager.disposeBackgroundCommands()
			await fs.rm(expectedLogPath, { force: true })
		}
	})

	it("admits and drains tail output emitted while cancellation waits for process close", async () => {
		const manager = new StandaloneTerminalManager()
		const emitter = new EventEmitter()
		const terminate = vi.fn(async () => {
			await Promise.resolve()
			emitter.emit("line", "termination tail", "stdout")
			emitter.emit("completed", { exitCode: null, signal: "SIGTERM" })
		})
		const process = Object.assign(emitter, { terminate }) as unknown as TerminalProcessResultPromise
		const expectedLogPath = path.join(DlineRuntimeFileManager.getTempDir(), "command_cancel_close_tail.log")
		await fs.rm(expectedLogPath, { force: true })

		try {
			const command = manager.trackBackgroundCommand(process, "npm test", "command_cancel_close_tail")
			process.emit("line", "before cancel", "stdout")

			assert.equal(await manager.cancelBackgroundCommand(command.id), true)

			assert.equal(command.status, "cancelled")
			assert.equal(command.lineCount, 2)
			assert.equal(
				await manager.readBackgroundCommandOutput(command.id),
				"[O] before cancel\n[O] termination tail\n\n[CANCELLED] Command cancelled by user\n",
			)
			assert.equal(terminate.mock.calls.length, 1)
		} finally {
			await manager.disposeBackgroundCommands()
			await fs.rm(expectedLogPath, { force: true })
		}
	})

	it("drains pending output before timeout closes the log", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(20_000)
		const manager = new StandaloneTerminalManager()
		const terminate = vi.fn()
		const process = Object.assign(new EventEmitter(), { terminate }) as unknown as TerminalProcessResultPromise
		const expectedLogPath = path.join(DlineRuntimeFileManager.getTempDir(), "command_frame_timeout.log")
		await fs.rm(expectedLogPath, { force: true })

		try {
			const command = manager.trackBackgroundCommand(process, "npm test", "command_frame_timeout", [], {
				origin: "foreground",
				cancellationOwner: "task",
				deadlineAt: 20_020,
			})
			process.emit("line", "tail", "stderr")
			await vi.advanceTimersByTimeAsync(20)

			assert.equal(
				await manager.readBackgroundCommandOutput(command.id),
				"[E] tail\n\n[TIMEOUT] Process reached its command deadline\n",
			)
			assert.equal(terminate.mock.calls.length, 1)
		} finally {
			await manager.disposeBackgroundCommands()
			await fs.rm(expectedLogPath, { force: true })
		}
	})

	it("drains pending output when the background process emits an error", async () => {
		const manager = new StandaloneTerminalManager()
		const process = new EventEmitter() as TerminalProcessResultPromise
		const expectedLogPath = path.join(DlineRuntimeFileManager.getTempDir(), "command_frame_error.log")
		await fs.rm(expectedLogPath, { force: true })

		try {
			const command = manager.trackBackgroundCommand(process, "npm test", "command_frame_error")
			process.emit("line", "tail", "stderr")
			process.emit("error", new Error("exit code 9"))

			assert.equal(await manager.readBackgroundCommandOutput(command.id), "[E] tail\n")
			assert.equal(command.status, "error")
			assert.equal(command.exitCode, 9)
		} finally {
			await manager.disposeBackgroundCommands()
			await fs.rm(expectedLogPath, { force: true })
		}
	})

	it("persists small completed background output to its activity-owned log", async () => {
		const manager = new StandaloneTerminalManager()
		const process = new EventEmitter() as TerminalProcessResultPromise
		const expectedLogPath = path.join(DlineRuntimeFileManager.getTempDir(), "command_100_small.log")
		await fs.rm(expectedLogPath, { force: true })

		try {
			const command = manager.trackBackgroundCommand(process, "npm test", "command_100_small")
			process.emit("line", "small output", "stdout")
			process.emit("completed", { exitCode: 0, signal: null })

			assert.equal(command.logFilePath, expectedLogPath)
			assert.equal(await manager.readBackgroundCommandOutput(command.id), "[O] small output\n")
		} finally {
			await manager.disposeBackgroundCommands()
			await fs.rm(expectedLogPath, { force: true })
		}
	})

	it("classifies a background completion without an exit code as an error", async () => {
		const manager = new StandaloneTerminalManager()
		const process = new EventEmitter() as TerminalProcessResultPromise

		try {
			const command = manager.trackBackgroundCommand(process, "npm test", "command_100_2")
			process.emit("completed", { exitCode: undefined, signal: null })

			assert.equal(command.status, "error")
		} finally {
			await manager.disposeBackgroundCommands()
		}
	})

	it("moves background command injection state forward only", () => {
		const manager = new StandaloneTerminalManager()
		const managerState = manager as unknown as { backgroundCommands: Map<string, BackgroundCommand> }
		const command = createCommand("command_1")
		managerState.backgroundCommands.set(command.id, command)

		manager.markBackgroundCommandsConsumed([command.id])
		assert.equal(manager.getBackgroundCommand(command.id)?.injectionState, "pending")

		manager.markBackgroundCommandsInjected([command.id])
		assert.equal(manager.getBackgroundCommand(command.id)?.injectionState, "injected")

		manager.markBackgroundCommandsConsumed([command.id])
		assert.equal(manager.getBackgroundCommand(command.id)?.injectionState, "consumed")

		manager.markBackgroundCommandsInjected([command.id])
		assert.equal(manager.getBackgroundCommand(command.id)?.injectionState, "consumed")
	})

	it("retains the function id and advances the API output baseline to the sent snapshot", async () => {
		const manager = new StandaloneTerminalManager()
		const process = new EventEmitter() as TerminalProcessResultPromise

		try {
			const command = manager.trackBackgroundCommand(process, "npm test", "command_output_delta", [], {
				origin: "explicit_background",
				cancellationOwner: "explicit",
				functionId: "call_output_delta",
			})
			process.emit("line", "one", "stdout")
			process.emit("line", "two", "stdout")

			assert.equal(command.functionId, "call_output_delta")
			assert.equal(command.lastApiSentLineCount, 0)
			manager.markBackgroundCommandOutputSent([{ id: command.id, lineCount: 2 }])
			assert.equal(command.lastApiSentLineCount, 2)

			process.emit("line", "three", "stdout")
			manager.markBackgroundCommandOutputSent([{ id: command.id, lineCount: 1 }])
			assert.equal(command.lastApiSentLineCount, 2)
			assert.equal(command.lineCount - command.lastApiSentLineCount, 1)
		} finally {
			await manager.disposeBackgroundCommands()
		}
	})
})
