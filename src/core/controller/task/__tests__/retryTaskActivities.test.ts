import { RetryTaskActivitiesRequest } from "@shared/proto/dline/task"
import { describe, expect, it, vi } from "vitest"
import { retryTaskActivities } from "../retryTaskActivities"

describe("retryTaskActivities", () => {
	it("restores a persisted retry control before retrying a reopened activity", async () => {
		let liveRetryControl = false
		const hasLiveRetryControl = vi.fn(() => liveRetryControl)
		const isRetryable = vi.fn(() => true)
		const restoreSubagentActivityRetry = vi.fn(async () => {
			liveRetryControl = true
			return true
		})
		const retry = vi.fn(async (activityIds: string[]) => (liveRetryControl ? activityIds : []))
		const controller = {
			task: {
				taskId: "task-1",
				taskInstanceId: "open-1",
				isReadOnly: () => false,
				activityStore: { hasLiveRetryControl, isRetryable, retry },
				restoreSubagentActivityRetry,
			},
		}

		const response = await retryTaskActivities(
			controller as never,
			RetryTaskActivitiesRequest.create({ taskId: "task-1", taskInstanceId: "open-1", activityIds: ["subagent-reopened"] }),
		)

		expect(response.retriedActivityIds).toEqual(["subagent-reopened"])
		expect(restoreSubagentActivityRetry).toHaveBeenCalledWith("subagent-reopened")
		expect(retry).toHaveBeenCalledWith(["subagent-reopened"])
		expect(restoreSubagentActivityRetry.mock.invocationCallOrder[0]).toBeLessThan(retry.mock.invocationCallOrder[0])
	})

	it("does not rebuild a retry control that is already live", async () => {
		const restoreSubagentActivityRetry = vi.fn(async () => true)
		const retry = vi.fn(async (activityIds: string[]) => activityIds)
		const controller = {
			task: {
				taskId: "task-1",
				taskInstanceId: "open-1",
				isReadOnly: () => false,
				activityStore: {
					hasLiveRetryControl: vi.fn(() => true),
					isRetryable: vi.fn(() => true),
					retry,
				},
				restoreSubagentActivityRetry,
			},
		}

		const response = await retryTaskActivities(
			controller as never,
			RetryTaskActivitiesRequest.create({ taskId: "task-1", taskInstanceId: "open-1", activityIds: ["subagent-live"] }),
		)

		expect(response.retriedActivityIds).toEqual(["subagent-live"])
		expect(restoreSubagentActivityRetry).not.toHaveBeenCalled()
	})

	it("does not retry when a same-ID replacement opens during retry restoration", async () => {
		let release!: () => void
		const retry = vi.fn(async (activityIds: string[]) => activityIds)
		const task = {
			taskId: "task-1",
			taskInstanceId: "open-1",
			isReadOnly: () => false,
			activityStore: { hasLiveRetryControl: () => false, isRetryable: () => true, retry },
			restoreSubagentActivityRetry: vi.fn(
				() =>
					new Promise<boolean>((resolve) => {
						release = () => resolve(true)
					}),
			),
		}
		const controller = { task }
		const pending = retryTaskActivities(
			controller as never,
			RetryTaskActivitiesRequest.create({
				taskId: "task-1",
				taskInstanceId: "open-1",
				activityIds: ["job"],
			}),
		)
		controller.task = { ...task, taskInstanceId: "open-2" }
		release()
		await expect(pending).resolves.toMatchObject({ retriedActivityIds: [] })
		expect(retry).not.toHaveBeenCalled()
	})
})
