import { Controller } from "@core/controller"
import { dispatchInteraction } from "@core/controller/task/dispatchInteraction"
import { TaskPhase } from "@core/task/TaskPhase"
import type { TaskViewState } from "@shared/ExtensionMessage"
import { DispatchInteractionRequest } from "@shared/proto/dline/task"
import Mutex from "p-mutex"
import { describe, expect, it, vi } from "vitest"

const LIFECYCLE_WAIT_MS = 1_000

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

/** Keep historical and active interactions on the same canonical Task. */
function createBoundController(settlement: Promise<void>) {
	const controller = Object.create(Controller.prototype) as Controller
	const interaction = { status: "awaiting", taskId: "task-history", turnId: "turn-1", interactionId: "interaction-1" }
	const task = {
		taskId: "task-history",
		taskInstanceId: "open-1",
		getRuntimeState: () => ({ interaction, revision: 7 }),
		dispatchRuntime: vi.fn(async () => ({ accepted: true })),
		waitForInteractionSettlement: vi.fn(() => settlement),
	}
	Object.assign(controller as unknown as Record<string, unknown>, { taskLifecycleMutex: new Mutex(), task })
	vi.spyOn(controller, "postStateToWebview").mockResolvedValue(undefined)
	return { controller, task }
}

function approveRequest(): DispatchInteractionRequest {
	return DispatchInteractionRequest.create({
		taskId: "task-history",
		taskInstanceId: "open-1",
		turnId: "turn-1",
		interactionId: "interaction-1",
		actionId: "approve",
		stateRevision: 7,
	})
}

describe("Controller history display interaction", () => {
	it("keeps an awaiting runtime interaction verified while the Webview message window catches up", () => {
		const controller = Object.create(Controller.prototype) as Controller
		const runtimeState = {
			taskId: "task-active",
			phase: TaskPhase.AWAITING_APPROVAL,
			revision: 8,
			anchor: { apiIndex: 1, uiMessageTs: 100, turnId: "turn-1", interactionId: "interaction-1" },
			interaction: {
				taskId: "task-active",
				turnId: "turn-1",
				interactionId: "interaction-1",
				kind: "tool_approval" as const,
				status: "awaiting" as const,
				createdRevision: 7,
				anchor: { messageTs: 100, messageType: "ask" as const },
			},
		}
		Object.assign(controller as unknown as Record<string, unknown>, {
			task: {
				taskInstanceId: "open-active",
				isReadOnly: () => false,
				getRuntimeState: () => runtimeState,
				isHistoryPreparationPending: () => false,
				getReadyBackgroundHandoffActivityId: () => undefined,
				hasAutoRetrySequence: () => false,
				hasPendingAutoRetry: () => false,
				getContextCompactionOperationId: () => undefined,
				isForceTruncateAvailable: () => false,
				isBackgroundHandoffRequested: () => false,
			},
		})
		const view = (
			controller as unknown as { projectCurrentTaskViewState(): TaskViewState | undefined }
		).projectCurrentTaskViewState()

		expect(view?.activeInteraction).toMatchObject({
			interactionId: "interaction-1",
			kind: "tool_approval",
			anchorVerified: true,
		})
		expect(view?.footer.actions.map((action) => action.type)).toEqual(["approve", "reject"])
		expect(view).not.toHaveProperty("diagnostic")
	})

	it("keeps the same history Task and causal request when execution admission fails", async () => {
		const { controller, task } = createBoundController(Promise.resolve())
		const init = vi.spyOn(controller, "initTask")
		task.dispatchRuntime.mockRejectedValueOnce(new Error("history stores failed"))
		await expect(dispatchInteraction(controller, approveRequest())).rejects.toThrow("history stores failed")
		expect(controller.task).toBe(task)
		expect(init).not.toHaveBeenCalled()
		expect(task.dispatchRuntime).toHaveBeenCalledWith({
			type: "INTERACTION_RESPONDED",
			response: expect.objectContaining({
				taskId: "task-history",
				turnId: "turn-1",
				interactionId: "interaction-1",
				stateRevision: 7,
			}),
		})
	})

	it("releases the task lifecycle while the canonical continuation is still running", async () => {
		// A restored approval keeps driving the Task until its next interaction,
		// which may wait for the user indefinitely. Close must not queue behind it.
		const settlement = deferred()
		const { controller } = createBoundController(settlement.promise)

		let dispatchSettled = false
		const dispatch = dispatchInteraction(controller, approveRequest()).then((response) => {
			dispatchSettled = true
			return response
		})

		const lifecycle = await Promise.race([
			controller.runTaskLifecycleOperation(async () => "ran" as const),
			new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), LIFECYCLE_WAIT_MS)),
		])

		expect(lifecycle).toBe("ran")
		expect(dispatchSettled).toBe(false)

		settlement.resolve()
		await expect(dispatch).resolves.toMatchObject({ accepted: true, result: "accepted" })
	})
})
