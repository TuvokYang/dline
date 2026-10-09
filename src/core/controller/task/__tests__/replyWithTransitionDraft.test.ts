import { createInitialTaskState, type TaskState } from "@core/task/kernel"
import { DispatchInteractionResponse } from "@shared/proto/dline/task"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { dispatchInteraction } from "../dispatchInteraction"
import { replyWithTransitionDraft } from "../replyWithTransitionDraft"

vi.mock("../dispatchInteraction", () => ({ dispatchInteraction: vi.fn() }))
const dispatch = vi.mocked(dispatchInteraction)

function awaitingCompletion(): TaskState {
	return {
		...createInitialTaskState("task-1"),
		revision: 18,
		dialog: {
			approvalsByBlock: {},
			primary: {
				interactionId: "interaction-1",
				turnId: "turn-1",
				kind: "completion",
				status: "awaiting",
				createdRevision: 6,
				presentationRef: "presentation-1",
				actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
				receiverGeneration: 0,
			},
		},
	} as TaskState
}

function controllerWith(state: TaskState) {
	return { task: { taskId: "task-1", taskInstanceId: "open-1", state: () => state } } as never
}

const DRAFT = { message: "E2E_PLAN_DRAFT", images: ["image"], files: ["file"] }

describe("replyWithTransitionDraft", () => {
	beforeEach(() => dispatch.mockReset())

	it("answers the awaiting dialog for the opening the switch was committed on", async () => {
		dispatch.mockResolvedValue(DispatchInteractionResponse.create({ accepted: true, result: "accepted" }))

		await expect(replyWithTransitionDraft(controllerWith(awaitingCompletion()), DRAFT)).resolves.toBe("replied")

		expect(dispatch).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				taskId: "task-1",
				// dispatchInteraction refuses a reply that names no opening.
				taskInstanceId: "open-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "reply",
				stateRevision: 18,
				draft: { text: "E2E_PLAN_DRAFT", images: ["image"], files: ["file"] },
			}),
		)
	})

	it("reports a refused answer so the switch is not taken as done", async () => {
		dispatch.mockResolvedValue(DispatchInteractionResponse.create({ accepted: false, result: "stale_interaction" }))

		await expect(replyWithTransitionDraft(controllerWith(awaitingCompletion()), DRAFT)).resolves.toBe("rejected")
	})

	it("leaves an empty draft and a task with no awaiting dialog to the Webview", async () => {
		const idle = { ...createInitialTaskState("task-1"), revision: 3 } as TaskState

		await expect(replyWithTransitionDraft(controllerWith(awaitingCompletion()), { message: "  " })).resolves.toBe("none")
		await expect(replyWithTransitionDraft(controllerWith(idle), DRAFT)).resolves.toBe("none")
		await expect(replyWithTransitionDraft({ task: undefined } as never, DRAFT)).resolves.toBe("none")
		expect(dispatch).not.toHaveBeenCalled()
	})
})
