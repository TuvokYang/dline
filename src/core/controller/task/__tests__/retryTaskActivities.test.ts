import { RetryTaskActivitiesRequest } from "@shared/proto/dline/task"
import { describe, expect, it, vi } from "vitest"
import { retryTaskActivities } from "../retryTaskActivities"

describe("retryTaskActivities", () => {
	it.each([false, "throws"])("records feedback when restoration returns %s", async (outcome) => {
		const setRetryUnavailableReason = vi.fn()
		const retry = vi.fn(async () => [])
		const controller = {
			task: {
				taskId: "task-1",
				taskInstanceId: "open-1",
				isReadOnly: () => false,
				activityStore: {
					hasLiveRetryControl: () => false,
					isRetryable: () => true,
					get: () => undefined,
					setRetryUnavailableReason,
					retry,
				},
				restoreSubagentActivityRetry: vi.fn(async () => {
					if (outcome === "throws") throw new Error("sensitive provider error")
					return false
				}),
			},
		}
		const response = await retryTaskActivities(
			controller as never,
			RetryTaskActivitiesRequest.create({
				taskId: "task-1",
				taskInstanceId: "open-1",
				activityIds: ["job"],
			}),
		)
		expect(response.retriedActivityIds).toEqual([])
		expect(setRetryUnavailableReason).toHaveBeenCalledWith("job", expect.stringContaining("could not be restored"))
		expect(JSON.stringify(setRetryUnavailableReason.mock.calls)).not.toContain("sensitive provider error")
	})

	it("preserves a specific unavailable reason and still retries other activities", async () => {
		const setRetryUnavailableReason = vi.fn()
		const retry = vi.fn(async () => ["live"])
		const controller = {
			task: {
				taskId: "task-1",
				taskInstanceId: "open-1",
				isReadOnly: () => false,
				activityStore: {
					hasLiveRetryControl: (id: string) => id === "live",
					isRetryable: () => true,
					get: () => ({ retryUnavailableReason: "Retry unavailable: Profile was removed." }),
					setRetryUnavailableReason,
					retry,
				},
				restoreSubagentActivityRetry: vi.fn(async () => false),
			},
		}
		const response = await retryTaskActivities(
			controller as never,
			RetryTaskActivitiesRequest.create({
				taskId: "task-1",
				taskInstanceId: "open-1",
				activityIds: ["missing", "live"],
			}),
		)
		expect(response.retriedActivityIds).toEqual(["live"])
		expect(setRetryUnavailableReason).toHaveBeenCalledWith("missing", "Retry unavailable: Profile was removed.")
	})

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
