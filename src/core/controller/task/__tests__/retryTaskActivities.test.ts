import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { RetryTaskActivitiesRequest } from "@shared/proto/dline/task"
import { describe, expect, it, vi } from "vitest"
import { retryTaskActivities } from "../retryTaskActivities"

describe("retryTaskActivities", () => {
	it("restores a persisted retry control before retrying a reopened activity", async () => {
		let liveRetryControl = false
		const restoreSubagentActivityRetry = vi.fn(async () => {
			liveRetryControl = true
			return true
		})
		const retry = vi.fn(async (activityIds: string[]) => (liveRetryControl ? activityIds : []))
		const session = createSessionFixture({
			taskId: "task-1",
			owners: {
				activities: {
					hasLiveRetryControl: vi.fn(() => liveRetryControl),
					isRetryable: vi.fn(() => true),
					retry,
				},
				toolExecution: { restoreSubagentActivityRetry },
			},
		})
		const controller = { task: session }

		const response = await retryTaskActivities(
			controller as never,
			RetryTaskActivitiesRequest.create({ taskId: "task-1", activityIds: ["subagent-reopened"] }),
		)

		expect(response.retriedActivityIds).toEqual(["subagent-reopened"])
		expect(restoreSubagentActivityRetry).toHaveBeenCalledWith("subagent-reopened")
		expect(retry).toHaveBeenCalledWith(["subagent-reopened"])
		expect(restoreSubagentActivityRetry.mock.invocationCallOrder[0]).toBeLessThan(retry.mock.invocationCallOrder[0])
	})

	it("does not rebuild a retry control that is already live", async () => {
		const restoreSubagentActivityRetry = vi.fn(async () => true)
		const retry = vi.fn(async (activityIds: string[]) => activityIds)
		const session = createSessionFixture({
			taskId: "task-1",
			owners: {
				activities: {
					hasLiveRetryControl: vi.fn(() => true),
					isRetryable: vi.fn(() => true),
					retry,
				},
				toolExecution: { restoreSubagentActivityRetry },
			},
		})
		const controller = { task: session }

		const response = await retryTaskActivities(
			controller as never,
			RetryTaskActivitiesRequest.create({ taskId: "task-1", activityIds: ["subagent-live"] }),
		)

		expect(response.retriedActivityIds).toEqual(["subagent-live"])
		expect(restoreSubagentActivityRetry).not.toHaveBeenCalled()
	})
})
