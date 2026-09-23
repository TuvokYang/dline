import { Controller } from "@core/controller"
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
