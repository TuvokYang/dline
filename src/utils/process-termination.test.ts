import assert from "node:assert/strict"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import treeKill from "tree-kill"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import { terminateProcessTree } from "./process-termination"

vi.mock("tree-kill", () => ({ default: vi.fn() }))

const originalPlatform = process.platform

describe("terminateProcessTree", () => {
	beforeEach(() => {
		Object.defineProperty(process, "platform", { value: "linux" })
		vi.mocked(treeKill).mockReset()
	})

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform })
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("waits for forced process close before resolving", async () => {
		vi.useFakeTimers()
		const childProcess = new EventEmitter() as ChildProcess
		const callbacks: Array<(error?: Error) => void> = []
		const signals: string[] = []
		let completed = false
		vi.mocked(treeKill).mockImplementation((_pid, signal, callback) => {
			signals.push(String(signal ?? "SIGTERM"))
			if (callback) callbacks.push(callback)
		})

		let settled = false
		const termination = terminateProcessTree({
			pid: 1234,
			childProcess,
			isCompleted: () => completed,
			gracefulTimeoutMs: 100,
			forcefulTimeoutMs: 100,
		}).then(() => {
			settled = true
		})

		assert.deepEqual(signals, ["SIGTERM"])
		assert.equal(settled, false)
		callbacks.shift()?.()
		await Promise.resolve()
		await vi.advanceTimersByTimeAsync(100)
		assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
		assert.equal(settled, false)

		callbacks.shift()?.()
		await Promise.resolve()
		assert.equal(settled, false)
		completed = true
		childProcess.emit("close", null, "SIGKILL")
		await termination
		assert.equal(settled, true)
	})

	it("surfaces a process-tree kill failure while the child is still running", async () => {
		const childProcess = new EventEmitter() as ChildProcess
		vi.mocked(treeKill).mockImplementation((_pid, _signal, callback) => {
			callback?.(new Error("process-tree kill failed"))
		})

		await assert.rejects(
			terminateProcessTree({
				pid: 4321,
				childProcess,
				isCompleted: () => false,
			}),
			/Failed to send SIGTERM to process tree 4321/,
		)
	})

	it("terminates Windows descendants before their parent and waits for every PID to exit", async () => {
		Object.defineProperty(process, "platform", { value: "win32" })
		const childProcess = new EventEmitter() as ChildProcess
		const alive = new Set([100, 101, 102])
		const killOrder: number[] = []
		let completed = false
		vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (signal === 0) {
				if (alive.has(pid)) return true
				throw Object.assign(new Error("process not found"), { code: "ESRCH" })
			}
			assert.equal(signal, "SIGKILL")
			killOrder.push(pid)
			alive.delete(pid)
			if (pid === 100) {
				completed = true
				childProcess.emit("close", null, "SIGKILL")
			}
			return true
		})

		await terminateProcessTree({
			pid: 100,
			childProcess,
			isCompleted: () => completed,
			forcefulTimeoutMs: 100,
			windowsProcessTreeProvider: {
				getProcessList: async () => [
					{ pid: 100, ppid: 0, name: "powershell.exe" },
					{ pid: 101, ppid: 100, name: "node.exe" },
					{ pid: 102, ppid: 101, name: "worker.exe" },
				],
			},
		})

		assert.deepEqual(killOrder, [102, 101, 100])
		assert.equal(alive.size, 0)
	})

	it("fails explicitly when a Windows host has no process-tree provider", async () => {
		Object.defineProperty(process, "platform", { value: "win32" })
		await assert.rejects(
			terminateProcessTree({
				pid: 55,
				childProcess: new EventEmitter() as ChildProcess,
				isCompleted: () => false,
			}),
			/provider is not configured/,
		)
	})
})
