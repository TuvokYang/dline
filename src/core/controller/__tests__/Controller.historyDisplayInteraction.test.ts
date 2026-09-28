import { Controller } from "@core/controller"
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

/** Build a Controller whose history display promotes into a Task with a long-running continuation. */
function createPromotingController(settlement: Promise<void>): Controller {
	const controller = Object.create(Controller.prototype) as Controller
	const interaction = { status: "awaiting", taskId: "task-history", turnId: "turn-1", interactionId: "interaction-1" }
	const task = {
		taskId: "task-history",
		getRuntimeState: () => ({ interaction, revision: 7 }),
		dispatchRuntime: vi.fn(async () => ({ accepted: true })),
		waitForInteractionSettlement: vi.fn(() => settlement),
	}
	Object.assign(controller as unknown as Record<string, unknown>, {
		taskLifecycleMutex: new Mutex(),
		historyDisplaySession: {
			taskId: "task-history",
			historyItem: { id: "task-history" },
			accepts: () => true,
			dispose: async () => undefined,
		},
	})
	vi.spyOn(controller, "initTask").mockImplementation(async () => {
		Object.assign(controller as unknown as Record<string, unknown>, { task })
		return "task-history"
	})
	vi.spyOn(controller, "postStateToWebview").mockResolvedValue(undefined)
	return controller
}

function approveRequest(): DispatchInteractionRequest {
	return DispatchInteractionRequest.create({
		taskId: "task-history",
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

	it("keeps the history surface open when promotion fails", async () => {
		const controller = Object.create(Controller.prototype) as Controller
		const dispose = vi.fn(async () => undefined)
		const session = {
			taskId: "task-history",
			historyItem: { id: "task-history" },
			accepts: () => true,
			dispose,
		}
		Object.assign(controller as unknown as Record<string, unknown>, {
			taskLifecycleMutex: new Mutex(),
			historyDisplaySession: session,
		})
		vi.spyOn(controller, "initTask").mockRejectedValue(new Error("restore failed"))
		const postState = vi.spyOn(controller, "postStateToWebview").mockResolvedValue(undefined)

		await expect(controller.dispatchHistoryDisplayInteraction(approveRequest())).resolves.toMatchObject({
			accepted: false,
			result: "invalid_runtime_event",
		})

		expect((controller as unknown as { historyDisplaySession?: unknown }).historyDisplaySession).toBe(session)
		expect(dispose).not.toHaveBeenCalled()
		expect(postState).toHaveBeenCalledWith({ immediate: true })
	})

	it("releases the task lifecycle while the promoted continuation is still running", async () => {
		// A restored approval keeps driving the Task until its next interaction,
		// which may wait for the user indefinitely. Close must not queue behind it.
		const settlement = deferred()
		const controller = createPromotingController(settlement.promise)

		let dispatchSettled = false
		const dispatch = controller.dispatchHistoryDisplayInteraction(approveRequest()).then((response) => {
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
