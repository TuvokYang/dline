import { describe, expect, it, vi } from "vitest"
import { BlockPhase } from "../../BlockPhaseMachine"
import { InteractionCoordinator, type InteractionOutcome } from "../../interaction/InteractionCoordinator"
import { TaskPhase } from "../../TaskPhase"
import type { TaskEffectPorts } from "../TaskEffectRunner"
import { TaskRuntime } from "../TaskRuntime"
import { createTaskRuntimeState } from "../TaskRuntimeState"

/** Create no-op ports that focused tests can override. */
function createPorts(overrides: Partial<TaskEffectPorts> = {}): TaskEffectPorts {
	return {
		postView: async () => {},
		persistSnapshot: async () => {},
		cancelRuntime: async () => {},
		prepareResume: async () => {},
		startApi: async () => {},
		executeTool: async () => {},
		appendSay: async () => {},
		appendAsk: async () => ({ uiMessageTs: 1 }),
		startNewTask: async () => {},
		...overrides,
	}
}

describe("TaskRuntime dispatch", () => {
	it("allows an executing tool to open a nested interaction without self-deadlocking", async () => {
		let runtime: TaskRuntime
		let coordinator: InteractionCoordinator
		let outcome: InteractionOutcome | undefined
		runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }),
				turn: {
					turnId: "turn-1",
					assistantApiIndex: 1,
					mode: "parallel",
					blocks: [
						{
							dlineTid: "tid-qna",
							functionId: "call-qna",
							toolName: "qna_respond",
							ts: 10,
							requiresApproval: false,
							conversationHistoryIndex: 1,
							phase: BlockPhase.AUTO_EXECUTING,
						},
					],
				},
			},
			createPorts({
				executeTool: async () => {
					outcome = await coordinator.open({
						turnId: "turn-1",
						interactionId: "tid-qna",
						kind: "qna_response",
						presentation: "Answer",
						existingTs: 10,
					})
				},
			}),
		)
		coordinator = new InteractionCoordinator(runtime)

		const execution = runtime.dispatch({
			type: "BLOCK_EXECUTION_STARTED",
			turnId: "turn-1",
			dlineTid: "tid-qna",
		})
		await vi.waitFor(() => expect(runtime.getState().interaction?.status).toBe("awaiting"))
		const awaiting = runtime.getState()
		const response = await runtime.dispatch({
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "tid-qna",
				actionId: "reply",
				stateRevision: awaiting.revision,
				draft: { text: "continue", images: [], files: [] },
			},
		})
		const result = await execution

		expect(result.accepted).toBe(true)
		expect(response.accepted).toBe(true)
		expect(outcome).toMatchObject({ actionId: "reply", draft: { text: "continue" } })
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.EXECUTING,
			interaction: undefined,
		})
	})

	it("allows a resumed API effect to dispatch its request lifecycle without self-deadlocking", async () => {
		let runtime: TaskRuntime
		let nestedAccepted = false
		runtime = new TaskRuntime(
			createTaskRuntimeState({
				taskId: "task-1",
				phase: TaskPhase.STREAMING,
				anchor: { apiIndex: 2 },
			}),
			createPorts({
				startApi: async (effect) => {
					const nested = await runtime.dispatch({ type: "API_REQUEST_STARTED", apiIndex: effect.apiIndex })
					nestedAccepted = nested.accepted
				},
			}),
		)

		const result = await runtime.dispatch({ type: "RESUME_API_CONTINUATION_REQUESTED", apiIndex: 2 })

		expect(result.accepted).toBe(true)
		expect(nestedAccepted).toBe(true)
		expect(runtime.getState()).toMatchObject({ phase: TaskPhase.STREAMING, anchor: { apiIndex: 2 } })
	})

	it("releases START_NEW_TASK admission before the new task terminates the current runtime", async () => {
		let runtime: TaskRuntime
		let signalStartNewTask: (() => void) | undefined
		const startNewTaskEntered = new Promise<void>((resolve) => {
			signalStartNewTask = resolve
		})
		let nestedTerminationAccepted = false
		runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.COMPLETED, revision: 5 }),
				completion: { completionId: "completion-1" },
				interaction: {
					taskId: "task-1",
					turnId: "turn-completion",
					interactionId: "completion-1",
					kind: "completion",
					status: "resolving",
					createdRevision: 4,
					anchor: { messageTs: 100, messageType: "ask" },
					acceptedResponse: {
						taskId: "task-1",
						turnId: "turn-completion",
						interactionId: "completion-1",
						actionId: "start_new_task",
						stateRevision: 5,
						draft: { text: "Next task", images: [], files: [] },
					},
				},
			},
			createPorts({
				startNewTask: async () => {
					signalStartNewTask?.()
					const terminated = await runtime.dispatch({ type: "TASK_TERMINATE_REQUESTED" })
					nestedTerminationAccepted = terminated.accepted
				},
			}),
		)

		let admitted: Awaited<ReturnType<TaskRuntime["dispatchAtAdmission"]>> | undefined
		const admission = runtime
			.dispatchAtAdmission({
				type: "TASK_CLEAR_REQUESTED",
				draft: { text: "Next task", images: [], files: [] },
			})
			.then((result) => {
				admitted = result
				return result
			})
		await startNewTaskEntered
		await Promise.resolve()
		await Promise.resolve()

		expect(admitted).toMatchObject({ accepted: true })
		await admission
		await vi.waitFor(() => expect(nestedTerminationAccepted).toBe(true))
		expect(runtime.getState().phase).toBe(TaskPhase.CANCELLING)
	})

	it("releases successor admission before its effect commits the consumed Task", async () => {
		let runtime: TaskRuntime
		let signalSuccessor: (() => void) | undefined
		const successorEntered = new Promise<void>((resolve) => {
			signalSuccessor = resolve
		})
		let nestedCommitAccepted = false
		runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.BETWEEN_TURNS, revision: 8 }),
			createPorts({
				startSuccessorTask: async (effect) => {
					signalSuccessor?.()
					const committed = await runtime.dispatch({
						type: "TASK_SUCCESSOR_START_COMMITTED",
						source: effect.handoff.source,
					})
					nestedCommitAccepted = committed.accepted
				},
			}),
		)

		let admitted: Awaited<ReturnType<TaskRuntime["dispatchAtAdmission"]>> | undefined
		const admission = runtime
			.dispatchAtAdmission({
				type: "TASK_SUCCESSOR_REQUESTED",
				handoff: {
					context: "next task",
					source: { functionId: "function-new-task", dlineTid: "tid-new-task" },
					initialUserContent: [],
					taskSettings: { mode: "act", actModeProfile: "act-profile" },
				},
			})
			.then((result) => {
				admitted = result
				return result
			})

		await successorEntered
		await Promise.resolve()
		await Promise.resolve()

		expect(admitted).toMatchObject({ accepted: true })
		await admission
		await vi.waitFor(() => expect(nestedCommitAccepted).toBe(true))
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.ABORTED,
			newTaskConsumed: { functionId: "function-new-task", dlineTid: "tid-new-task" },
		})
	})

	it("commits next state before running effects in order", async () => {
		const order: string[] = []
		let runtime: TaskRuntime
		runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }),
			createPorts({
				postView: async () => {
					order.push(`view:${runtime.getState().phase}`)
				},
				cancelRuntime: async () => {
					order.push("cancel")
				},
				persistSnapshot: async () => {
					order.push("snapshot")
				},
			}),
		)
		runtime.setCommitObserver((event, state) => order.push(`commit:${event}:${state.phase}`))
		order.length = 0

		const result = await runtime.dispatch({ type: "TASK_CANCEL_REQUESTED", source: "user" })

		expect(result.accepted).toBe(true)
		expect(order).toEqual(["commit:TASK_CANCEL_REQUESTED:cancelling", "view:cancelling", "cancel", "snapshot"])
	})

	it("serializes concurrent dispatches", async () => {
		const order: string[] = []
		let releaseCancel: (() => void) | undefined
		const cancelBarrier = new Promise<void>((resolve) => {
			releaseCancel = resolve
		})
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }),
			createPorts({
				postView: async () => {
					order.push("view")
				},
				cancelRuntime: async () => {
					order.push("cancel:start")
					await cancelBarrier
					order.push("cancel:end")
				},
				persistSnapshot: async () => {
					order.push("snapshot")
				},
			}),
		)

		const cancel = runtime.dispatch({ type: "TASK_CANCEL_REQUESTED", source: "user" })
		const cancelled = runtime.dispatch({ type: "TASK_CANCELLED" })
		await vi.waitFor(() => expect(order).toContain("cancel:start"))
		expect(runtime.getState().phase).toBe(TaskPhase.CANCELLING)
		releaseCancel?.()
		await Promise.all([cancel, cancelled])

		expect(runtime.getState().phase).toBe(TaskPhase.PAUSED)
		expect(order).toEqual(["view", "cancel:start", "cancel:end", "snapshot", "view", "snapshot"])
	})

	it("commits an ask anchor returned by the append effect", async () => {
		const appendAsk = vi.fn(async () => ({ uiMessageTs: 100 }))
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }),
			createPorts({ appendAsk }),
		)

		const result = await runtime.dispatch({
			type: "INTERACTION_OPEN_REQUESTED",
			turnId: "turn-1",
			interactionId: "interaction-1",
			kind: "qna_response",
			presentation: JSON.stringify({ response: "Answer" }),
			existingTs: 100,
		})

		expect(result.accepted).toBe(true)
		expect(appendAsk).toHaveBeenCalledWith(
			expect.objectContaining({ interactionId: "interaction-1", taskAsk: "qna_respond", existingTs: 100 }),
		)
		expect(runtime.getState()).toMatchObject({
			revision: 2,
			interaction: {
				interactionId: "interaction-1",
				status: "awaiting",
				anchor: { messageTs: 100, messageType: "ask" },
			},
		})
	})

	it("runs one persisted-request continuation and rejects a duplicate dispatch", async () => {
		const interactionId = "resume:task-1:3:8"
		const startApi = vi.fn(async () => undefined)
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.PAUSED,
					revision: 8,
					anchor: { apiIndex: 3, turnId: interactionId, interactionId },
				}),
				interaction: {
					taskId: "task-1",
					turnId: interactionId,
					interactionId,
					kind: "resume",
					status: "resolving",
					createdRevision: 7,
					persistedRequest: true,
					anchor: { messageTs: 321, messageType: "ask" },
					acceptedResponse: {
						taskId: "task-1",
						turnId: interactionId,
						interactionId,
						actionId: "resume",
						stateRevision: 8,
						draft: { text: "", images: [], files: [] },
					},
				},
			},
			createPorts({ startApi }),
		)
		const event = {
			type: "PERSISTED_API_REQUEST_CONTINUATION_REQUESTED" as const,
			interactionId,
			apiIndex: 3,
		}

		const result = await runtime.dispatch(event)
		const repeated = await runtime.dispatch(event)

		expect(result.accepted).toBe(true)
		expect(repeated.accepted).toBe(false)
		expect(startApi).toHaveBeenCalledOnce()
		expect(startApi).toHaveBeenCalledWith(expect.objectContaining({ apiIndex: 3, persistedRequest: true }))
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.RESUMING,
			interaction: { kind: "resume", status: "resolving", persistedRequest: true },
		})

		const admitted = await runtime.dispatch({ type: "API_REQUEST_STARTED", apiIndex: 3 })
		expect(admitted.accepted).toBe(true)
		expect(runtime.getState()).toMatchObject({ phase: TaskPhase.STREAMING })
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it("awaits the completed view and rejects a repeated completion presentation without republishing", async () => {
		let releaseCompletedView: (() => void) | undefined
		const completedViewGate = new Promise<void>((resolve) => {
			releaseCompletedView = resolve
		})
		const completedViews: Array<{ phase: TaskPhase; interactionStatus?: string }> = []
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.EXECUTING }),
			createPorts({
				postView: async (state) => {
					completedViews.push({ phase: state.phase, interactionStatus: state.interaction?.status })
					await completedViewGate
				},
			}),
		)
		const event = {
			type: "ATTEMPT_COMPLETION_PRESENTED" as const,
			completionId: "completion-1",
			turnId: "turn-completion",
			interactionId: "completion-1",
			presentation: "done",
		}
		let dispatchSettled = false
		const completion = runtime.dispatch(event).then((result) => {
			dispatchSettled = true
			return result
		})

		await vi.waitFor(() => expect(completedViews).toEqual([{ phase: TaskPhase.COMPLETED, interactionStatus: "awaiting" }]))
		expect(dispatchSettled).toBe(false)
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.COMPLETED,
			completion: { completionId: "completion-1" },
			interaction: { kind: "completion", interactionId: "completion-1", status: "awaiting" },
		})
		releaseCompletedView?.()
		const accepted = await completion
		expect(accepted.accepted).toBe(true)
		const revision = runtime.getState().revision

		const repeated = await runtime.dispatch(event)

		expect(repeated.accepted).toBe(false)
		expect(repeated.effects).toEqual([])
		expect(runtime.getState().revision).toBe(revision)
		expect(completedViews).toEqual([{ phase: TaskPhase.COMPLETED, interactionStatus: "awaiting" }])
	})

	it("notifies observers after a causal response is committed", async () => {
		const observed: string[] = []
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.AWAITING_APPROVAL, revision: 4 }),
				interaction: {
					taskId: "task-1",
					turnId: "turn-1",
					interactionId: "interaction-1",
					kind: "tool_approval",
					status: "awaiting",
					createdRevision: 4,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			createPorts(),
		)
		const unsubscribe = runtime.subscribe((event, result) => {
			if (event.type === "INTERACTION_RESPONDED" && result.accepted) {
				observed.push(event.response.actionId)
			}
		})

		await runtime.dispatch({
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: 4,
				draft: { text: "", images: [], files: [] },
			},
		})
		unsubscribe()

		expect(observed).toEqual(["approve"])
	})

	it("does not release an approved interaction until its resolving snapshot is durable", async () => {
		let releasePersistence: (() => void) | undefined
		const persistenceGate = new Promise<void>((resolve) => {
			releasePersistence = resolve
		})
		const persistSnapshot = vi.fn(async () => {
			await persistenceGate
		})
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.AWAITING_APPROVAL,
					revision: 4,
					anchor: { apiIndex: 1, uiMessageTs: 100, turnId: "turn-1", interactionId: "interaction-1" },
				}),
				turn: {
					turnId: "turn-1",
					assistantApiIndex: 1,
					mode: "serial",
					activeDlineTid: "interaction-1",
					blocks: [
						{
							dlineTid: "interaction-1",
							functionId: "function-1",
							toolName: "read_file",
							ts: 100,
							requiresApproval: false,
							conversationHistoryIndex: 1,
							phase: BlockPhase.AWAITING_APPROVAL,
						},
					],
				},
				interaction: {
					taskId: "task-1",
					turnId: "turn-1",
					interactionId: "interaction-1",
					kind: "tool_approval",
					status: "awaiting",
					createdRevision: 4,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			createPorts({ persistSnapshot }),
		)
		const coordinator = new InteractionCoordinator(runtime)
		let continuationReleased = false
		const continuation = coordinator
			.open({
				turnId: "turn-1",
				interactionId: "interaction-1",
				kind: "tool_approval",
				presentation: "Read file?",
				existingTs: 100,
			})
			.then((outcome) => {
				continuationReleased = true
				return outcome
			})
		const response = runtime.dispatch({
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: 4,
				draft: { text: "", images: [], files: [] },
			},
		})

		await vi.waitFor(() => expect(persistSnapshot).toHaveBeenCalledOnce())
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.EXECUTING,
			interaction: { interactionId: "interaction-1", status: "resolving" },
		})
		expect(continuationReleased).toBe(false)

		releasePersistence?.()
		expect((await response).accepted).toBe(true)
		expect(await continuation).toMatchObject({ actionId: "approve" })
		expect(continuationReleased).toBe(true)
	})

	it("returns a caller-visible failure when cancellation effects fail", async () => {
		const postView = vi.fn(async () => {})
		const persistSnapshot = vi.fn(async () => {})
		const appendAsk = vi.fn(async () => ({ uiMessageTs: 101 }))
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }),
			createPorts({
				postView,
				persistSnapshot,
				cancelRuntime: async () => {
					throw new Error("cancel failed")
				},
				appendAsk,
			}),
		)

		const result = await runtime.dispatch({ type: "TASK_CANCEL_REQUESTED", source: "user" })

		expect(result).toMatchObject({
			accepted: false,
			effectError: { effectType: "CANCEL_RUNTIME", message: "cancel failed" },
		})
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.PAUSED,
			error: { effectType: "CANCEL_RUNTIME", message: "cancel failed" },
			interaction: { kind: "resume", status: "awaiting", anchor: { messageTs: 101, messageType: "ask" } },
		})
		expect(appendAsk).toHaveBeenCalledOnce()
	})

	it("returns a caller-visible failure when presenting an interaction fails", async () => {
		const postView = vi.fn(async () => {})
		const persistSnapshot = vi.fn(async () => {})
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }),
			createPorts({
				postView,
				persistSnapshot,
				appendAsk: async () => {
					throw new Error("ask failed")
				},
			}),
		)

		const result = await runtime.dispatch({
			type: "INTERACTION_OPEN_REQUESTED",
			turnId: "turn-1",
			interactionId: "interaction-1",
			kind: "qna_response",
			presentation: "Answer",
		})

		expect(result).toMatchObject({
			accepted: false,
			effectError: { effectType: "APPEND_ASK", message: "ask failed" },
		})
		expect(runtime.getState().phase).toBe(TaskPhase.PAUSED)
		expect(runtime.getState().interaction).toMatchObject({ kind: "resume", status: "opening" })
		expect(postView).toHaveBeenCalledTimes(1)
		expect(persistSnapshot).toHaveBeenCalledTimes(1)
	})

	it("retains an accepted Resume response when feedback presentation fails before API admission", async () => {
		const draft = { text: "continue after cancel", images: [], files: [] }
		const startApi = vi.fn(async () => undefined)
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.PAUSED,
					revision: 5,
					anchor: { apiIndex: 2, uiMessageTs: 100, turnId: "resume-turn", interactionId: "resume-1" },
				}),
				interaction: {
					taskId: "task-1",
					turnId: "resume-turn",
					interactionId: "resume-1",
					kind: "resume",
					status: "resolving",
					createdRevision: 4,
					anchor: { messageTs: 100, messageType: "ask" },
					acceptedResponse: {
						taskId: "task-1",
						turnId: "resume-turn",
						interactionId: "resume-1",
						actionId: "resume",
						stateRevision: 5,
						draft,
					},
				},
			},
			createPorts({
				appendSay: async () => {
					throw new Error("feedback flush failed")
				},
				startApi,
			}),
		)
		const coordinator = new InteractionCoordinator(runtime)

		await expect(coordinator.resumeExisting("resume-1")).rejects.toThrow("Resume continuation rejected")

		expect(startApi).not.toHaveBeenCalled()
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.PAUSED,
			error: { effectType: "APPEND_SAY", message: "feedback flush failed" },
			interaction: {
				interactionId: "resume-1",
				status: "awaiting",
				acceptedResponse: { actionId: "resume", draft },
			},
		})
	})

	it("does not recurse when snapshot persistence fails", async () => {
		const postView = vi.fn(async () => {})
		const persistSnapshot = vi.fn(async () => {
			throw new Error("snapshot failed")
		})
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }),
			createPorts({ postView, persistSnapshot }),
		)

		const result = await runtime.dispatch({ type: "TASK_CANCEL_REQUESTED", source: "user" })

		expect(result).toMatchObject({
			accepted: false,
			effectError: { effectType: "PERSIST_SNAPSHOT", message: "snapshot failed" },
		})
		expect(persistSnapshot).toHaveBeenCalledTimes(1)
		expect(postView).toHaveBeenCalledTimes(2)
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.PAUSED,
			error: { effectType: "PERSIST_SNAPSHOT", message: "snapshot failed" },
		})
	})

	it("persists recovery without retrying a failed view projection", async () => {
		const postView = vi.fn(async () => {
			throw new Error("view failed")
		})
		const persistSnapshot = vi.fn(async () => {})
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }),
			createPorts({ postView, persistSnapshot }),
		)

		const result = await runtime.dispatch({ type: "TASK_CANCEL_REQUESTED", source: "user" })

		expect(result).toMatchObject({
			accepted: false,
			effectError: { effectType: "POST_TASK_VIEW", message: "view failed" },
		})
		expect(postView).toHaveBeenCalledTimes(1)
		expect(persistSnapshot).toHaveBeenCalledTimes(2)
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.PAUSED,
			error: { effectType: "POST_TASK_VIEW", message: "view failed" },
		})
	})

	it("does not run effects for a rejected event", async () => {
		const postView = vi.fn(async () => {})
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.IDLE }),
			createPorts({ postView }),
		)

		const result = await runtime.dispatch({ type: "TASK_CANCEL_REQUESTED", source: "user" })

		expect(result).toMatchObject({ accepted: false, error: { code: "invalid_runtime_event" } })
		expect(postView).not.toHaveBeenCalled()
		expect(runtime.getState().phase).toBe(TaskPhase.IDLE)
	})
})
