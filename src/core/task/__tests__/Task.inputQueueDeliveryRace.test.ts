import { type TaskInputQueuePorts, TaskInputQueueService } from "@core/task/input-queue/TaskInputQueueService"
import { describe, expect, it, vi } from "vitest"

type SubmitInteraction = TaskInputQueuePorts["submitInteraction"]

function createService(submitInteraction: SubmitInteraction) {
	let service!: TaskInputQueueService
	service = new TaskInputQueueService({
		taskId: "task-1",
		currentRevision: () => 7,
		persistQueue: async () => service.recordSnapshotWriteOutcome("written"),
		publishProjection: async () => undefined,
		submitInteraction,
		appendUserContent: () => undefined,
		presentDeliveredInput: async () => undefined,
	})
	return service
}

describe("Task input queue turn-end delivery", () => {
	it("retries delivery when a queue mutation lands after the awaiting callback", async () => {
		const submitInteraction = vi.fn<SubmitInteraction>(async () => ({ accepted: true }))
		const service = createService(submitInteraction)
		service.markAwaitingUser({ turnId: "turn-1", interactionId: "interaction-1" })

		const result = await service.mutate({ enqueue: { draft: { text: "rapid feedback" } } })

		expect(result.accepted).toBe(true)
		await vi.waitFor(() => expect(submitInteraction).toHaveBeenCalledOnce())
		expect(submitInteraction.mock.calls[0]?.[0].interactionId).toBe("interaction-1")
	})

	it("clears only the awaiting target settled by a queue delivery", async () => {
		let settleFirst!: (result: { accepted: boolean }) => void
		const submitInteraction = vi
			.fn<SubmitInteraction>()
			.mockImplementationOnce(() => new Promise((resolve) => (settleFirst = resolve)))
			.mockResolvedValue({ accepted: true })
		const service = createService(submitInteraction)
		service.markAwaitingUser({ turnId: "turn-1", interactionId: "interaction-1" })
		await service.mutate({ enqueue: { draft: { text: "first feedback" } } })
		await vi.waitFor(() => expect(submitInteraction).toHaveBeenCalledOnce())

		service.markAwaitingUser({ turnId: "turn-2", interactionId: "interaction-2" })
		settleFirst({ accepted: true })
		await vi.waitFor(() => expect(service.snapshot()).toHaveLength(0))
		await service.mutate({ enqueue: { draft: { text: "second feedback" } } })

		await vi.waitFor(() => expect(submitInteraction).toHaveBeenCalledTimes(2))
		expect(submitInteraction.mock.calls[1]?.[0].interactionId).toBe("interaction-2")
	})
})
