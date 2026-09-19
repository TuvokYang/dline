import { describe, expect, it, vi } from "vitest"
import { BlockPhase } from "../../BlockPhaseMachine"
import type { TaskEffectPorts } from "../../runtime/TaskEffectRunner"
import type { TaskEvent } from "../../runtime/TaskEvent"
import { TaskRuntime } from "../../runtime/TaskRuntime"
import { createTaskRuntimeState } from "../../runtime/TaskRuntimeState"
import { TaskPhase } from "../../TaskPhase"
import { InteractionCancellationError } from "../InteractionCancellationError"
import { InteractionCoordinator } from "../InteractionCoordinator"

function createPorts(): TaskEffectPorts {
	return {
		postView: async () => {},
		persistSnapshot: async () => {},
		cancelRuntime: async () => {},
		prepareResume: async () => {},
		startApi: async () => {},
		executeTool: async () => {},
		appendSay: async () => {},
		appendAsk: async () => ({ uiMessageTs: 100 }),
		startNewTask: async () => {},
	}
}

describe("InteractionCoordinator cancellation fence", () => {
	it("does not claim an old-generation detached continuation after cancellation starts", async () => {
		const interactionId = "qna-cancel-race"
		const turnId = `turn:${interactionId}`
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.EXECUTING,
					revision: 7,
					anchor: { apiIndex: 1, uiMessageTs: 100, turnId, interactionId },
				}),
				turn: {
					turnId,
					assistantApiIndex: 1,
					mode: "serial",
					blocks: [
						{
							dlineTid: interactionId,
							functionId: "function-qna",
							toolName: "qna_respond",
							phase: BlockPhase.AUTO_EXECUTING,
							ts: 100,
							requiresApproval: false,
							conversationHistoryIndex: 1,
						},
					],
				},
				interaction: {
					taskId: "task-1",
					turnId,
					interactionId,
					kind: "qna_response",
					status: "awaiting",
					createdRevision: 6,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			createPorts(),
		)
		const dispatch = runtime.dispatch.bind(runtime)
		let releaseRespond: (() => void) | undefined
		let responseCommitted: (() => void) | undefined
		const responseCommit = new Promise<void>((resolve) => {
			responseCommitted = resolve
		})
		const respondGate = new Promise<void>((resolve) => {
			releaseRespond = resolve
		})
		vi.spyOn(runtime, "dispatch").mockImplementation(async (event: TaskEvent) => {
			const result = await dispatch(event)
			if (event.type === "INTERACTION_RESPONDED") {
				responseCommitted?.()
				await respondGate
			}
			return result
		})
		const coordinator = new InteractionCoordinator(runtime)
		const continuation = vi.fn(async () => undefined)
		coordinator.registerDetachedContinuation(continuation)

		const responding = coordinator.respond({
			taskId: "task-1",
			turnId,
			interactionId,
			actionId: "reply",
			stateRevision: 7,
			draft: { text: "answer", images: [], files: [] },
		})
		await responseCommit

		coordinator.cancelPending()
		const cancel = await dispatch({ type: "TASK_CANCEL_REQUESTED", source: "user" })
		expect(cancel.accepted).toBe(true)
		await coordinator.waitForClaimedContinuations()
		releaseRespond?.()
		const result = await responding

		expect(result).toMatchObject({
			accepted: false,
			error: { code: "stale_interaction", eventType: "INTERACTION_RESPONDED", phase: TaskPhase.CANCELLING },
		})
		expect(continuation).not.toHaveBeenCalled()
		expect(runtime.getState().phase).toBe(TaskPhase.CANCELLING)
	})

	it("cancels one error recovery waiter and exposes its settlement boundary", async () => {
		const interactionId = "profile-recovery"
		const turnId = "turn:profile-recovery"
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.AWAITING_APPROVAL,
					revision: 2,
					anchor: { apiIndex: 1, uiMessageTs: 100, turnId, interactionId },
				}),
				interaction: {
					taskId: "task-1",
					turnId,
					interactionId,
					kind: "error_retry",
					status: "awaiting",
					createdRevision: 1,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			createPorts(),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const recovery = coordinator.recover({
			turnId,
			interactionId,
			apiIndex: 1,
			presentation: "Profile not valid",
		})

		await vi.waitFor(() => expect(runtime.getState().interaction?.status).toBe("awaiting"))
		const settlement = coordinator.waitForPendingInteraction(interactionId)

		expect(coordinator.cancelPendingInteraction(interactionId, "profile_recovered")).toBe(true)
		await expect(recovery).rejects.toMatchObject({
			name: "InteractionCancellationError",
			reason: "profile_recovered",
		})
		await expect(settlement).resolves.toBeUndefined()
		expect(coordinator.cancelPendingInteraction(interactionId)).toBe(false)
	})

	it("preserves lifecycle cancellation identity for a restored awaiting interaction", async () => {
		const interactionId = "restored-make-plan"
		const turnId = `turn:${interactionId}`
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.EXECUTING,
					revision: 4,
					anchor: { apiIndex: 1, uiMessageTs: 100, turnId, interactionId },
				}),
				interaction: {
					taskId: "task-1",
					turnId,
					interactionId,
					kind: "make_plan",
					status: "awaiting",
					createdRevision: 3,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			createPorts(),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const waiting = coordinator.open({
			turnId,
			interactionId,
			kind: "make_plan",
			presentation: "Plan ready",
		})

		const cancellationGeneration = coordinator.cancelPending("task_terminated")

		await expect(waiting).rejects.toMatchObject({
			name: "InteractionCancellationError",
			reason: "task_terminated",
		})
		await expect(waiting).rejects.toBeInstanceOf(InteractionCancellationError)
		coordinator.completeCancellation(cancellationGeneration)
	})

	it("rejects a response submitted after cancellation intent without mutating the replacement interaction", async () => {
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 1 } }),
			createPorts(),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const cancellationGeneration = coordinator.cancelPending()

		const result = await coordinator.respond({
			taskId: "task-1",
			turnId: "old-turn",
			interactionId: "old-interaction",
			actionId: "reply",
			stateRevision: runtime.getState().revision,
			draft: { text: "keep this draft", images: [], files: [] },
		})

		expect(result).toMatchObject({ accepted: false, error: { code: "stale_interaction" } })
		expect(runtime.getState()).toMatchObject({ phase: TaskPhase.STREAMING, revision: 0 })
		expect(runtime.getState().interaction).toBeUndefined()
		coordinator.completeCancellation(cancellationGeneration)
	})

	it("permanently fences interaction waiters and future responses after Controller detachment", async () => {
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 1 } }),
			createPorts(),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const turnId = "turn:detached"
		const interactionId = "interaction:detached"
		const waiting = coordinator.open({
			turnId,
			interactionId,
			kind: "qna_response",
			presentation: "Question",
		})

		await vi.waitFor(() => expect(runtime.getState().interaction?.status).toBe("awaiting"))
		coordinator.fence("task_detached")
		coordinator.fence("task_detached")

		await expect(waiting).rejects.toMatchObject({
			name: "InteractionCancellationError",
			reason: "task_detached",
		})
		const result = await coordinator.respond({
			taskId: "task-1",
			turnId,
			interactionId,
			actionId: "reply",
			stateRevision: runtime.getState().revision,
			draft: { text: "must not continue", images: [], files: [] },
		})
		expect(result).toMatchObject({ accepted: false, error: { code: "stale_interaction" } })
		expect(runtime.getState().interaction).toMatchObject({ interactionId, status: "awaiting" })
	})
})
