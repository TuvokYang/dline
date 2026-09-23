import { TaskActivitySubscriptionRequest, TaskActivityUpdate } from "@shared/proto/dline/task"
import { describe, expect, it, vi } from "vitest"
import { TaskActivityStore } from "../../../task/activity/TaskActivityStore"
import { getRequestRegistry } from "../../grpc-handler"
import { subscribeToTaskActivities } from "../subscribeToTaskActivities"

describe("subscribeToTaskActivities", () => {
	it("ends the stream when the controller has no current task", async () => {
		const responseStream = vi.fn(async () => undefined)
		const requestId = "activity-no-current-task"

		await subscribeToTaskActivities(
			{ task: undefined, getCurrentTaskActivityStore: () => undefined } as never,
			TaskActivitySubscriptionRequest.create({ taskId: "task-1" }),
			responseStream,
			requestId,
		)

		expect(responseStream).toHaveBeenCalledOnce()
		expect(responseStream).toHaveBeenCalledWith(
			expect.objectContaining({ sequence: 0, snapshot: true, activities: [] }),
			true,
		)
		expect(getRequestRegistry().hasRequest(requestId)).toBe(false)
	})

	it("ends the stream when the controller is bound to a different task", async () => {
		const responseStream = vi.fn(async () => undefined)
		const requestId = "activity-different-current-task"
		const activityStore = new TaskActivityStore("task-2")

		await subscribeToTaskActivities(
			{ task: { taskId: "task-2", activityStore }, getCurrentTaskActivityStore: () => undefined } as never,
			TaskActivitySubscriptionRequest.create({ taskId: "task-1" }),
			responseStream,
			requestId,
		)

		expect(responseStream).toHaveBeenCalledOnce()
		expect(responseStream).toHaveBeenCalledWith(
			expect.objectContaining({ sequence: 0, snapshot: true, activities: [] }),
			true,
		)
		expect(getRequestRegistry().hasRequest(requestId)).toBe(false)
	})

	it("streams the current lightweight history activity surface", async () => {
		const activityStore = new TaskActivityStore("task-1")
		activityStore.create({
			activityId: "history-subagent",
			kind: "subagent",
			executionMode: "foreground",
			title: "history review",
		})
		activityStore.update("history-subagent", { metrics: { toolCalls: 4, inputTokens: 40, outputTokens: 8 } })
		const responseStream = vi.fn(async () => undefined)

		await subscribeToTaskActivities(
			{
				task: undefined,
				getCurrentTaskActivityStore: () => activityStore,
			} as never,
			TaskActivitySubscriptionRequest.create({ taskId: "task-1" }),
			responseStream,
		)
		await vi.waitFor(() => expect(responseStream).toHaveBeenCalledOnce())

		expect(responseStream).toHaveBeenCalledWith(
			expect.objectContaining({
				snapshot: true,
				activities: [
					expect.objectContaining({
						activityId: "history-subagent",
						metrics: expect.objectContaining({ toolCalls: 4, inputTokens: 40, outputTokens: 8 }),
					}),
				],
			}),
			false,
			expect.any(Number),
		)
	})

	it("ends and unregisters an activity stream when its owning surface is disposed", async () => {
		const activityStore = new TaskActivityStore("task-1")
		const responseStream = vi.fn(async () => undefined)
		const requestId = "activity-surface-disposed"

		await subscribeToTaskActivities(
			{ task: { taskId: "task-1", activityStore }, getCurrentTaskActivityStore: () => activityStore } as never,
			TaskActivitySubscriptionRequest.create({ taskId: "task-1" }),
			responseStream,
			requestId,
		)
		try {
			await vi.waitFor(() => expect(responseStream).toHaveBeenCalledOnce())
			expect(getRequestRegistry().hasRequest(requestId)).toBe(true)

			activityStore.dispose()

			await vi.waitFor(() => expect(responseStream).toHaveBeenCalledTimes(2))
			expect(responseStream.mock.calls[1]).toEqual([expect.objectContaining({ snapshot: false, activities: [] }), true])
			expect(getRequestRegistry().hasRequest(requestId)).toBe(false)
		} finally {
			getRequestRegistry().cancelRequest(requestId)
		}
	})

	it("projects retry attempts and an unavailable reason through the Proto stream", async () => {
		const activityStore = new TaskActivityStore("task-1")
		activityStore.create({
			activityId: "subagent-projection",
			kind: "subagent",
			executionMode: "background",
			title: "review",
			retryRecipe: {
				kind: "subagent",
				schemaVersion: 1,
				subagentName: "retired-reviewer",
				task: "review",
				prompt: "<task>review</task><context>ctx</context>",
				timeoutSeconds: 30,
				retryable: true,
			},
			retry: async () => true,
		})
		activityStore.appendEvent("subagent-projection", {
			kind: "assistant_message",
			phase: "final",
			text: "first attempt",
		})
		activityStore.update("subagent-projection", { status: "failed", error: "temporary failure" })
		await activityStore.retry(["subagent-projection"])
		activityStore.appendEvent("subagent-projection", {
			kind: "assistant_message",
			phase: "final",
			text: "second attempt",
		})
		activityStore.update("subagent-projection", { status: "failed", error: "configuration changed" })
		activityStore.setRetryUnavailableReason(
			"subagent-projection",
			"Retry unavailable: subagent 'retired-reviewer' is no longer enabled.",
		)
		const streamedUpdates: TaskActivityUpdate[] = []
		const responseStream = vi.fn(async (update: TaskActivityUpdate) => {
			streamedUpdates.push(update)
		})

		await subscribeToTaskActivities(
			{ task: { taskId: "task-1", activityStore }, getCurrentTaskActivityStore: () => activityStore } as never,
			TaskActivitySubscriptionRequest.create({ taskId: "task-1" }),
			responseStream,
		)
		await vi.waitFor(() => expect(responseStream).toHaveBeenCalledOnce())

		const streamed = streamedUpdates[0]
		expect(streamed).toBeDefined()
		const decoded = TaskActivityUpdate.decode(TaskActivityUpdate.encode(streamed).finish())
		const activity = decoded.activities[0]
		expect(activity).toMatchObject({
			activityId: "subagent-projection",
			currentAttempt: 2,
			retryable: false,
			retryUnavailableReason: "Retry unavailable: subagent 'retired-reviewer' is no longer enabled.",
		})
		expect(activity?.events.find((event) => event.text === "first attempt")?.attempt).toBe(1)
		expect(activity?.events.find((event) => event.text === "second attempt")?.attempt).toBe(2)
	})
})
