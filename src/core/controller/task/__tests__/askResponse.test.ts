import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { AskResponseRequest } from "@shared/proto/dline/task"
import { describe, expect, it, vi } from "vitest"
import { askResponse } from "../askResponse"

vi.mock("../dispatchInteraction", () => ({ dispatchInteraction: vi.fn(async () => undefined) }))
const { dispatchInteraction } = await import("../dispatchInteraction")

/** Build a controller whose session is awaiting the given primary interaction. */
function controller(interaction?: { interactionId: string; turnId: string }, writable = true) {
	const session = createSessionFixture({
		session: { writable },
		patchState: (state) => ({
			...state,
			dialog: {
				...state.dialog,
				primary: interaction
					? {
							interactionId: interaction.interactionId,
							turnId: interaction.turnId,
							status: "awaiting" as const,
							kind: "approval" as const,
							receiverGeneration: 0,
							createdRevision: 0,
							presentationRef: "presentation:approval",
							actionRules: [
								{ actionId: "approve", payloadPolicy: "none" as const },
								{ actionId: "reject", payloadPolicy: "draft" as const },
							],
						}
					: undefined,
			},
		}),
	})
	return { value: { task: session }, session }
}

describe("askResponse legacy boundary", () => {
	it("routes a legacy button press into the awaiting causal interaction of this opening", async () => {
		const { value, session } = controller({ interactionId: "interaction-1", turnId: "turn-1" })

		await askResponse(value as never, AskResponseRequest.create({ responseType: "yesButtonClicked", text: "legacy" }))

		// dispatchInteraction refuses a reply that names no opening.
		expect(session.taskInstanceId).toBeTruthy()
		expect(dispatchInteraction).toHaveBeenCalledWith(
			value,
			expect.objectContaining({
				interactionId: "interaction-1",
				actionId: "approve",
				taskInstanceId: session.taskInstanceId,
			}),
		)
		expect(session.task.submitInput).not.toHaveBeenCalled()
	})

	it("keeps legacy non-interaction feedback compatible by submitting task input", async () => {
		const { value, session } = controller()

		await askResponse(value as never, AskResponseRequest.create({ responseType: "messageResponse", text: "interrupt" }))

		expect(session.inputs.materialize).toHaveBeenCalledWith({ text: "interrupt", images: [], files: [] })
		expect(session.task.submitInput).toHaveBeenCalledTimes(1)
	})

	it("stores nothing for a window that does not own the task", async () => {
		vi.mocked(dispatchInteraction).mockClear()
		const awaiting = controller({ interactionId: "interaction-1", turnId: "turn-1" }, false)
		await askResponse(awaiting.value as never, AskResponseRequest.create({ responseType: "yesButtonClicked" }))
		expect(dispatchInteraction).not.toHaveBeenCalled()

		const idle = controller(undefined, false)
		await askResponse(idle.value as never, AskResponseRequest.create({ responseType: "messageResponse", text: "hi" }))
		expect(idle.session.inputs.materialize).not.toHaveBeenCalled()
		expect(idle.session.task.submitInput).not.toHaveBeenCalled()
	})
})
