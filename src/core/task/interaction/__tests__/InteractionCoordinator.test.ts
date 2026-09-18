import { describe, expect, it, vi } from "vitest"
import { BlockPhase } from "../../BlockPhaseMachine"
import type { TaskEffectPorts } from "../../runtime/TaskEffectRunner"
import { TaskRuntime } from "../../runtime/TaskRuntime"
import { createTaskRuntimeState, type TurnState } from "../../runtime/TaskRuntimeState"
import { TaskPhase } from "../../TaskPhase"
import { createSnapshot, hydrateSnapshot } from "../../TaskSnapshot"
import type { InteractionKind } from "../Interaction"
import { InteractionCoordinator } from "../InteractionCoordinator"
import { getInteraction, INTERACTION_KINDS } from "../InteractionRegistry"
import type { InteractionResponse } from "../InteractionResponse"

/** Create no-op runtime ports for coordinator tests. */
function createPorts(overrides: Partial<TaskEffectPorts> = {}): TaskEffectPorts {
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
		...overrides,
	}
}

/** Recreate the exact crash window after response persistence and before continuation commit. */
function hydrateResolvingInteraction(input: {
	kind: InteractionKind
	phase: TaskPhase
	turnId: string
	interactionId: string
	response: InteractionResponse
	apiIndex?: number
}) {
	const state = {
		...createTaskRuntimeState({
			taskId: "task-1",
			phase: input.phase,
			revision: input.response.stateRevision + 1,
			anchor: { apiIndex: input.apiIndex ?? -1, turnId: input.turnId, interactionId: input.interactionId },
		}),
		interaction: {
			taskId: "task-1",
			turnId: input.turnId,
			interactionId: input.interactionId,
			kind: input.kind,
			status: "resolving" as const,
			createdRevision: input.response.stateRevision,
			anchor: { messageTs: 100, messageType: "ask" as const },
			acceptedResponse: input.response,
		},
	}
	return hydrateSnapshot(createSnapshot(state))
}

/** Recreate a stopped historical interaction before the user clicks its original action. */
function hydrateAwaitingInteraction(input: {
	kind: InteractionKind
	phase: TaskPhase
	turnId: string
	interactionId: string
	apiIndex?: number
	turn?: TurnState
}) {
	const state = {
		...createTaskRuntimeState({
			taskId: "task-1",
			phase: input.phase,
			revision: 5,
			anchor: {
				apiIndex: input.apiIndex ?? 2,
				uiMessageTs: 100,
				turnId: input.turnId,
				interactionId: input.interactionId,
			},
		}),
		...(input.turn ? { turn: input.turn } : {}),
		...(input.kind === "completion" ? { completion: { completionId: input.interactionId } } : {}),
		interaction: {
			taskId: "task-1",
			turnId: input.turnId,
			interactionId: input.interactionId,
			kind: input.kind,
			status: "awaiting" as const,
			createdRevision: 4,
			anchor: { messageTs: 100, messageType: "ask" as const },
		},
	}
	return hydrateSnapshot(createSnapshot(state))
}

describe("InteractionCoordinator", () => {
	it("notifies a durable turn-ending awaiting boundary without waiting for the user response", async () => {
		const runtime = new TaskRuntime(createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }), createPorts())
		const onAwaitingUserDurable = vi.fn()
		const coordinator = new InteractionCoordinator(runtime, { onAwaitingUserDurable })
		let settled = false
		const outcomePromise = coordinator
			.open({
				turnId: "turn:tid-qna",
				interactionId: "tid-qna",
				kind: "qna_response",
				presentation: JSON.stringify({ response: "Answer" }),
			})
			.finally(() => {
				settled = true
			})

		await vi.waitFor(() => expect(runtime.getState().interaction?.status).toBe("awaiting"))
		expect(onAwaitingUserDurable).toHaveBeenCalledWith({
			turnId: "turn:tid-qna",
			interactionId: "tid-qna",
			kind: "qna_response",
		})
		expect(settled).toBe(false)

		const revision = runtime.getState().revision
		await runtime.dispatch({
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn:tid-qna",
				interactionId: "tid-qna",
				actionId: "reply",
				stateRevision: revision,
				draft: { text: "Continue", images: [], files: [] },
			},
		})
		await outcomePromise
	})

	it("does not notify the complete-execution hook for ordinary approval interactions", async () => {
		const runtime = new TaskRuntime(createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }), createPorts())
		const onAwaitingUserDurable = vi.fn()
		const coordinator = new InteractionCoordinator(runtime, { onAwaitingUserDurable })
		const outcomePromise = coordinator.open({
			turnId: "turn:tid-tool",
			interactionId: "tid-tool",
			kind: "tool_approval",
			presentation: "Approve tool",
		})
		await vi.waitFor(() => expect(runtime.getState().interaction?.status).toBe("awaiting"))
		expect(onAwaitingUserDurable).not.toHaveBeenCalled()

		expect(coordinator.cancelPendingInteraction("tid-tool", "test_complete")).toBe(true)
		await expect(outcomePromise).rejects.toThrow("test_complete")
	})

	it("continues a live plan interaction with an empty causal mode-switch response", async () => {
		const runtime = new TaskRuntime(createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }), createPorts())
		const coordinator = new InteractionCoordinator(runtime)
		const outcomePromise = coordinator.open({
			turnId: "turn-mode-switch",
			interactionId: "plan-mode-switch",
			kind: "make_plan",
			presentation: "Plan ready",
		})
		await vi.waitFor(() => expect(runtime.getState().interaction?.status).toBe("awaiting"))

		expect(coordinator.canRespondForModeSwitch()).toBe(true)
		await expect(coordinator.respondForModeSwitch({ text: "", images: [], files: [] })).resolves.toBe(true)
		await expect(outcomePromise).resolves.toMatchObject({
			actionId: "reply",
			draft: { text: "", images: [], files: [] },
		})
		expect(runtime.getState().phase).toBe(TaskPhase.STREAMING)
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it("waits for one causal response and resolves the active interaction", async () => {
		const runtime = new TaskRuntime(createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }), createPorts())
		const coordinator = new InteractionCoordinator(runtime)

		const outcomePromise = coordinator.open({
			turnId: "turn-1",
			interactionId: "interaction-1",
			kind: "qna_response",
			presentation: JSON.stringify({ response: "Answer" }),
			existingTs: 100,
		})
		await vi.waitFor(() => expect(runtime.getState().interaction?.status).toBe("awaiting"))
		const revision = runtime.getState().revision

		await runtime.dispatch({
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "reply",
				stateRevision: revision,
				draft: { text: "Continue", images: ["image-1"], files: ["file-1"] },
			},
		})

		await expect(outcomePromise).resolves.toEqual({
			actionId: "reply",
			draft: { text: "Continue", images: ["image-1"], files: ["file-1"] },
			selection: undefined,
		})
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it("continues a generic handler from a hydrated resolving response without waiting again", async () => {
		const interactionId = "qna-crash"
		const turnId = "qna-turn"
		const response: InteractionResponse = {
			taskId: "task-1",
			turnId,
			interactionId,
			actionId: "reply",
			stateRevision: 4,
			draft: { text: "Recovered", images: [], files: [] },
		}
		const runtime = new TaskRuntime(
			hydrateResolvingInteraction({ kind: "qna_response", phase: TaskPhase.STREAMING, turnId, interactionId, response }),
			createPorts(),
		)

		await expect(
			new InteractionCoordinator(runtime).open({
				turnId,
				interactionId,
				kind: "qna_response",
				presentation: "Question",
			}),
		).resolves.toMatchObject({ actionId: "reply", draft: response.draft })
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it("does not consume a detached handler response before Task registers its continuation", async () => {
		const runtime = new TaskRuntime(
			hydrateAwaitingInteraction({
				kind: "qna_response",
				phase: TaskPhase.EXECUTING,
				turnId: "turn-qna",
				interactionId: "qna-1",
			}),
			createPorts(),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const revision = runtime.getState().revision

		await expect(
			coordinator.respond({
				taskId: "task-1",
				turnId: "turn-qna",
				interactionId: "qna-1",
				actionId: "reply",
				stateRevision: revision,
				draft: { text: "Answer", images: [], files: [] },
			}),
		).rejects.toThrow("Detached continuation is not registered")
		expect(runtime.getState()).toMatchObject({
			revision,
			interaction: { interactionId: "qna-1", kind: "qna_response", status: "awaiting" },
		})
	})

	it("continues and resolves the original detached conversation interaction after its click", async () => {
		const runtime = new TaskRuntime(
			hydrateAwaitingInteraction({
				kind: "qna_response",
				phase: TaskPhase.EXECUTING,
				turnId: "turn-qna",
				interactionId: "qna-1",
			}),
			createPorts(),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const continuation = vi.fn(async () => undefined)
		coordinator.registerDetachedContinuation(continuation)

		const result = await coordinator.respond({
			taskId: "task-1",
			turnId: "turn-qna",
			interactionId: "qna-1",
			actionId: "reply",
			stateRevision: runtime.getState().revision,
			draft: { text: "Answer", images: ["image"], files: ["file"] },
		})

		expect(result.accepted).toBe(true)
		await coordinator.waitForClaimedContinuations()
		expect(continuation).toHaveBeenCalledOnce()
		expect(continuation).toHaveBeenCalledWith(
			expect.objectContaining({
				interaction: expect.objectContaining({
					kind: "qna_response",
					turnId: "turn-qna",
					interactionId: "qna-1",
					status: "resolving",
				}),
				outcome: {
					actionId: "reply",
					draft: { text: "Answer", images: ["image"], files: ["file"] },
					selection: undefined,
				},
				resolve: expect.any(Function),
			}),
		)
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it.each([
		{
			actionId: "approve" as const,
			expectedPhase: BlockPhase.EXECUTING,
			initialSiblingPhase: BlockPhase.STREAMING,
			siblingPhase: BlockPhase.STREAMING,
		},
		{
			actionId: "reject" as const,
			expectedPhase: BlockPhase.REJECTED,
			initialSiblingPhase: BlockPhase.AUTO_EXECUTING,
			siblingPhase: BlockPhase.SKIPPED,
		},
	])("propagates detached approval action $actionId into the canonical runtime block", async (testCase) => {
		const turnId = "turn-tools"
		const interactionId = "tid-write"
		const turn: TurnState = {
			turnId,
			assistantApiIndex: 2,
			mode: "serial",
			activeDlineTid: interactionId,
			approval: {
				manual: { dlineTid: interactionId, stage: "admission" },
				automatic: testCase.actionId === "reject" ? ["tid-second"] : [],
			},
			executing: [],
			blocks: [
				{
					dlineTid: interactionId,
					functionId: "function-write",
					toolName: "write_to_file",
					phase: BlockPhase.AWAITING_APPROVAL,
					ts: 100,
					requiresApproval: true,
					conversationHistoryIndex: 2,
				},
				{
					dlineTid: "tid-second",
					functionId: "function-second",
					toolName: "execute_command",
					phase: testCase.initialSiblingPhase,
					ts: 101,
					requiresApproval: true,
					conversationHistoryIndex: 2,
				},
			],
		}
		const runtime = new TaskRuntime(
			hydrateAwaitingInteraction({
				kind: "tool_approval",
				phase: TaskPhase.AWAITING_APPROVAL,
				turnId,
				interactionId,
				turn,
			}),
			createPorts(),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const continuation = vi.fn(async () => undefined)
		coordinator.registerDetachedContinuation(continuation)

		const result = await coordinator.respond({
			taskId: "task-1",
			turnId,
			interactionId,
			actionId: testCase.actionId,
			stateRevision: runtime.getState().revision,
			draft: { text: "", images: [], files: [] },
		})

		expect(result.accepted).toBe(true)
		await coordinator.waitForClaimedContinuations()
		expect(continuation).toHaveBeenCalledWith(
			expect.objectContaining({
				interaction: expect.objectContaining({ interactionId, kind: "tool_approval" }),
				outcome: expect.objectContaining({ actionId: testCase.actionId }),
			}),
		)
		expect(runtime.getState().turn?.blocks).toMatchObject([
			{ dlineTid: interactionId, phase: testCase.expectedPhase },
			{ dlineTid: "tid-second", phase: testCase.siblingPhase },
		])
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it("accepts the opening revision after an unrelated sibling advances runtime state", async () => {
		const turnId = "turn-tools"
		const interactionId = "tid-write"
		const hydrated = hydrateAwaitingInteraction({
			kind: "tool_approval",
			phase: TaskPhase.AWAITING_APPROVAL,
			turnId,
			interactionId,
			turn: {
				turnId,
				assistantApiIndex: 2,
				mode: "parallel",
				activeDlineTid: interactionId,
				blocks: [
					{
						dlineTid: interactionId,
						functionId: "function-write",
						toolName: "write_to_file",
						phase: BlockPhase.AWAITING_APPROVAL,
						ts: 100,
						requiresApproval: true,
						conversationHistoryIndex: 2,
					},
				],
			},
		})
		const openingRevision = hydrated.interaction?.createdRevision ?? hydrated.revision
		hydrated.revision += 2
		const runtime = new TaskRuntime(hydrated, createPorts())
		const coordinator = new InteractionCoordinator(runtime)
		coordinator.registerDetachedContinuation(vi.fn(async () => undefined))

		const result = await coordinator.respond({
			taskId: "task-1",
			turnId,
			interactionId,
			actionId: "approve",
			stateRevision: openingRevision,
			draft: { text: "", images: [], files: [] },
		})

		expect(result.accepted).toBe(true)
		expect(runtime.getState().turn?.blocks[0]).toMatchObject({ phase: BlockPhase.EXECUTING })
	})

	it("commits detached completion feedback through the completion event", async () => {
		const runtime = new TaskRuntime(
			hydrateAwaitingInteraction({
				kind: "completion",
				phase: TaskPhase.COMPLETED,
				turnId: "turn-completion",
				interactionId: "completion-1",
			}),
			createPorts(),
		)
		const coordinator = new InteractionCoordinator(runtime)

		const result = await coordinator.respond({
			taskId: "task-1",
			turnId: "turn-completion",
			interactionId: "completion-1",
			actionId: "reply",
			stateRevision: runtime.getState().revision,
			draft: { text: "Refine", images: [], files: [] },
		})

		expect(result.accepted).toBe(true)
		expect(runtime.getState()).toMatchObject({ phase: TaskPhase.STREAMING })
		expect(runtime.getState().interaction).toBeUndefined()
		expect(runtime.getState().completion).toBeUndefined()
	})

	it("commits detached completion Start New Task without exposing Resume", async () => {
		let releaseStartNewTask: (() => void) | undefined
		const startNewTaskLifecycle = new Promise<void>((resolve) => {
			releaseStartNewTask = resolve
		})
		let signalStartNewTask: (() => void) | undefined
		const startNewTaskEntered = new Promise<void>((resolve) => {
			signalStartNewTask = resolve
		})
		const startNewTask = vi.fn(async () => {
			signalStartNewTask?.()
			await startNewTaskLifecycle
		})
		const runtime = new TaskRuntime(
			hydrateAwaitingInteraction({
				kind: "completion",
				phase: TaskPhase.COMPLETED,
				turnId: "turn-completion",
				interactionId: "completion-1",
			}),
			createPorts({ startNewTask }),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const draft = { text: "Next", images: [], files: [] }

		let result: Awaited<ReturnType<InteractionCoordinator["respond"]>> | undefined
		const response = coordinator
			.respond({
				taskId: "task-1",
				turnId: "turn-completion",
				interactionId: "completion-1",
				actionId: "start_new_task",
				stateRevision: runtime.getState().revision,
				draft,
			})
			.then((value) => {
				result = value
				return value
			})
		await startNewTaskEntered

		try {
			await vi.waitFor(() => expect(result).toMatchObject({ accepted: true }), { timeout: 250 })
			expect(startNewTask).toHaveBeenCalledWith(expect.objectContaining({ type: "START_NEW_TASK", draft }))
			expect(runtime.getState().phase).toBe(TaskPhase.COMPLETED)
			expect(runtime.getState().interaction).toBeUndefined()
		} finally {
			releaseStartNewTask?.()
			await response
		}
	})

	it("returns an admitted retry and reopens Retry when START_API fails asynchronously", async () => {
		let runtime: TaskRuntime
		let attempts = 0
		const startApi = vi.fn(async () => {
			attempts++
			const started = await runtime.dispatch({ type: "API_REQUEST_STARTED", apiIndex: 7 })
			expect(started.accepted).toBe(true)
			if (attempts === 1) {
				throw new Error("provider failed after retry admission")
			}
		})
		runtime = new TaskRuntime(
			hydrateAwaitingInteraction({
				kind: "error_retry",
				phase: TaskPhase.AWAITING_APPROVAL,
				turnId: "turn-retry",
				interactionId: "retry-1",
				apiIndex: 7,
			}),
			createPorts({ startApi }),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const draft = { text: "Retry context", images: [], files: [] }

		await expect(
			coordinator.respond({
				taskId: "task-1",
				turnId: "turn-retry",
				interactionId: "retry-1",
				actionId: "retry",
				stateRevision: runtime.getState().revision,
				draft,
			}),
		).resolves.toMatchObject({ accepted: true })
		await vi.waitFor(() => expect(runtime.getState().error?.effectType).toBe("START_API"))

		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.AWAITING_APPROVAL,
			interaction: {
				kind: "error_retry",
				status: "awaiting",
				interactionId: "retry-1",
				acceptedResponse: { actionId: "retry", draft },
			},
			error: { effectType: "START_API", message: "provider failed after retry admission" },
		})

		await expect(
			coordinator.respond({
				taskId: "task-1",
				turnId: "turn-retry",
				interactionId: "retry-1",
				actionId: "retry",
				stateRevision: runtime.getState().revision,
				draft: { text: "Retry again", images: [], files: [] },
			}),
		).resolves.toMatchObject({ accepted: true })
		await vi.waitFor(() => expect(startApi).toHaveBeenCalledTimes(2))
		expect(runtime.getState()).toMatchObject({ phase: TaskPhase.STREAMING, interaction: undefined })
		expect(runtime.getState().error).toBeUndefined()
	})

	it("commits detached error retry from the historical API index and retains identity until admission", async () => {
		const startApi = vi.fn(async () => undefined)
		const runtime = new TaskRuntime(
			hydrateAwaitingInteraction({
				kind: "error_retry",
				phase: TaskPhase.AWAITING_APPROVAL,
				turnId: "turn-retry",
				interactionId: "retry-1",
				apiIndex: 7,
			}),
			createPorts({ startApi }),
		)
		const coordinator = new InteractionCoordinator(runtime)

		const result = await coordinator.respond({
			taskId: "task-1",
			turnId: "turn-retry",
			interactionId: "retry-1",
			actionId: "retry",
			stateRevision: runtime.getState().revision,
			draft: { text: "Retry context", images: [], files: [] },
		})

		expect(result.accepted).toBe(true)
		expect(startApi).toHaveBeenCalledWith(expect.objectContaining({ type: "START_API", apiIndex: 7 }))
		expect(runtime.getState().interaction).toMatchObject({
			kind: "error_retry",
			status: "resolving",
			interactionId: "retry-1",
		})

		const admitted = await runtime.dispatch({ type: "API_REQUEST_STARTED", apiIndex: 7 })
		expect(admitted.accepted).toBe(true)
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it("continues resume from a hydrated resolving response without duplicate user input", async () => {
		const interactionId = "resume-crash"
		const turnId = "resume-turn"
		const response: InteractionResponse = {
			taskId: "task-1",
			turnId,
			interactionId,
			actionId: "resume",
			stateRevision: 4,
			draft: { text: "Continue", images: [], files: [] },
		}
		const runtime = new TaskRuntime(
			hydrateResolvingInteraction({
				kind: "resume",
				phase: TaskPhase.PAUSED,
				turnId,
				interactionId,
				response,
				apiIndex: 2,
			}),
			createPorts(),
		)

		await expect(new InteractionCoordinator(runtime).resumeExisting(interactionId)).resolves.toMatchObject({
			actionId: "resume",
		})
		expect(runtime.getState().phase).toBe(TaskPhase.RESUMING)
		expect(runtime.getState().interaction).toMatchObject({
			kind: "resume",
			status: "resolving",
			interactionId,
			acceptedResponse: { actionId: "resume", draft: response.draft },
		})

		const admitted = await runtime.dispatch({ type: "API_REQUEST_STARTED", apiIndex: 2 })
		expect(admitted.accepted).toBe(true)
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.STREAMING,
			anchor: { apiIndex: 2, interactionId: undefined },
		})
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it("hands an accepted Resume continuation to a subsequent request gate", async () => {
		const interactionId = "resume-request-gate"
		const turnId = "resume-turn"
		const response: InteractionResponse = {
			taskId: "task-1",
			turnId,
			interactionId,
			actionId: "resume",
			stateRevision: 4,
			draft: { text: "Continue", images: [], files: [] },
		}
		const runtime = new TaskRuntime(
			hydrateResolvingInteraction({
				kind: "resume",
				phase: TaskPhase.RESUMING,
				turnId,
				interactionId,
				response,
				apiIndex: 2,
			}),
			createPorts(),
		)
		const coordinator = new InteractionCoordinator(runtime)

		await expect(coordinator.releaseApiContinuationForRequestGate()).resolves.toBe(true)
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.RESUMING,
			interaction: undefined,
			anchor: { apiIndex: 2 },
		})

		const approval = coordinator.open({
			turnId: "hosted-web:task-1:2",
			interactionId: "hosted-web:task-1:2",
			kind: "hosted_web_approval",
			presentation: "Hosted Web approval",
		})
		await vi.waitFor(() => {
			expect(runtime.getState()).toMatchObject({
				phase: TaskPhase.AWAITING_APPROVAL,
				interaction: {
					kind: "hosted_web_approval",
					status: "awaiting",
				},
			})
		})
		await runtime.dispatch({
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "hosted-web:task-1:2",
				interactionId: "hosted-web:task-1:2",
				actionId: "approve",
				stateRevision: runtime.getState().revision,
				draft: { text: "", images: [], files: [] },
			},
		})
		await expect(approval).resolves.toMatchObject({ actionId: "approve" })
	})

	it("retires an accepted Resume continuation reopened after START_API failure", async () => {
		const interactionId = "resume-failed-request-gate"
		const turnId = "resume-turn"
		const response: InteractionResponse = {
			taskId: "task-1",
			turnId,
			interactionId,
			actionId: "resume",
			stateRevision: 5,
			draft: { text: "Continue", images: [], files: [] },
		}
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.PAUSED,
					revision: 7,
					anchor: { apiIndex: 2, turnId, interactionId },
				}),
				interaction: {
					taskId: "task-1",
					turnId,
					interactionId,
					kind: "resume",
					status: "awaiting",
					createdRevision: 7,
					anchor: { messageTs: 100, messageType: "ask" },
					acceptedResponse: response,
				},
			},
			createPorts(),
		)

		await expect(new InteractionCoordinator(runtime).releaseApiContinuationForRequestGate()).resolves.toBe(true)
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.PAUSED,
			interaction: undefined,
			anchor: { apiIndex: 2 },
		})
	})

	it("does not release interaction ownership before an API continuation is accepted", async () => {
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.PAUSED,
					revision: 4,
					anchor: { apiIndex: 2, turnId: "resume-turn", interactionId: "resume-awaiting" },
				}),
				interaction: {
					taskId: "task-1",
					turnId: "resume-turn",
					interactionId: "resume-awaiting",
					kind: "resume",
					status: "awaiting",
					createdRevision: 3,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			createPorts(),
		)

		await expect(new InteractionCoordinator(runtime).releaseApiContinuationForRequestGate()).resolves.toBe(false)
		expect(runtime.getState().interaction).toMatchObject({
			kind: "resume",
			status: "awaiting",
			interactionId: "resume-awaiting",
		})
	})

	it("continues completion from a hydrated resolving response exactly once", async () => {
		const interactionId = "completion-crash"
		const turnId = "completion-turn"
		const response: InteractionResponse = {
			taskId: "task-1",
			turnId,
			interactionId,
			actionId: "reply",
			stateRevision: 4,
			draft: { text: "Refine", images: [], files: [] },
		}
		const state = hydrateResolvingInteraction({
			kind: "completion",
			phase: TaskPhase.COMPLETED,
			turnId,
			interactionId,
			response,
		})
		state.completion = { completionId: interactionId }
		const runtime = new TaskRuntime(state, createPorts())

		await expect(
			new InteractionCoordinator(runtime).complete({
				turnId,
				interactionId,
				completionId: interactionId,
				presentation: "Done",
			}),
		).resolves.toMatchObject({ actionId: "reply", draft: response.draft })
		expect(runtime.getState().phase).toBe(TaskPhase.STREAMING)
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it("continues exhausted retry from a hydrated resolving response exactly once", async () => {
		const interactionId = "retry-crash"
		const turnId = "retry-turn"
		const response: InteractionResponse = {
			taskId: "task-1",
			turnId,
			interactionId,
			actionId: "retry",
			stateRevision: 4,
			draft: { text: "Retry context", images: [], files: [] },
		}
		const startApi = vi.fn(async () => undefined)
		const runtime = new TaskRuntime(
			hydrateResolvingInteraction({
				kind: "error_retry",
				phase: TaskPhase.AWAITING_APPROVAL,
				turnId,
				interactionId,
				response,
				apiIndex: 7,
			}),
			createPorts({ startApi }),
		)

		await expect(
			new InteractionCoordinator(runtime).recover({ turnId, interactionId, apiIndex: 7, presentation: "Failed" }),
		).resolves.toMatchObject({ actionId: "retry", draft: response.draft })
		expect(startApi).toHaveBeenCalledOnce()
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.STREAMING,
			interaction: {
				kind: "error_retry",
				status: "resolving",
				interactionId,
				acceptedResponse: { actionId: "retry", draft: response.draft },
			},
		})

		const admitted = await runtime.dispatch({ type: "API_REQUEST_STARTED", apiIndex: 7 })
		expect(admitted.accepted).toBe(true)
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.STREAMING,
			anchor: { apiIndex: 7, interactionId: undefined },
			interaction: undefined,
		})
	})

	it("commits a live resume response even when no waiter owns the interaction", async () => {
		const startApi = vi.fn(async () => undefined)
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.PAUSED,
					revision: 4,
					anchor: { apiIndex: 2, turnId: "resume-turn", interactionId: "resume-1" },
				}),
				interaction: {
					taskId: "task-1",
					turnId: "resume-turn",
					interactionId: "resume-1",
					kind: "resume",
					status: "awaiting",
					createdRevision: 3,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			createPorts({ startApi }),
		)
		const coordinator = new InteractionCoordinator(runtime)

		await coordinator.respond({
			taskId: "task-1",
			turnId: "resume-turn",
			interactionId: "resume-1",
			actionId: "resume",
			stateRevision: runtime.getState().revision,
			draft: { text: "Continue", images: [], files: [] },
		})
		await vi.waitFor(() => {
			expect(runtime.getState().phase).toBe(TaskPhase.RESUMING)
			expect(runtime.getState().interaction).toMatchObject({
				kind: "resume",
				status: "resolving",
				interactionId: "resume-1",
				acceptedResponse: { actionId: "resume", draft: { text: "Continue", images: [], files: [] } },
			})
			expect(startApi).toHaveBeenCalledOnce()
		})

		const admitted = await runtime.dispatch({ type: "API_REQUEST_STARTED", apiIndex: 2 })
		expect(admitted.accepted).toBe(true)
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.STREAMING,
			anchor: { apiIndex: 2, interactionId: undefined },
		})
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it("commits one hydrated resume response exactly once without rejecting the waiter continuation", async () => {
		const startApi = vi.fn(async () => undefined)
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.PAUSED,
					revision: 4,
					anchor: { apiIndex: 2, turnId: "resume-turn", interactionId: "resume-1" },
				}),
				interaction: {
					taskId: "task-1",
					turnId: "resume-turn",
					interactionId: "resume-1",
					kind: "resume",
					status: "awaiting",
					createdRevision: 3,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			createPorts({ startApi }),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const resumePromise = coordinator.resumeExisting("resume-1")
		await vi.waitFor(() => expect(runtime.getState().interaction?.status).toBe("awaiting"))

		const responseResult = await coordinator.respond({
			taskId: "task-1",
			turnId: "resume-turn",
			interactionId: "resume-1",
			actionId: "resume",
			stateRevision: runtime.getState().revision,
			draft: { text: "Continue", images: [], files: [] },
		})
		await expect(resumePromise).resolves.toMatchObject({ actionId: "resume" })

		expect(responseResult.accepted).toBe(true)
		expect(responseResult.effectError).toBeUndefined()
		expect(startApi).toHaveBeenCalledOnce()
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.RESUMING,
			interaction: {
				kind: "resume",
				status: "resolving",
				interactionId: "resume-1",
				acceptedResponse: { actionId: "resume", draft: { text: "Continue", images: [], files: [] } },
			},
		})

		const admitted = await runtime.dispatch({ type: "API_REQUEST_STARTED", apiIndex: 2 })
		expect(admitted.accepted).toBe(true)
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.STREAMING,
			anchor: { apiIndex: 2, interactionId: undefined },
		})
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it("takes over one hydrated resume interaction and commits its causal response", async () => {
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.PAUSED,
					revision: 4,
					anchor: { apiIndex: 2, turnId: "resume-turn", interactionId: "resume-1" },
				}),
				interaction: {
					taskId: "task-1",
					turnId: "resume-turn",
					interactionId: "resume-1",
					kind: "resume",
					status: "awaiting",
					createdRevision: 3,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			createPorts(),
		)
		const coordinator = new InteractionCoordinator(runtime)

		const outcomePromise = coordinator.resumeExisting("resume-1")
		await runtime.dispatch({
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "resume-turn",
				interactionId: "resume-1",
				actionId: "resume",
				stateRevision: runtime.getState().revision,
				draft: { text: "Continue", images: [], files: [] },
			},
		})

		await expect(outcomePromise).resolves.toMatchObject({ actionId: "resume" })
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.RESUMING,
			anchor: { apiIndex: 2, interactionId: "resume-1" },
			interaction: {
				kind: "resume",
				status: "resolving",
				interactionId: "resume-1",
				acceptedResponse: { actionId: "resume", draft: { text: "Continue", images: [], files: [] } },
			},
		})

		const admitted = await runtime.dispatch({ type: "API_REQUEST_STARTED", apiIndex: 2 })
		expect(admitted.accepted).toBe(true)
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.STREAMING,
			anchor: { apiIndex: 2, interactionId: undefined },
		})
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it("commits completion feedback before returning it to the handler", async () => {
		const runtime = new TaskRuntime(createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.EXECUTING }), createPorts())
		const coordinator = new InteractionCoordinator(runtime)

		const outcomePromise = coordinator.complete({
			turnId: "turn-completion",
			interactionId: "completion-1",
			completionId: "completion-1",
			presentation: "done",
		})
		await vi.waitFor(() => expect(runtime.getState().interaction?.status).toBe("awaiting"))

		await runtime.dispatch({
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn-completion",
				interactionId: "completion-1",
				actionId: "reply",
				stateRevision: runtime.getState().revision,
				draft: { text: "Refine", images: [], files: [] },
			},
		})

		await expect(outcomePromise).resolves.toMatchObject({ actionId: "reply" })
		expect(runtime.getState()).toMatchObject({ phase: TaskPhase.STREAMING })
		expect(runtime.getState().interaction).toBeUndefined()
		expect(runtime.getState().completion).toBeUndefined()
	})

	it("commits start-new-task effect before returning terminal completion", async () => {
		const startNewTask = vi.fn(async () => undefined)
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.EXECUTING }),
			createPorts({ startNewTask }),
		)
		const coordinator = new InteractionCoordinator(runtime)

		const outcomePromise = coordinator.complete({
			turnId: "turn-completion",
			interactionId: "completion-1",
			completionId: "completion-1",
			presentation: "done",
		})
		await vi.waitFor(() => expect(runtime.getState().interaction?.status).toBe("awaiting"))

		await runtime.dispatch({
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn-completion",
				interactionId: "completion-1",
				actionId: "start_new_task",
				stateRevision: runtime.getState().revision,
				draft: { text: "Next", images: [], files: [] },
			},
		})

		await expect(outcomePromise).resolves.toMatchObject({ actionId: "start_new_task" })
		expect(startNewTask).toHaveBeenCalledOnce()
		expect(runtime.getState().phase).toBe(TaskPhase.COMPLETED)
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it("commits retry draft through one START_API continuation", async () => {
		const startApi = vi.fn(async () => undefined)
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 7 } }),
			createPorts({ startApi }),
		)
		const coordinator = new InteractionCoordinator(runtime)

		const outcomePromise = coordinator.recover({
			turnId: "turn-retry",
			interactionId: "retry-1",
			apiIndex: 7,
			presentation: "failed",
		})
		await vi.waitFor(() => expect(runtime.getState().interaction?.status).toBe("awaiting"))

		await runtime.dispatch({
			type: "INTERACTION_RESPONDED",
			response: {
				taskId: "task-1",
				turnId: "turn-retry",
				interactionId: "retry-1",
				actionId: "retry",
				stateRevision: runtime.getState().revision,
				draft: { text: "context", images: ["image"], files: ["file"] },
			},
		})

		await expect(outcomePromise).resolves.toMatchObject({ actionId: "retry" })
		expect(startApi).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "START_API",
				apiIndex: 7,
				draft: { text: "context", images: ["image"], files: ["file"] },
				persistedRequest: false,
			}),
		)
		expect(runtime.getState().phase).toBe(TaskPhase.STREAMING)
		expect(runtime.getState().interaction).toMatchObject({
			kind: "error_retry",
			status: "resolving",
			interactionId: "retry-1",
			acceptedResponse: {
				actionId: "retry",
				draft: { text: "context", images: ["image"], files: ["file"] },
			},
		})

		const admitted = await runtime.dispatch({ type: "API_REQUEST_STARTED", apiIndex: 7 })
		expect(admitted.accepted).toBe(true)
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.STREAMING,
			anchor: { apiIndex: 7, interactionId: undefined },
			interaction: undefined,
		})
	})

	it("commits a restored mistake-limit response without a tool-block continuation", async () => {
		const startApi = vi.fn(async () => undefined)
		const runtime = new TaskRuntime(
			hydrateAwaitingInteraction({
				kind: "mistake_limit",
				phase: TaskPhase.AWAITING_APPROVAL,
				turnId: "mistake-turn",
				interactionId: "mistake-1",
				apiIndex: 7,
			}),
			createPorts({ startApi }),
		)
		const coordinator = new InteractionCoordinator(runtime)

		const result = await coordinator.respond({
			taskId: "task-1",
			turnId: "mistake-turn",
			interactionId: "mistake-1",
			actionId: "process_anyway",
			stateRevision: runtime.getState().revision,
			draft: { text: "Continue with guidance", images: [], files: [] },
		})

		expect(result.accepted).toBe(true)
		expect(startApi).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "START_API",
				apiIndex: 7,
				contentTransform: "mistake_limit",
				draft: { text: "Continue with guidance", images: [], files: [] },
			}),
		)
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.STREAMING,
			interaction: {
				kind: "mistake_limit",
				status: "resolving",
				acceptedResponse: { actionId: "process_anyway" },
			},
		})
	})

	it("starts a new task from a restored mistake-limit footer action", async () => {
		const startNewTask = vi.fn(async () => undefined)
		const runtime = new TaskRuntime(
			hydrateAwaitingInteraction({
				kind: "mistake_limit",
				phase: TaskPhase.AWAITING_APPROVAL,
				turnId: "mistake-turn",
				interactionId: "mistake-1",
			}),
			createPorts({ startNewTask }),
		)
		const coordinator = new InteractionCoordinator(runtime)

		const result = await coordinator.respond({
			taskId: "task-1",
			turnId: "mistake-turn",
			interactionId: "mistake-1",
			actionId: "start_new_task",
			stateRevision: runtime.getState().revision,
			draft: { text: "Next task", images: [], files: [] },
		})

		expect(result.accepted).toBe(true)
		expect(startNewTask).toHaveBeenCalledWith(
			expect.objectContaining({ draft: { text: "Next task", images: [], files: [] } }),
		)
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it.each(
		INTERACTION_KINDS.filter((kind) => kind !== "condense"),
	)("temporarily interrupts and restores a live %s interaction", async (kind) => {
		const runtime = new TaskRuntime(createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }), createPorts())
		const coordinator = new InteractionCoordinator(runtime)
		const originalInteractionId = `original-${kind}`
		const originalOutcome = coordinator.open({
			turnId: `turn-${kind}`,
			interactionId: originalInteractionId,
			kind,
			presentation: `Original ${kind}`,
		})
		await vi.waitFor(() => expect(runtime.getState().interaction?.interactionId).toBe(originalInteractionId))

		const interruptionId = `interrupt-${kind}`
		const interruptionOutcome = coordinator.interrupt({
			turnId: interruptionId,
			interactionId: interruptionId,
			kind: "condense",
			presentation: "Compaction review",
		})
		await vi.waitFor(() => expect(runtime.getState().interaction?.interactionId).toBe(interruptionId))
		expect(runtime.getState().interruptedInteraction).toMatchObject({
			interactionId: originalInteractionId,
			kind,
			status: "awaiting",
		})

		await coordinator.respond({
			taskId: "task-1",
			turnId: interruptionId,
			interactionId: interruptionId,
			actionId: "confirm_utility",
			stateRevision: runtime.getState().revision,
		})
		await expect(interruptionOutcome).resolves.toMatchObject({ actionId: "confirm_utility" })
		expect(runtime.getState().interaction).toMatchObject({
			interactionId: originalInteractionId,
			kind,
			status: "awaiting",
		})
		expect(runtime.getState().interruptedInteraction).toBeUndefined()

		const definition = getInteraction(kind)
		const action = definition.actions[0]
		const actionId = action?.type ?? definition.input.enterAction
		if (!actionId) throw new Error(`Interaction ${kind} has no response action`)
		const payloadPolicy = action?.payloadPolicy ?? "draft"
		const response = await coordinator.respond({
			taskId: "task-1",
			turnId: `turn-${kind}`,
			interactionId: originalInteractionId,
			actionId,
			stateRevision: runtime.getState().revision,
			...(payloadPolicy === "draft" || payloadPolicy === "draft_and_selection"
				? { draft: { text: `Continue ${kind}`, images: [], files: [] } }
				: {}),
			...(payloadPolicy === "selection" || payloadPolicy === "draft_and_selection"
				? { selection: { values: [`selection-${kind}`] } }
				: {}),
		})
		expect(response.accepted).toBe(true)
		await expect(originalOutcome).resolves.toMatchObject({ actionId })
		expect(runtime.getState().interaction).toBeUndefined()
	})

	it("rejects a second primary interaction while one is active", async () => {
		const runtime = new TaskRuntime(createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING }), createPorts())
		const coordinator = new InteractionCoordinator(runtime)
		void coordinator.open({
			turnId: "turn-1",
			interactionId: "interaction-1",
			kind: "qna_response",
			presentation: "First",
		})
		await vi.waitFor(() => expect(runtime.getState().interaction?.status).toBe("awaiting"))

		await expect(
			coordinator.open({
				turnId: "turn-1",
				interactionId: "interaction-2",
				kind: "followup",
				presentation: "Second",
			}),
		).rejects.toThrow("Interaction open rejected")
	})
})
