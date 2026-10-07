import { Controller } from "@core/controller"
import { createInitialTaskState, type TaskState } from "@core/task/kernel"
import { DispatchInteractionRequest, DispatchInteractionResponse } from "@shared/proto/dline/task"
import Mutex from "p-mutex"
import { describe, expect, it, vi } from "vitest"

const LIFECYCLE_WAIT_MS = 1_000

const dispatchInteraction = vi.hoisted(() => vi.fn())
vi.mock("../task/dispatchInteraction", () => ({ dispatchInteraction }))

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

function awaitingState(): TaskState {
	return {
		...createInitialTaskState("task-history"),
		revision: 7,
		flow: { phase: "paused" },
		dialog: {
			approvalsByBlock: {},
			primary: {
				interactionId: "interaction-1",
				turnId: "turn-1",
				kind: "resume",
				status: "awaiting",
				createdRevision: 6,
				presentationRef: "presentation-1",
				receiverGeneration: 1,
				actionRules: [{ actionId: "resume", payloadPolicy: "none" }],
			},
		},
	}
}

/**
 * Build a Controller whose history display promotes into a session whose
 * resumed turn keeps running after the reply is accepted.
 */
function createPromotingController(continuation: Promise<void>): Controller {
	const controller = Object.create(Controller.prototype) as Controller
	const session = { taskId: "task-history", state: awaitingState }
	dispatchInteraction.mockImplementation(async () => {
		// The accepted reply starts a turn that runs through its executors; the
		// dispatch itself must not wait for it.
		void continuation
		return DispatchInteractionResponse.create({ accepted: true, result: "accepted" })
	})
	Object.assign(controller as unknown as Record<string, unknown>, {
		taskLifecycleMutex: new Mutex(),
		historyDisplaySession: {
			taskId: "task-history",
			historyItem: { id: "task-history" },
			accepts: () => true,
			dispose: async () => undefined,
		},
		historyDisplayProfileBindings: new WeakMap(),
		stopLockPoll: () => undefined,
	})
	vi.spyOn(controller, "initTask").mockImplementation(async () => {
		Object.assign(controller as unknown as Record<string, unknown>, { task: session })
		return "task-history"
	})
	return controller
}

function resumeRequest(): DispatchInteractionRequest {
	return DispatchInteractionRequest.create({
		taskId: "task-history",
		turnId: "history-display:task-history",
		interactionId: "history-display:task-history:resume",
		actionId: "resume",
		stateRevision: 0,
	})
}

describe("Controller history display interaction", () => {
	it("releases the task lifecycle while the promoted continuation is still running", async () => {
		// A resumed turn keeps driving the Task until its next interaction,
		// which may wait for the user indefinitely. Close must not queue behind it.
		const continuation = deferred()
		const controller = createPromotingController(continuation.promise)

		const response = await controller.dispatchHistoryDisplayInteraction(resumeRequest())
		const lifecycle = await Promise.race([
			controller.runTaskLifecycleOperation(async () => "ran" as const),
			new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), LIFECYCLE_WAIT_MS)),
		])

		expect(response).toMatchObject({ accepted: true, result: "accepted" })
		expect(lifecycle).toBe("ran")
		// The reply was rebased onto the promoted runtime's own interaction.
		expect(dispatchInteraction).toHaveBeenCalledWith(
			controller,
			expect.objectContaining({
				taskId: "task-history",
				turnId: "turn-1",
				interactionId: "interaction-1",
				stateRevision: 7,
			}),
		)
		continuation.resolve()
	})
})
