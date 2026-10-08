import { describe, expect, it } from "vitest"
import { DefaultToolHandlerState } from "../tools/state/ToolHandlerState"

describe("task operation cancellation reset", () => {
	it("cancels the current continuation through its AbortSignal", () => {
		const state = new DefaultToolHandlerState()

		state.cancelOperations("test_pause")

		expect(state.operationSignal.aborted).toBe(true)
		expect(state.operationSignal.reason).toEqual(new Error("test_pause"))
	})

	it("opens a fresh cancellation scope before a resumed continuation", () => {
		const state = new DefaultToolHandlerState()
		state.cancelOperations("test_pause")
		const cancelledSignal = state.operationSignal

		state.resetOperationCancellation()

		expect(cancelledSignal.aborted).toBe(true)
		expect(state.operationSignal).not.toBe(cancelledSignal)
		expect(state.operationSignal.aborted).toBe(false)
	})

	it("keeps the live scope stable when no cancellation occurred", () => {
		const state = new DefaultToolHandlerState()
		const activeSignal = state.operationSignal

		state.resetOperationCancellation()

		expect(state.operationSignal).toBe(activeSignal)
		expect(state.operationSignal.aborted).toBe(false)
	})
})
