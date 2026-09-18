import type { DispatchInteractionResponse } from "@shared/proto/dline/task"
import { describe, expect, it, vi } from "vitest"
import { createInteractionDispatchGate } from "../dispatch-gate"
import type { DispatchInteraction } from "../types"

function request(interactionId: string, actionId: "approve" | "reject") {
	return {
		taskId: "task-1",
		turnId: `turn-${interactionId}`,
		interactionId,
		actionId,
		stateRevision: 8,
		draft: { text: "submitted feedback", images: [], files: [] },
	}
}

describe("interaction dispatch gate", () => {
	it("shares one backend settlement across footer and composer dispatches for the same interaction", async () => {
		let resolve!: (response: DispatchInteractionResponse) => void
		const pending = new Promise<DispatchInteractionResponse>((complete) => {
			resolve = complete
		})
		const dispatch = vi.fn<DispatchInteraction>(() => pending)
		const gatedDispatch = createInteractionDispatchGate(dispatch)
		const approve = request("interaction-1", "approve")
		const reject = request("interaction-1", "reject")

		const footerSettlement = gatedDispatch(approve)
		const composerSettlement = gatedDispatch(reject)

		expect(composerSettlement).toBe(footerSettlement)
		expect(dispatch).toHaveBeenCalledOnce()
		expect(dispatch).toHaveBeenCalledWith(approve)

		resolve({ accepted: true, result: "accepted" })
		await expect(footerSettlement).resolves.toEqual({ accepted: true, result: "accepted" })
		await expect(composerSettlement).resolves.toEqual({ accepted: true, result: "accepted" })
	})

	it("allows a successor interaction while the previous interaction is still settling", async () => {
		const dispatch = vi.fn<DispatchInteraction>(async () => ({ accepted: true, result: "accepted" }))
		const gatedDispatch = createInteractionDispatchGate(dispatch)

		await Promise.all([gatedDispatch(request("interaction-1", "approve")), gatedDispatch(request("interaction-2", "reject"))])

		expect(dispatch).toHaveBeenCalledTimes(2)
	})

	it("releases a failed interaction so an explicit retry can dispatch again", async () => {
		const dispatch = vi
			.fn<DispatchInteraction>()
			.mockRejectedValueOnce(new Error("transport failed"))
			.mockResolvedValueOnce({ accepted: true, result: "accepted" })
		const gatedDispatch = createInteractionDispatchGate(dispatch)
		const retry = request("interaction-1", "approve")

		await expect(gatedDispatch(retry)).rejects.toThrow("transport failed")
		await expect(gatedDispatch(retry)).resolves.toEqual({ accepted: true, result: "accepted" })
		expect(dispatch).toHaveBeenCalledTimes(2)
	})
})
