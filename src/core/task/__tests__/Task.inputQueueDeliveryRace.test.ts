import { Task } from "@core/task"
import { describe, expect, it, vi } from "vitest"

describe("Task input queue turn-end delivery", () => {
	it("retries delivery when a queue mutation lands after the awaiting callback", async () => {
		const deliverAtTurnEnd = vi.fn(async () => undefined)
		const mutate = vi.fn(async () => ({ accepted: true, result: "queued-input-1" }))
		const task = {
			awaitingQueuedInputInteraction: { turnId: "turn-1", interactionId: "interaction-1" },
			inputQueueCoordinator: { deliverAtTurnEnd, mutate },
		}

		const result = await Task.prototype.mutateInputQueue.call(task as never, {
			enqueue: { draft: { text: "rapid feedback" } },
		})

		expect(result).toEqual({ accepted: true, result: "queued-input-1" })
		expect(deliverAtTurnEnd).toHaveBeenCalledOnce()
	})

	it("clears only the awaiting target settled by a queue delivery", async () => {
		type AwaitingTarget = { turnId: string; interactionId: string }
		const awaiting: AwaitingTarget = { turnId: "turn-1", interactionId: "interaction-1" }
		const task: {
			awaitingQueuedInputInteraction?: AwaitingTarget
			dispatchRuntime: ReturnType<typeof vi.fn>
			renderQueuedInputBlocks: ReturnType<typeof vi.fn>
			taskId: string
			taskRuntime: { getState(): { revision: number } }
		} = {
			awaitingQueuedInputInteraction: awaiting,
			dispatchRuntime: vi.fn(async () => ({ accepted: true })),
			renderQueuedInputBlocks: vi.fn(() => ["rapid feedback"]),
			taskId: "task-1",
			taskRuntime: { getState: () => ({ revision: 7 }) },
		}
		const answerTurnEndWithQueuedInput = (
			Task.prototype as unknown as {
				answerTurnEndWithQueuedInput(delivery: unknown): Promise<boolean>
			}
		).answerTurnEndWithQueuedInput

		const accepted = await answerTurnEndWithQueuedInput.call(task, {
			entries: [{ text: "rapid feedback" }],
			files: [],
			images: [],
			kind: "queued",
		})

		expect(accepted).toBe(true)
		expect(task.awaitingQueuedInputInteraction).toBeUndefined()
	})
})
