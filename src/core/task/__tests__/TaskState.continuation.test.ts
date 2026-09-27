import { describe, expect, it } from "vitest"
import { TaskState } from "../TaskState"

describe("TaskState continuation lease", () => {
	it("keeps a cancelled continuation superseded after Resume clears the shared abort flag", () => {
		const state = new TaskState()
		const cancelled = state.captureContinuation()
		expect(cancelled.isSuperseded()).toBe(false)

		// Cancel aborts the continuation's operations and sets the task-wide flag.
		state.abort = true
		state.cancelOperations("task_cancelled")
		// Until Resume admits a new continuation, the ordinary abort paths own the loop.
		expect(cancelled.isSuperseded()).toBe(false)

		// Resume starts a fresh scope and clears the task-wide flag.
		state.resetOperationCancellation()
		state.abort = false
		const resumed = state.captureContinuation()

		expect(cancelled.isSuperseded()).toBe(true)
		expect(resumed.isSuperseded()).toBe(false)
	})

	it("stays superseded when the resumed continuation is cancelled as well", () => {
		const state = new TaskState()
		const first = state.captureContinuation()
		state.cancelOperations("task_cancelled")
		state.resetOperationCancellation()
		const second = state.captureContinuation()

		state.cancelOperations("task_cancelled")

		expect(first.isSuperseded()).toBe(true)
		expect(second.isSuperseded()).toBe(false)
	})

	it("does not supersede the running continuation when an uncancelled scope is reset", () => {
		const state = new TaskState()
		const current = state.captureContinuation()

		// Retry admission resets only an aborted scope; a live continuation keeps ownership.
		state.resetOperationCancellation()

		expect(current.isSuperseded()).toBe(false)
	})
})
