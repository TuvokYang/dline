import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { TaskActivitySubscriptionRequest, TaskActivityUpdate } from "@shared/proto/dline/task"
import { describe, expect, it, vi } from "vitest"
import { TaskActivityStore } from "../../../task/activity/TaskActivityStore"
import { subscribeToTaskActivities } from "../subscribeToTaskActivities"

describe("subscribeToTaskActivities", () => {
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

		const session = createSessionFixture({ taskId: "task-1", owners: { activities: activityStore } })

		await subscribeToTaskActivities(
			{ task: session } as never,
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
