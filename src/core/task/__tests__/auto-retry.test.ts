import { strict as assert } from "node:assert"
import { describe, it } from "vitest"
import {
	AUTO_RETRY_DELAYS_MS,
	getRetryDelay,
	getStreamRetryDecision,
	MAX_AUTO_RETRY_ATTEMPTS,
	runDelayedStreamRetry,
	waitRetryDelay,
} from "../auto-retry"

describe("auto retry recovery", () => {
	it("stops the delayed retry when the task is aborted", async () => {
		let aborted = false
		const delayPromise = waitRetryDelay(1, () => aborted)

		aborted = true
		const shouldRetry = await delayPromise

		assert.equal(shouldRetry, false)
	})

	it("does not dispatch delayed stream retry after active task changes", async () => {
		let dispatched = false
		let isCurrentTask = true
		const retryPromise = runDelayedStreamRetry({
			delay: 1,
			isAborted: () => false,
			isCurrentTask: () => isCurrentTask,
			dispatchRetry: async () => {
				dispatched = true
			},
		})

		isCurrentTask = false
		const didDispatch = await retryPromise

		assert.equal(didDispatch, false)
		assert.equal(dispatched, false)
	})

	it("schedules every attempt on the declared backoff", () => {
		assert.equal(MAX_AUTO_RETRY_ATTEMPTS, 5)
		assert.deepEqual(
			Array.from({ length: MAX_AUTO_RETRY_ATTEMPTS }, (_unused, index) => getRetryDelay(index + 1)),
			[3_000, 5_000, 7_000, 15_000, 30_000],
		)
	})

	it("clamps attempts outside the schedule to its bounds", () => {
		assert.equal(getRetryDelay(0), AUTO_RETRY_DELAYS_MS[0])
		assert.equal(getRetryDelay(MAX_AUTO_RETRY_ATTEMPTS + 3), AUTO_RETRY_DELAYS_MS[MAX_AUTO_RETRY_ATTEMPTS - 1])
	})

	it("keeps retrying until the declared attempt budget is spent", () => {
		const decision = getStreamRetryDecision({
			isSpendLimitError: false,
			autoRetryAttempts: MAX_AUTO_RETRY_ATTEMPTS - 1,
		})

		assert.equal(decision.shouldRetry, true)
		assert.equal(decision.shouldPrompt, false)
	})

	it("prompts api failure recovery after stream retries are exhausted", () => {
		const decision = getStreamRetryDecision({
			isSpendLimitError: false,
			autoRetryAttempts: MAX_AUTO_RETRY_ATTEMPTS,
		})

		assert.equal(decision.shouldPrompt, true)
		assert.equal(decision.shouldRetry, false)
	})

	it("does not prompt retry recovery for spend limit streaming failures", () => {
		const decision = getStreamRetryDecision({
			isSpendLimitError: true,
			autoRetryAttempts: MAX_AUTO_RETRY_ATTEMPTS,
		})

		assert.equal(decision.shouldPrompt, false)
		assert.equal(decision.shouldRetry, false)
	})
})
