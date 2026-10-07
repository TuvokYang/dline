import assert from "node:assert/strict"
import { afterEach, describe, it, vi } from "vitest"

import { withRequiredTerminateTimeout, withTerminateTimeout } from "../TaskTerminateTimeout"

describe("withTerminateTimeout", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("clears the timeout when cleanup settles first", async () => {
		const clock = vi.useFakeTimers()
		const logger = { error: vi.fn(), warn: vi.fn() }

		const result = await withTerminateTimeout(Promise.resolve("ok"), 1_000, "fastCleanup", logger)
		clock.advanceTimersByTime(1_000)

		assert.equal(result, "ok")
		assert.equal(logger.warn.mock.calls.length, 0)
		assert.equal(logger.error.mock.calls.length, 0)
	})

	it("logs a timeout and returns undefined when cleanup does not settle in time", async () => {
		const clock = vi.useFakeTimers()
		const logger = { error: vi.fn(), warn: vi.fn() }
		const slowCleanup = new Promise<void>(() => {})

		const resultPromise = withTerminateTimeout(slowCleanup, 1_000, "slowCleanup", logger)
		clock.advanceTimersByTime(1_000)

		assert.equal(await resultPromise, undefined)
		assert.equal(logger.warn.mock.calls.length, 1)
		assert.equal(logger.warn.mock.calls[0][0], "[Terminate] slowCleanup timed out after 1000ms")
		assert.equal(logger.error.mock.calls.length, 0)
	})

	it("rejects a required cleanup timeout so lifecycle admission stays fenced", async () => {
		const clock = vi.useFakeTimers()
		const logger = { error: vi.fn(), warn: vi.fn() }
		const resultPromise = withRequiredTerminateTimeout(new Promise<void>(() => {}), 1_000, "metrics.close", logger)
		const rejection = assert.rejects(resultPromise, /metrics\.close timed out after 1000ms/)

		await clock.advanceTimersByTimeAsync(1_000)
		await rejection
		assert.equal(logger.warn.mock.calls.length, 1)
		assert.equal(logger.error.mock.calls.length, 0)
	})

	it("propagates a required cleanup failure", async () => {
		const failure = new Error("metrics close failed")
		const logger = { error: vi.fn(), warn: vi.fn() }

		await assert.rejects(withRequiredTerminateTimeout(Promise.reject(failure), 1_000, "metrics.close", logger), failure)
		assert.equal(logger.warn.mock.calls.length, 0)
		assert.equal(logger.error.mock.calls.length, 1)
	})
})
