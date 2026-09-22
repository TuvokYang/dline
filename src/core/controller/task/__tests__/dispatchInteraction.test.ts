import { DispatchInteractionRequest } from "@shared/proto/dline/task"
import { describe, expect, it, vi } from "vitest"
import type { TaskEvent } from "../../../task/runtime/TaskEvent"
import { dispatchInteraction } from "../dispatchInteraction"

interface DispatchTask {
	dispatchRuntime(event: TaskEvent): Promise<{
		accepted: boolean
		error?: { code: string }
	}>
	waitForInteractionSettlement?: (interactionId: string) => Promise<void>
}

interface DispatchController {
	task?: DispatchTask
	dispatchHistoryDisplayInteraction: () => Promise<undefined>
}

/**
 * Create a controller-shaped test boundary with one optional task.
 *
 * Without a task the Controller first offers the request to its lightweight
 * history display, so the double must expose that boundary and decline it to
 * reach the missing-task outcome.
 */
function controller(task?: DispatchTask): DispatchController {
	return {
		...(task ? { task: { waitForInteractionSettlement: async () => {}, ...task } } : {}),
		dispatchHistoryDisplayInteraction: async () => undefined,
	}
}

describe("dispatchInteraction", () => {
	it("maps one causal request to one runtime event", async () => {
		const dispatchRuntime = vi.fn(async () => ({ accepted: true }))
		const request = DispatchInteractionRequest.create({
			taskId: "task-1",
			turnId: "turn-1",
			interactionId: "interaction-1",
			actionId: "approve",
			stateRevision: 12,
			draft: { text: "use smaller steps", images: [], files: [] },
			selection: { values: ["item-1"] },
		})

		const result = await dispatchInteraction(controller({ dispatchRuntime }) as never, request)

		expect(dispatchRuntime).toHaveBeenCalledOnce()
		expect(dispatchRuntime).toHaveBeenCalledWith({
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: 12,
				draft: { text: "use smaller steps", images: [], files: [] },
				selection: { values: ["item-1"] },
			},
		})
		expect(result).toMatchObject({ accepted: true, result: "accepted" })
	})

	it("waits for the accepted interaction continuation before returning", async () => {
		let releaseSettlement: (() => void) | undefined
		const settlement = new Promise<void>((resolve) => {
			releaseSettlement = resolve
		})
		const waitForInteractionSettlement = vi.fn(() => settlement)
		const resultPromise = dispatchInteraction(
			controller({ dispatchRuntime: vi.fn(async () => ({ accepted: true })), waitForInteractionSettlement }) as never,
			DispatchInteractionRequest.create({
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "reply",
				stateRevision: 12,
				draft: { text: "next turn", images: [], files: [] },
			}),
		)
		let resolved = false
		void resultPromise.then(() => {
			resolved = true
		})

		await Promise.resolve()
		expect(waitForInteractionSettlement).toHaveBeenCalledWith("interaction-1")
		expect(resolved).toBe(false)
		releaseSettlement?.()
		await expect(resultPromise).resolves.toMatchObject({ accepted: true, result: "accepted" })
	})

	it("returns stale interaction from runtime rejection", async () => {
		const dispatchRuntime = vi.fn(async () => ({ accepted: false, error: { code: "stale_interaction" } }))
		const result = await dispatchInteraction(
			controller({ dispatchRuntime }) as never,
			DispatchInteractionRequest.create({
				taskId: "task-1",
				turnId: "turn-old",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: 12,
			}),
		)

		expect(result).toMatchObject({ accepted: false, result: "stale_interaction" })
	})

	it("rejects an unsupported action before runtime dispatch", async () => {
		const dispatchRuntime = vi.fn(async () => ({ accepted: true }))
		const result = await dispatchInteraction(
			controller({ dispatchRuntime }) as never,
			DispatchInteractionRequest.create({
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "unsupported",
				stateRevision: 12,
			}),
		)

		expect(result).toMatchObject({ accepted: false, result: "invalid_action" })
		expect(dispatchRuntime).not.toHaveBeenCalled()
	})

	it("normalizes payload rejection for the public protocol", async () => {
		const dispatchRuntime = vi.fn(async () => ({ accepted: false, error: { code: "invalid_interaction_payload" } }))
		const result = await dispatchInteraction(
			controller({ dispatchRuntime }) as never,
			DispatchInteractionRequest.create({
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: 12,
			}),
		)

		expect(result).toMatchObject({ accepted: false, result: "invalid_payload" })
	})

	it("returns missing task without dispatch", async () => {
		const result = await dispatchInteraction(
			controller() as never,
			DispatchInteractionRequest.create({
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: 12,
			}),
		)

		expect(result).toMatchObject({ accepted: false, result: "missing_task" })
	})
})
