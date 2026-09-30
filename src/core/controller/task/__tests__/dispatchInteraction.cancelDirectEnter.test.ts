import type { ClineMessage } from "@shared/ExtensionMessage"
import { DispatchInteractionRequest } from "@shared/proto/dline/task"
import { describe, expect, it, vi } from "vitest"
import { Task } from "../../../task"
import { BlockPhase } from "../../../task/BlockPhaseMachine"
import { InteractionCoordinator } from "../../../task/interaction/InteractionCoordinator"
import { MessageChannel } from "../../../task/MessageChannel"
import type { MessageStateHandler } from "../../../task/message-state"
import type { TaskEffectPorts } from "../../../task/runtime/TaskEffectRunner"
import type { TaskEvent } from "../../../task/runtime/TaskEvent"
import { TaskRuntime } from "../../../task/runtime/TaskRuntime"
import { createTaskRuntimeState } from "../../../task/runtime/TaskRuntimeState"
import { TaskPhase } from "../../../task/TaskPhase"
import { TaskState } from "../../../task/TaskState"
import { dispatchInteraction } from "../dispatchInteraction"

/** Create runtime ports for the live Cancel/direct-Enter admission boundary. */
function createPorts(startApi: TaskEffectPorts["startApi"]): TaskEffectPorts {
	return {
		postView: async () => {},
		persistSnapshot: async () => {},
		cancelRuntime: async () => {},
		prepareResume: async () => {},
		startApi,
		executeTool: async () => {},
		appendSay: async () => {},
		appendAsk: async () => ({ uiMessageTs: 100 }),
		startNewTask: async () => {},
	}
}

/** Create the real Task message boundary while isolating durable storage infrastructure. */
function createMessageBoundary() {
	const clineMessages: ClineMessage[] = []
	const taskState = new TaskState()
	let lastTs = 100
	const channel = new MessageChannel({
		pushMessage: () => {},
		syncState: async () => {},
		messageStateHandler: {
			get clineMessages() {
				return clineMessages
			},
			addToClineMessages: async (message: ClineMessage) => {
				clineMessages.push(message)
			},
			updateClineMessage: async (index: number, updates: Partial<ClineMessage>) => {
				Object.assign(clineMessages[index], updates)
			},
			upsertClineMessageInMemory: async (message: ClineMessage) => message,
			finalizeClineMessage: async (message: ClineMessage) => message,
			flushMessageUpdate: async () => {},
			flushUiMessages: async () => {},
		} as unknown as MessageStateHandler,
		taskState,
		getProviderInfo: () => ({ providerId: "test", modelId: "test-model", mode: "act" }),
		genTs: () => ++lastTs,
	})

	return { channel, clineMessages, taskState }
}

/** Expose the same Task dispatch boundary used by the controller handler. */
function createDispatchTask(runtime: TaskRuntime, coordinator: InteractionCoordinator) {
	return {
		taskId: "task-1",
		taskInstanceId: "open-1",
		taskRuntime: runtime,
		interactionCoordinator: coordinator,
		dispatchRuntime(event: TaskEvent) {
			return event.type === "INTERACTION_RESPONDED" ? coordinator.respond(event.response) : runtime.dispatch(event)
		},
		waitForInteractionSettlement(interactionId: string) {
			return coordinator.waitForClaimedContinuation(interactionId)
		},
	}
}

describe("dispatchInteraction after live Cancel", () => {
	it("keeps the draft unaccepted when Cancel wins after response persistence but before continuation claim", async () => {
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
			createPorts(async () => {}),
		)
		const dispatch = runtime.dispatch.bind(runtime)
		let responseCommitted: (() => void) | undefined
		const responseCommit = new Promise<void>((resolve) => {
			responseCommitted = resolve
		})
		let releaseResponse: (() => void) | undefined
		const responseGate = new Promise<void>((resolve) => {
			releaseResponse = resolve
		})
		vi.spyOn(runtime, "dispatch").mockImplementation(async (event: TaskEvent) => {
			const result = await dispatch(event)
			if (event.type === "INTERACTION_RESPONDED") {
				responseCommitted?.()
				await responseGate
			}
			return result
		})
		const coordinator = new InteractionCoordinator(runtime)
		const continuation = vi.fn(async () => undefined)
		coordinator.registerDetachedContinuation(continuation)
		const task = createDispatchTask(runtime, coordinator)

		const responsePromise = dispatchInteraction(
			{ task } as never,
			DispatchInteractionRequest.create({
				taskInstanceId: "open-1",
				taskId: "task-1",
				turnId,
				interactionId,
				actionId: "reply",
				stateRevision: 7,
				draft: { text: "keep this draft", images: [], files: [] },
			}),
		)
		await responseCommit

		const cancellationGeneration = coordinator.cancelPending()
		const cancel = await dispatch({ type: "TASK_CANCEL_REQUESTED", source: "user" })
		expect(cancel.accepted).toBe(true)
		releaseResponse?.()
		const response = await responsePromise
		coordinator.completeCancellation(cancellationGeneration)

		expect(response).toMatchObject({ accepted: false, result: "stale_interaction" })
		expect(continuation).not.toHaveBeenCalled()
	})

	it("keeps Cancel causal when the interrupted tool effect fails before TASK_CANCELLED", async () => {
		const { channel, clineMessages, taskState } = createMessageBoundary()
		let signalToolStarted: (() => void) | undefined
		const toolStarted = new Promise<void>((resolve) => {
			signalToolStarted = resolve
		})
		let rejectTool: ((error: Error) => void) | undefined
		const toolBarrier = new Promise<void>((_resolve, reject) => {
			rejectTool = reject
		})
		let signalFailureQueued: (() => void) | undefined
		const failureQueued = new Promise<void>((resolve) => {
			signalFailureQueued = resolve
		})
		const startApi = vi.fn(async () => {})
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.STREAMING,
					revision: 4,
					anchor: { apiIndex: 2 },
				}),
				turn: {
					turnId: "turn-command",
					assistantApiIndex: 2,
					mode: "serial",
					blocks: [
						{
							dlineTid: "tid-command",
							functionId: "call-command",
							toolName: "execute_command",
							ts: 90,
							requiresApproval: false,
							conversationHistoryIndex: 2,
							phase: BlockPhase.AUTO_EXECUTING,
						},
					],
				},
			},
			{
				...createPorts(startApi),
				executeTool: async () => {
					signalToolStarted?.()
					await toolBarrier
				},
				cancelRuntime: async () => {
					taskState.abort = true
					rejectTool?.(new Error("Dline instance aborted"))
					await failureQueued
				},
				prepareResume: async () => {
					taskState.abort = false
				},
				appendSay: async (effect) => {
					if (effect.interactionId) {
						await channel.presentSay(
							effect.taskSay,
							effect.presentation,
							effect.images,
							effect.files,
							effect.interactionId,
						)
					}
				},
			},
		)
		const dispatch = runtime.dispatch.bind(runtime)
		vi.spyOn(runtime, "dispatch").mockImplementation((event) => {
			const result = dispatch(event)
			if (event.type === "EFFECT_FAILED" && event.effectType === "EXECUTE_TOOL") {
				signalFailureQueued?.()
			}
			return result
		})
		const coordinator = new InteractionCoordinator(runtime)
		const task = createDispatchTask(runtime, coordinator)

		const execution = task.dispatchRuntime({
			type: "BLOCK_EXECUTION_STARTED",
			turnId: "turn-command",
			dlineTid: "tid-command",
		})
		await toolStarted
		const cancelRequested = await task.dispatchRuntime({ type: "TASK_CANCEL_REQUESTED", source: "user" })
		const cancelled = await task.dispatchRuntime({
			type: "TASK_CANCELLED",
			resume: { turnId: "resume-turn", interactionId: "resume-1", presentation: "" },
		})
		const executionResult = await execution

		expect(executionResult).toMatchObject({
			accepted: false,
			effectError: { effectType: "EXECUTE_TOOL", message: "Dline instance aborted" },
		})
		expect(cancelRequested.accepted).toBe(true)
		expect(cancelled.accepted).toBe(true)
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.PAUSED,
			interaction: { kind: "resume", status: "awaiting", interactionId: "resume-1" },
		})
		expect(runtime.getState().error).toBeUndefined()

		const response = await dispatchInteraction(
			{ task } as never,
			DispatchInteractionRequest.create({
				taskInstanceId: "open-1",
				taskId: "task-1",
				turnId: "resume-turn",
				interactionId: "resume-1",
				actionId: "resume",
				stateRevision: runtime.getState().revision,
				draft: { text: "continue after interrupted command", images: [], files: [] },
			}),
		)

		expect(response).toMatchObject({ accepted: true, result: "accepted" })
		expect(clineMessages).toContainEqual(
			expect.objectContaining({ say: "user_feedback", text: "continue after interrupted command" }),
		)
		expect(startApi).toHaveBeenCalledOnce()
	})

	it("accepts direct input before the resumed API execution finishes", async () => {
		let signalApiStarted: (() => void) | undefined
		const apiStarted = new Promise<void>((resolve) => {
			signalApiStarted = resolve
		})
		let releaseApi: (() => void) | undefined
		const apiBarrier = new Promise<void>((resolve) => {
			releaseApi = resolve
		})
		let signalApiFinished: (() => void) | undefined
		const apiFinished = new Promise<void>((resolve) => {
			signalApiFinished = resolve
		})
		const startApi = vi.fn(async () => {
			signalApiStarted?.()
			await apiBarrier
			signalApiFinished?.()
		})
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 2 } }),
			createPorts(startApi),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const task = createDispatchTask(runtime, coordinator)

		await task.dispatchRuntime({ type: "TASK_CANCEL_REQUESTED", source: "user" })
		await task.dispatchRuntime({
			type: "TASK_CANCELLED",
			resume: { turnId: "resume-turn", interactionId: "resume-1", presentation: "" },
		})
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.PAUSED,
			interaction: { kind: "resume", status: "awaiting", interactionId: "resume-1" },
		})

		const responsePromise = dispatchInteraction(
			{ task } as never,
			DispatchInteractionRequest.create({
				taskInstanceId: "open-1",
				taskId: "task-1",
				turnId: "resume-turn",
				interactionId: "resume-1",
				actionId: "resume",
				stateRevision: runtime.getState().revision,
				draft: { text: "continue from input", images: [], files: [] },
			}),
		)

		await apiStarted
		const responseBeforeApiCompletion = await Promise.race([
			responsePromise,
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
		])

		releaseApi?.()
		await apiFinished
		await responsePromise

		expect(responseBeforeApiCompletion).toMatchObject({ accepted: true, result: "accepted" })
		expect(startApi).toHaveBeenCalledOnce()
	})

	it("passes Cancel direct input through the real MessageChannel before starting the provider", async () => {
		const { channel, clineMessages, taskState } = createMessageBoundary()
		const startApi = vi.fn(async () => {})
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 2 } }),
			{
				...createPorts(startApi),
				cancelRuntime: async () => {
					taskState.abort = true
				},
				prepareResume: async () => {
					taskState.abort = false
				},
				appendSay: async (effect) => {
					if (effect.interactionId) {
						await channel.presentSay(
							effect.taskSay,
							effect.presentation,
							effect.images,
							effect.files,
							effect.interactionId,
						)
					}
				},
			},
		)
		const coordinator = new InteractionCoordinator(runtime)
		const task = createDispatchTask(runtime, coordinator)

		await task.dispatchRuntime({ type: "TASK_CANCEL_REQUESTED", source: "user" })
		await task.dispatchRuntime({
			type: "TASK_CANCELLED",
			resume: { turnId: "resume-turn", interactionId: "resume-1", presentation: "" },
		})
		expect(taskState.abort).toBe(true)

		const outcome = await dispatchInteraction(
			{ task } as never,
			DispatchInteractionRequest.create({
				taskInstanceId: "open-1",
				taskId: "task-1",
				turnId: "resume-turn",
				interactionId: "resume-1",
				actionId: "resume",
				stateRevision: runtime.getState().revision,
				draft: { text: "continue from input", images: [], files: [] },
			}),
		).then(
			(response) => ({ response }),
			(error: unknown) => ({ error }),
		)

		expect(outcome).toMatchObject({ response: { accepted: true, result: "accepted" } })
		expect(clineMessages).toContainEqual(expect.objectContaining({ say: "user_feedback", text: "continue from input" }))
		expect(startApi).toHaveBeenCalledOnce()
		expect(runtime.getState()).toMatchObject({ phase: TaskPhase.RESUMING })
		expect(runtime.getState().error).toBeUndefined()
	})

	it("starts a distinct continuation for two consecutive Cancel and direct-Enter transactions", async () => {
		const { channel, clineMessages, taskState } = createMessageBoundary()
		const startApi = vi.fn(async () => {})
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 2 } }),
			{
				...createPorts(startApi),
				cancelRuntime: async () => {
					taskState.abort = true
				},
				prepareResume: async () => {
					taskState.abort = false
				},
				appendSay: async (effect) => {
					if (effect.interactionId) {
						await channel.presentSay(
							effect.taskSay,
							effect.presentation,
							effect.images,
							effect.files,
							effect.interactionId,
						)
					}
				},
			},
		)
		const coordinator = new InteractionCoordinator(runtime)
		const task = {
			...createDispatchTask(runtime, coordinator),
			taskId: "task-1",
			requestCancellation: Task.prototype.requestCancellation,
		} as unknown as Task

		await task.requestCancellation()
		const firstInteraction = runtime.getState().interaction
		if (!firstInteraction) throw new Error("first_resume_interaction_missing")
		const firstResponse = await dispatchInteraction(
			{ task } as never,
			DispatchInteractionRequest.create({
				taskInstanceId: "open-1",
				taskId: "task-1",
				turnId: firstInteraction.turnId,
				interactionId: firstInteraction.interactionId,
				actionId: "resume",
				stateRevision: runtime.getState().revision,
				draft: { text: "first continuation", images: [], files: [] },
			}),
		)

		await task.requestCancellation()
		const secondInteraction = runtime.getState().interaction
		if (!secondInteraction) throw new Error("second_resume_interaction_missing")
		const secondDraft = { text: "second continuation", images: [], files: [] }
		const secondResponse = await dispatchInteraction(
			{ task } as never,
			DispatchInteractionRequest.create({
				taskInstanceId: "open-1",
				taskId: "task-1",
				turnId: secondInteraction.turnId,
				interactionId: secondInteraction.interactionId,
				actionId: "resume",
				stateRevision: runtime.getState().revision,
				draft: secondDraft,
			}),
		)

		expect(firstResponse).toMatchObject({ accepted: true, result: "accepted" })
		expect(secondResponse).toMatchObject({ accepted: true, result: "accepted" })
		expect(secondInteraction.interactionId).not.toBe(firstInteraction.interactionId)
		expect(clineMessages.filter((message) => message.say === "user_feedback").map((message) => message.text)).toEqual([
			"first continuation",
			"second continuation",
		])
		expect(startApi).toHaveBeenCalledTimes(2)
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.RESUMING,
			interaction: {
				interactionId: secondInteraction.interactionId,
				kind: "resume",
				status: "resolving",
				acceptedResponse: { actionId: "resume", draft: secondDraft },
			},
		})

		const admitted = await runtime.dispatch({
			type: "API_REQUEST_STARTED",
			apiIndex: runtime.getState().anchor.apiIndex,
		})

		expect(admitted.accepted).toBe(true)
		expect(runtime.getState()).toMatchObject({ phase: TaskPhase.STREAMING })
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it("does not publish Resume until the pre-Cancel API effect has exited", async () => {
		let signalApiStarted: (() => void) | undefined
		const apiStarted = new Promise<void>((resolve) => {
			signalApiStarted = resolve
		})
		let releaseApi: (() => void) | undefined
		const apiBarrier = new Promise<void>((resolve) => {
			releaseApi = resolve
		})
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 1 } }),
			createPorts(async () => {
				signalApiStarted?.()
				await apiBarrier
			}),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const task = {
			...createDispatchTask(runtime, coordinator),
			requestCancellation: Task.prototype.requestCancellation,
		} as unknown as Task

		const interruptedDispatch = task.dispatchRuntime({ type: "API_RETRY_SCHEDULED", apiIndex: 2 })
		await apiStarted
		const cancellation = task.requestCancellation()
		await vi.waitFor(() => expect(runtime.getState().phase).toBe(TaskPhase.CANCELLING))

		const beforeOldEffectExit = await Promise.race([
			cancellation.then(() => "settled" as const),
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
		])
		expect(beforeOldEffectExit).toBe("pending")
		expect(runtime.getState().interaction).toBeUndefined()

		releaseApi?.()
		await interruptedDispatch
		await expect(cancellation).resolves.toMatchObject({ accepted: true })
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.PAUSED,
			interaction: { kind: "resume", status: "awaiting" },
		})
	})

	it("does not publish Resume while an admitted restored interaction continuation is still exiting", async () => {
		const interactionId = "qna-1"
		const turnId = "turn:qna-1"
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.AWAITING_APPROVAL,
					revision: 3,
					anchor: { apiIndex: 1, turnId, interactionId, uiMessageTs: 100 },
				}),
				turn: {
					turnId,
					assistantApiIndex: 1,
					mode: "serial",
					activeDlineTid: interactionId,
					blocks: [
						{
							dlineTid: interactionId,
							functionId: "fn-qna",
							toolName: "qna_respond",
							phase: BlockPhase.AWAITING_APPROVAL,
							ts: 100,
							requiresApproval: true,
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
					createdRevision: 3,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			createPorts(async () => {}),
		)
		const coordinator = new InteractionCoordinator(runtime)
		let releaseContinuation: (() => void) | undefined
		const continuationBarrier = new Promise<void>((resolve) => {
			releaseContinuation = resolve
		})
		coordinator.registerDetachedContinuation(async ({ resolve }) => {
			await continuationBarrier
			await resolve()
		})
		const task = {
			...createDispatchTask(runtime, coordinator),
			requestCancellation: Task.prototype.requestCancellation,
		} as unknown as Task

		await coordinator.respond({
			taskId: "task-1",
			turnId,
			interactionId,
			actionId: "reply",
			stateRevision: 3,
			draft: { text: "answer", images: [], files: [] },
		})
		const cancellation = task.requestCancellation()
		await vi.waitFor(() => expect(runtime.getState().phase).toBe(TaskPhase.CANCELLING))

		const beforeContinuationExit = await Promise.race([
			cancellation.then(() => "settled" as const),
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
		])
		expect(beforeContinuationExit).toBe("pending")
		expect(runtime.getState().interaction).toBeUndefined()

		releaseContinuation?.()
		await expect(cancellation).resolves.toMatchObject({ accepted: true })
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.PAUSED,
			interaction: { kind: "resume", status: "awaiting" },
		})
	})

	it("does not let a pre-Cancel API failure pause input admitted after Cancel completes", async () => {
		let signalInterruptedApiStarted: (() => void) | undefined
		const interruptedApiStarted = new Promise<void>((resolve) => {
			signalInterruptedApiStarted = resolve
		})
		let rejectInterruptedApi: ((error: Error) => void) | undefined
		const interruptedApi = new Promise<void>((_resolve, reject) => {
			rejectInterruptedApi = reject
		})
		let apiCall = 0
		const startApi = vi.fn(async () => {
			apiCall++
			if (apiCall !== 1) return
			signalInterruptedApiStarted?.()
			await interruptedApi
		})
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 1 } }),
			createPorts(startApi),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const task = createDispatchTask(runtime, coordinator)

		const interruptedDispatch = task.dispatchRuntime({ type: "API_RETRY_SCHEDULED", apiIndex: 2 })
		await interruptedApiStarted
		await task.dispatchRuntime({ type: "TASK_CANCEL_REQUESTED", source: "user" })
		await task.dispatchRuntime({
			type: "TASK_CANCELLED",
			resume: { turnId: "resume-turn", interactionId: "resume-1", presentation: "" },
		})

		const response = await dispatchInteraction(
			{ task } as never,
			DispatchInteractionRequest.create({
				taskInstanceId: "open-1",
				taskId: "task-1",
				turnId: "resume-turn",
				interactionId: "resume-1",
				actionId: "resume",
				stateRevision: runtime.getState().revision,
				draft: { text: "continue after Cancel", images: [], files: [] },
			}),
		)
		expect(response).toMatchObject({ accepted: true, result: "accepted" })
		expect(startApi).toHaveBeenCalledTimes(2)

		rejectInterruptedApi?.(new Error("old provider loop aborted late"))
		await expect(interruptedDispatch).resolves.toMatchObject({
			accepted: false,
			effectError: { effectType: "START_API", message: "old provider loop aborted late" },
		})
		expect(runtime.getState()).toMatchObject({ phase: TaskPhase.RESUMING })
		expect(runtime.getState().error).toBeUndefined()
	})

	it("does not rewrite an accepted direct input as a resume rejection when START_API later fails", async () => {
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 2 } }),
			createPorts(async () => {
				throw new Error("provider loop failed after admission")
			}),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const task = createDispatchTask(runtime, coordinator)
		let signalApiFailure: (() => void) | undefined
		const apiFailure = new Promise<void>((resolve) => {
			signalApiFailure = resolve
		})
		const unsubscribe = runtime.subscribe(() => {
			if (runtime.getState().error?.effectType === "START_API") signalApiFailure?.()
		})

		await task.dispatchRuntime({ type: "TASK_CANCEL_REQUESTED", source: "user" })
		await task.dispatchRuntime({
			type: "TASK_CANCELLED",
			resume: { turnId: "resume-turn", interactionId: "resume-1", presentation: "" },
		})

		const response = await dispatchInteraction(
			{ task } as never,
			DispatchInteractionRequest.create({
				taskInstanceId: "open-1",
				taskId: "task-1",
				turnId: "resume-turn",
				interactionId: "resume-1",
				actionId: "resume",
				stateRevision: runtime.getState().revision,
				draft: { text: "continue from input", images: [], files: [] },
			}),
		)
		await apiFailure
		unsubscribe()

		expect(response).toMatchObject({ accepted: true, result: "accepted" })
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.PAUSED,
			error: { effectType: "START_API", message: "provider loop failed after admission" },
		})
	})
})
