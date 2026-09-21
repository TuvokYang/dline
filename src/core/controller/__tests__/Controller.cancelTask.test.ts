import { strict as assert } from "node:assert"
import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { describe, it, vi } from "vitest"
import { Controller } from "../index"

/**
 * Build a minimal Controller-like object for cancelTask behavior tests.
 *
 * @returns Fake controller and spies used by the test.
 */
function createCancelController(): {
	controller: Pick<Controller, "cancelTask">
	cancel: ReturnType<typeof vi.fn>
	updateBackgroundCommandState: ReturnType<typeof vi.fn>
} {
	const cancel = vi.fn(async () => ({ kind: "accepted" as const }))
	const updateBackgroundCommandState = vi.fn()
	const controller = {
		task: createSessionFixture({ taskId: "task-1", session: { task: { cancel } } }),
		cancelInProgress: false,
		updateBackgroundCommandState,
		cancelTask: Controller.prototype.cancelTask,
	}

	return {
		controller: controller as unknown as Pick<Controller, "cancelTask">,
		cancel,
		updateBackgroundCommandState,
	}
}

describe("Controller.cancelTask", () => {
	it("dispatches one cancellation transaction without reading task flags or messages", async () => {
		const { controller, cancel, updateBackgroundCommandState } = createCancelController()

		await controller.cancelTask()

		assert.equal(cancel.mock.calls.length, 1)
		// Cancellation carries its own halt identity rather than a task flag.
		assert.equal(typeof cancel.mock.calls[0][0], "string")
		assert.deepEqual(updateBackgroundCommandState.mock.calls, [[false]])
	})
})

describe("Controller account usage polling visibility", () => {
	it("stops polling while hidden and refreshes immediately when visible", () => {
		const startAccountUsagePolling = vi.fn()
		const stopAccountUsagePolling = vi.fn()
		const controller = {
			accountUsagePollingEnabled: true,
			startAccountUsagePolling,
			stopAccountUsagePolling,
		}

		Controller.prototype.setAccountUsagePollingEnabled.call(controller, false)
		assert.equal(controller.accountUsagePollingEnabled, false)
		assert.equal(stopAccountUsagePolling.mock.calls.length, 1)

		Controller.prototype.setAccountUsagePollingEnabled.call(controller, true)
		assert.equal(controller.accountUsagePollingEnabled, true)
		assert.equal(startAccountUsagePolling.mock.calls.length, 1)
	})
})
