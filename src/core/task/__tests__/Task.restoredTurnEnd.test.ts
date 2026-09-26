import type { ToolUse } from "@core/assistant-message"
import { Task } from "@core/task"
import {
	type DetachedInteractionContinuationContext,
	InteractionCoordinator,
} from "@core/task/interaction/InteractionCoordinator"
import type { InteractionResponse } from "@core/task/interaction/InteractionResponse"
import type { TaskEffectPorts } from "@core/task/runtime/TaskEffectRunner"
import { TaskRuntime } from "@core/task/runtime/TaskRuntime"
import { createTaskRuntimeState } from "@core/task/runtime/TaskRuntimeState"
import { TaskPhase } from "@core/task/TaskPhase"
import { FocusChainHandler } from "@core/task/tools/handlers/FocusChainHandler"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { type BlockLifecycle, BlockPhase } from "../BlockPhaseMachine"

function runtimePorts(): TaskEffectPorts {
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

describe("Task restored turn-end continuation", () => {
	it("releases the Task Header compaction barrier before its trailing presentation publication settles", async () => {
		let releaseTrailingPublication: (() => void) | undefined
		const trailingPublication = new Promise<void>((resolve) => {
			releaseTrailingPublication = resolve
		})
		let publicationCount = 0
		const taskState = {
			abort: false,
			isInitialized: true,
			isInternalContextCompactionRequest: true,
			isManualContextCompactionRequest: true,
			operationSignal: new AbortController().signal,
		}
		const fakeTask = {
			taskId: "task-1",
			taskState,
			api: {},
			taskSm: { mode: "act" },
			getRuntimeState: () => ({
				revision: 7,
				interaction: { interactionId: "qna-history-interaction" },
			}),
			contextCompactionSession: {
				getActiveOperationId: () => undefined,
				run: vi.fn(async () => "completed" as const),
			},
			getTaskHeaderContextCompactionBoundary: () => ({ sourceHistory: [], targetContinuationHistory: [] }),
			invalidatePreparedProviderInputs: vi.fn(),
			contextCompactionPresentation: { clear: vi.fn() },
			postStateToWebview: vi.fn(async () => {
				publicationCount++
				if (publicationCount === 2) await trailingPublication
			}),
		} as unknown as Task
		const compactTask = (
			Task.prototype as unknown as {
				compactTask(expectedRevision: number): Promise<{ accepted: boolean; result: string }>
			}
		).compactTask
		const waitForSettlement = (
			Task.prototype as unknown as {
				waitForTaskHeaderCompactionSettlement(): Promise<void>
			}
		).waitForTaskHeaderCompactionSettlement

		const result = await compactTask.call(fakeTask, 7)
		expect(result).toEqual({ accepted: true, result: "accepted" })
		await vi.waitFor(() => expect(publicationCount).toBe(2))

		let barrierSettled = false
		const barrier = waitForSettlement.call(fakeTask).then(() => {
			barrierSettled = true
		})
		try {
			await vi.waitFor(() => expect(barrierSettled).toBe(true), { timeout: 250 })
			expect(taskState.isInternalContextCompactionRequest).toBe(false)
			expect(taskState.isManualContextCompactionRequest).toBe(false)
		} finally {
			releaseTrailingPublication?.()
			await barrier
		}
	})

	it("loads a restored interaction block only from its exact assistant API index", () => {
		const interactionId = "approval-history-interaction"
		const staleBlock = {
			type: "tool_use" as const,
			name: ClineDefaultTool.FILE_EDIT,
			input: { path: "stale.ts" },
			function_id: "stale-function",
			dline_tid: interactionId,
		}
		const exactBlock = {
			...staleBlock,
			name: ClineDefaultTool.FILE_READ,
			input: { path: "exact.ts" },
			function_id: "exact-function",
		}
		const storedToRuntime = vi.fn((block, ts) => ({
			type: "tool_use",
			name: block.name,
			params: block.input,
			partial: false,
			function_id: block.function_id,
			dline_tid: block.dline_tid,
			ts,
		}))
		const fakeTask = {
			taskState: { assistantMessageContent: [] },
			messageStateHandler: {
				apiConversationHistory: [
					{ role: "assistant", content: [staleBlock] },
					{ role: "user", content: "unrelated" },
					{ role: "assistant", content: [exactBlock] },
				],
			},
			restoreHandler: { storedToRuntime },
		} as unknown as Task
		const findRestoredTurnEndBlock = (
			Task.prototype as unknown as {
				findRestoredTurnEndBlock(interactionId: string, messageTs: number, assistantApiIndex?: number): ToolUse
			}
		).findRestoredTurnEndBlock

		const restored = findRestoredTurnEndBlock.call(fakeTask, interactionId, 101, 2)

		expect(restored).toMatchObject({
			name: ClineDefaultTool.FILE_READ,
			function_id: "exact-function",
			dline_tid: interactionId,
			ts: 101,
		})
		expect(storedToRuntime).toHaveBeenCalledWith(exactBlock, 101)
	})

	it("commits a restored approval before invoking its detached continuation", async () => {
		const interactionId = "approval-history-interaction"
		const turnId = `turn:${interactionId}`
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.AWAITING_APPROVAL,
					revision: 8,
					anchor: { apiIndex: 4, uiMessageTs: 100, turnId, interactionId },
				}),
				turn: {
					turnId,
					assistantApiIndex: 4,
					mode: "serial",
					activeDlineTid: interactionId,
					blocks: [
						{
							dlineTid: interactionId,
							functionId: "approval-history-function",
							toolName: ClineDefaultTool.FILE_READ,
							phase: BlockPhase.AWAITING_APPROVAL,
							ts: 100,
							requiresApproval: true,
							conversationHistoryIndex: 4,
						},
					],
				},
				interaction: {
					taskId: "task-1",
					turnId,
					interactionId,
					kind: "tool_approval",
					status: "awaiting",
					createdRevision: 7,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			runtimePorts(),
		)
		const coordinator = new InteractionCoordinator(runtime)
		const continuation = vi.fn(async (context: DetachedInteractionContinuationContext) => {
			expect(runtime.getState()).toMatchObject({
				phase: TaskPhase.EXECUTING,
				interaction: {
					interactionId,
					status: "resolving",
					acceptedResponse: { actionId: "approve" },
				},
				turn: { blocks: [{ dlineTid: interactionId, phase: BlockPhase.EXECUTING }] },
			})
			await context.resolve()
		})
		coordinator.registerDetachedContinuation(continuation)
		const response: InteractionResponse = {
			taskId: "task-1",
			turnId,
			interactionId,
			actionId: "approve",
			stateRevision: 8,
			draft: { text: "approved", images: [], files: [] },
		}

		const accepted = await coordinator.respond(response)

		expect(accepted.accepted).toBe(true)
		await vi.waitFor(() => expect(continuation).toHaveBeenCalledOnce())
		await vi.waitFor(() => expect(runtime.getState().interaction).toBeUndefined())
		expect(runtime.getState().turn?.blocks[0]?.phase).toBe(BlockPhase.EXECUTING)
		const duplicate = await coordinator.respond(response)
		expect(duplicate).toMatchObject({ accepted: false, error: { code: "stale_interaction" } })
		expect(continuation).toHaveBeenCalledOnce()
	})

	it("does not execute a rejected image tool after restoring its manual approval", async () => {
		const interactionId = "image-history-interaction"
		const turnId = `turn:${interactionId}`
		const functionId = "image-history-function"
		const storedBlock = {
			type: "tool_use" as const,
			name: ClineDefaultTool.GENERATE_IMAGE,
			input: { prompt: "A quiet lake", count: "1" },
			function_id: functionId,
			dline_tid: interactionId,
		}
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.AWAITING_APPROVAL,
					revision: 8,
					anchor: { apiIndex: 1, uiMessageTs: 100, turnId, interactionId },
				}),
				turn: {
					turnId,
					assistantApiIndex: 1,
					mode: "serial",
					activeDlineTid: interactionId,
					blocks: [
						{
							dlineTid: interactionId,
							functionId,
							toolName: ClineDefaultTool.GENERATE_IMAGE,
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
					kind: "tool_approval",
					status: "awaiting",
					createdRevision: 7,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			runtimePorts(),
		)
		const nextRequest = vi.fn(async () => false)
		const executeTool = vi.fn(async () => undefined)
		const describeToolDenial = vi.fn(async () => "Image generation rejected")
		const pendingContent: Array<Record<string, unknown>> = []
		const commitInterruptedToolResult = vi.fn(async (block: ToolUse, reason: string) => {
			pendingContent.push({
				type: "tool_result",
				dline_tid: block.dline_tid,
				function_id: block.function_id,
				content: reason,
			})
		})
		const presentToolDenial = vi.fn(async () => undefined)
		const fakeTask = {
			taskId: "task-1",
			taskRuntime: runtime,
			taskState: {
				abort: true,
				userMessageContent: pendingContent,
				assistantMessageContent: [] as ToolUse[],
				didCompleteReadingStream: false,
				resetOperationCancellation: vi.fn(),
			},
			messageStateHandler: {
				apiConversationHistory: [
					{ role: "user" as const, content: "task" },
					{ role: "assistant" as const, content: [storedBlock] },
				],
				clineMessages: [],
			},
			restoreHandler: {
				storedToRuntime: (block: typeof storedBlock, ts: number): ToolUse => ({
					type: "tool_use",
					name: block.name,
					params: block.input,
					partial: false,
					function_id: block.function_id,
					dline_tid: block.dline_tid,
					ts,
				}),
			},
			restoredTurnToolBlocks: (Task.prototype as unknown as { restoredTurnToolBlocks(turn: unknown): ToolUse[] })
				.restoredTurnToolBlocks,
			ensureRestoredBlockExecutionStarted: (
				Task.prototype as unknown as {
					ensureRestoredBlockExecutionStarted(turnId: string, lifecycle: BlockLifecycle): Promise<BlockLifecycle>
				}
			).ensureRestoredBlockExecutionStarted,
			turnDriver: {
				hasPendingToolResult: (dlineTid: string, id: string) =>
					pendingContent.some((content) => content.dline_tid === dlineTid && content.function_id === id),
				isTerminalRuntimeBlock: (phase: BlockPhase) =>
					[BlockPhase.COMPLETED, BlockPhase.REJECTED, BlockPhase.SKIPPED, BlockPhase.CANCELLED].includes(phase),
				ensureTerminalToolResult: vi.fn(async () => undefined),
				execute: vi.fn(async () => undefined),
			},
			dispatchRuntime: runtime.dispatch.bind(runtime),
			toolExecutor: { executeTool, describeToolDenial, presentToolDenial, commitInterruptedToolResult },
			waitForTaskHeaderCompactionSettlement: vi.fn(async () => undefined),
			syncRetainedMachines: vi.fn(),
			recursivelyMakeClineRequests: nextRequest,
			requestCancellation: vi.fn(async () => ({ accepted: true })),
		} as unknown as Task
		const coordinator = new InteractionCoordinator(runtime)
		const continueRestoredInteraction = (
			Task.prototype as unknown as {
				continueRestoredInteraction(context: DetachedInteractionContinuationContext): Promise<void>
			}
		).continueRestoredInteraction
		coordinator.registerDetachedContinuation((context) => continueRestoredInteraction.call(fakeTask, context))

		const response: InteractionResponse = {
			taskId: "task-1",
			turnId,
			interactionId,
			actionId: "reject",
			stateRevision: 8,
			draft: { text: "No image", images: [], files: [] },
		}
		expect((await coordinator.respond(response)).accepted).toBe(true)
		await coordinator.waitForClaimedContinuation(interactionId)

		expect(runtime.getState().turn?.blocks[0]?.phase).toBe(BlockPhase.REJECTED)
		expect(executeTool).not.toHaveBeenCalled()
		expect(describeToolDenial).toHaveBeenCalledOnce()
		expect(commitInterruptedToolResult).toHaveBeenCalledOnce()
		expect(pendingContent.filter((content) => content.type === "tool_result")).toEqual([
			{ type: "tool_result", dline_tid: interactionId, function_id: functionId, content: "Image generation rejected" },
		])
		expect(presentToolDenial).toHaveBeenCalledOnce()
		expect(nextRequest).toHaveBeenCalledOnce()
		expect((await coordinator.respond(response)).accepted).toBe(false)
		expect(commitInterruptedToolResult).toHaveBeenCalledOnce()
	})

	it.each(["approve", "reject"] as const)("restores change_todo_list %s without widening its approval", async (actionId) => {
		const interactionId = `focus-chain-${actionId}`
		const turnId = `turn:${interactionId}`
		const functionId = `function-${interactionId}`
		const newPlan = "# Approved changes\n- [ ] Keep this item\n- [ ] Do not add this item"
		const storedBlock = {
			type: "tool_use" as const,
			name: ClineDefaultTool.CHANGE_TODO_LIST,
			input: { new_plan: newPlan, reason: "Only the selected item" },
			function_id: functionId,
			dline_tid: interactionId,
		}
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.AWAITING_APPROVAL,
					revision: 8,
					anchor: { apiIndex: 1, uiMessageTs: 100, turnId, interactionId },
				}),
				turn: {
					turnId,
					assistantApiIndex: 1,
					mode: "serial",
					activeDlineTid: interactionId,
					blocks: [
						{
							dlineTid: interactionId,
							functionId,
							toolName: ClineDefaultTool.CHANGE_TODO_LIST,
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
					kind: "change_todo_list",
					status: "awaiting",
					createdRevision: 7,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			runtimePorts(),
		)
		const pendingContent: Array<Record<string, unknown>> = []
		const admissionOutcomes = new Map<string, InteractionResponse>()
		const focusChainForceUpdate = vi.fn(async (_plan: string) => undefined)
		const handler = new FocusChainHandler()
		const executeTool = vi.fn(async (block: ToolUse) => {
			const result = await handler.execute(
				{
					admissionOutcomes,
					callbacks: { focusChainForceUpdate, say: vi.fn(async () => undefined) },
				} as unknown as TaskConfig,
				block,
			)
			pendingContent.push({
				type: "tool_result",
				dline_tid: block.dline_tid,
				function_id: block.function_id,
				content: result,
			})
		})
		const describeToolDenial = vi.fn(async () => "TODO list change rejected")
		const commitInterruptedToolResult = vi.fn(async (block: ToolUse, reason: string) => {
			pendingContent.push({
				type: "tool_result",
				dline_tid: block.dline_tid,
				function_id: block.function_id,
				content: reason,
			})
		})
		const nextRequest = vi.fn(async () => false)
		const recordAdmissionOutcome = vi.fn((block: ToolUse, outcome: InteractionResponse) => {
			if (block.dline_tid) admissionOutcomes.set(block.dline_tid, outcome)
		})
		const fakeTask = {
			taskId: "task-1",
			taskRuntime: runtime,
			taskState: {
				abort: true,
				userMessageContent: pendingContent,
				assistantMessageContent: [] as ToolUse[],
				didCompleteReadingStream: false,
				resetOperationCancellation: vi.fn(),
			},
			messageStateHandler: {
				apiConversationHistory: [
					{ role: "user" as const, content: "task" },
					{ role: "assistant" as const, content: [storedBlock] },
				],
				clineMessages: [],
			},
			restoreHandler: {
				storedToRuntime: (block: typeof storedBlock, ts: number): ToolUse => ({
					type: "tool_use",
					name: block.name,
					params: block.input,
					partial: false,
					function_id: block.function_id,
					dline_tid: block.dline_tid,
					ts,
				}),
			},
			restoredTurnToolBlocks: (Task.prototype as unknown as { restoredTurnToolBlocks(turn: unknown): ToolUse[] })
				.restoredTurnToolBlocks,
			ensureRestoredBlockExecutionStarted: (
				Task.prototype as unknown as {
					ensureRestoredBlockExecutionStarted(turnId: string, lifecycle: BlockLifecycle): Promise<BlockLifecycle>
				}
			).ensureRestoredBlockExecutionStarted,
			turnDriver: {
				hasPendingToolResult: (dlineTid: string, id: string) =>
					pendingContent.some((content) => content.dline_tid === dlineTid && content.function_id === id),
				isTerminalRuntimeBlock: (phase: BlockPhase) =>
					[BlockPhase.COMPLETED, BlockPhase.REJECTED, BlockPhase.SKIPPED, BlockPhase.CANCELLED].includes(phase),
				ensureTerminalToolResult: vi.fn(async () => undefined),
				execute: vi.fn(async () => undefined),
			},
			dispatchRuntime: runtime.dispatch.bind(runtime),
			toolExecutor: {
				executeTool,
				describeToolDenial,
				commitInterruptedToolResult,
				presentToolDenial: vi.fn(async () => undefined),
				recordAdmissionOutcome,
			},
			waitForTaskHeaderCompactionSettlement: vi.fn(async () => undefined),
			syncRetainedMachines: vi.fn(),
			recursivelyMakeClineRequests: nextRequest,
			requestCancellation: vi.fn(async () => ({ accepted: true })),
		} as unknown as Task
		const coordinator = new InteractionCoordinator(runtime)
		const continueRestoredInteraction = (
			Task.prototype as unknown as {
				continueRestoredInteraction(context: DetachedInteractionContinuationContext): Promise<void>
			}
		).continueRestoredInteraction
		coordinator.registerDetachedContinuation((context) => continueRestoredInteraction.call(fakeTask, context))
		const response: InteractionResponse = {
			taskId: "task-1",
			turnId,
			interactionId,
			actionId,
			stateRevision: 8,
			draft: { text: "", images: [], files: [] },
			selection: { values: ["0"] },
		}

		expect((await coordinator.respond(response)).accepted).toBe(true)
		await coordinator.waitForClaimedContinuation(interactionId)
		expect(nextRequest).toHaveBeenCalledOnce()
		expect(pendingContent.filter((content) => content.type === "tool_result")).toHaveLength(1)
		expect((await coordinator.respond(response)).accepted).toBe(false)
		if (actionId === "approve") {
			expect(runtime.getState().turn?.blocks[0]?.phase).toBe(BlockPhase.COMPLETED)
			expect(recordAdmissionOutcome).toHaveBeenCalledWith(
				expect.objectContaining({ dline_tid: interactionId }),
				expect.objectContaining({ selection: { values: ["0"] } }),
			)
			expect(executeTool).toHaveBeenCalledOnce()
			expect(focusChainForceUpdate).toHaveBeenCalledWith("# Approved changes\n- [ ] Keep this item")
			expect(describeToolDenial).not.toHaveBeenCalled()
		} else {
			expect(runtime.getState().turn?.blocks[0]?.phase).toBe(BlockPhase.REJECTED)
			expect(executeTool).not.toHaveBeenCalled()
			expect(recordAdmissionOutcome).not.toHaveBeenCalled()
			expect(focusChainForceUpdate).not.toHaveBeenCalled()
			expect(describeToolDenial).toHaveBeenCalledOnce()
			expect(pendingContent[0]?.content).toBe("TODO list change rejected")
			expect(commitInterruptedToolResult).toHaveBeenCalledOnce()
		}
	})

	it("claims restored manual approval execution ownership exactly once", async () => {
		const interactionId = "approval-execution-owner"
		const turnId = `turn:${interactionId}`
		const lifecycle: BlockLifecycle = {
			dlineTid: interactionId,
			functionId: "approval-execution-function",
			toolName: ClineDefaultTool.FILE_READ,
			phase: BlockPhase.EXECUTING,
			ts: 100,
			requiresApproval: true,
			conversationHistoryIndex: 1,
		}
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.EXECUTING, revision: 9 }),
				turn: {
					turnId,
					assistantApiIndex: 1,
					mode: "serial",
					blocks: [lifecycle],
					approval: { automatic: [] },
					executing: [],
				},
			},
			runtimePorts(),
		)
		const fakeTask = {
			taskRuntime: runtime,
			dispatchRuntime: runtime.dispatch.bind(runtime),
		} as unknown as Task
		const ensureStarted = (
			Task.prototype as unknown as {
				ensureRestoredBlockExecutionStarted(turnId: string, lifecycle: BlockLifecycle): Promise<BlockLifecycle>
			}
		).ensureRestoredBlockExecutionStarted

		const started = await ensureStarted.call(fakeTask, turnId, lifecycle)
		const revision = runtime.getState().revision
		const repeated = await ensureStarted.call(fakeTask, turnId, started)

		expect(started.phase).toBe(BlockPhase.EXECUTING)
		expect(repeated).toEqual(started)
		expect(runtime.getState().turn?.executing).toEqual([interactionId])
		expect(runtime.getState().revision).toBe(revision)
	})

	it("commits a restored turn-end result before resolving and starting the next request", async () => {
		const interactionId = "qna-history-interaction"
		const turnId = `turn:${interactionId}`
		const functionId = "qna-history-function"
		const storedBlock = {
			type: "tool_use" as const,
			name: ClineDefaultTool.QNA_RESPOND,
			input: { response: "Restored question" },
			function_id: functionId,
			dline_tid: interactionId,
		}
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.EXECUTING,
					revision: 9,
					anchor: { apiIndex: 1, uiMessageTs: 100, turnId, interactionId },
				}),
				turn: {
					turnId,
					assistantApiIndex: 1,
					mode: "serial",
					blocks: [
						{
							dlineTid: interactionId,
							functionId,
							toolName: ClineDefaultTool.QNA_RESPOND,
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
					status: "resolving",
					createdRevision: 8,
					anchor: { messageTs: 100, messageType: "ask" },
					acceptedResponse: {
						taskId: "task-1",
						turnId,
						interactionId,
						actionId: "reply",
						stateRevision: 9,
						draft: { text: "continue", images: [], files: [] },
					},
				},
			},
			runtimePorts(),
		)
		const sequence: string[] = []
		let nextRequestContent: unknown[] = []
		let releaseCompaction: (() => void) | undefined
		const compactionSettlement = new Promise<void>((resolve) => {
			releaseCompaction = resolve
		})
		const taskState = {
			abort: true,
			userMessageContent: [] as Array<Record<string, unknown>>,
			assistantMessageContent: [] as ToolUse[],
			didCompleteReadingStream: false,
			resetOperationCancellation: vi.fn(),
		}
		const apiConversationHistory = [
			{ role: "user" as const, content: "task" },
			{ role: "assistant" as const, content: [storedBlock] },
		]
		const fakeTask = {
			taskId: "task-1",
			taskRuntime: runtime,
			taskState,
			messageStateHandler: { apiConversationHistory, clineMessages: [] },
			restoreHandler: {
				storedToRuntime: (block: typeof storedBlock, ts: number): ToolUse => ({
					type: "tool_use",
					name: block.name,
					params: block.input,
					partial: false,
					function_id: block.function_id,
					dline_tid: block.dline_tid,
					ts,
				}),
			},
			restoredTurnToolBlocks: (Task.prototype as unknown as { restoredTurnToolBlocks(turn: unknown): ToolUse[] })
				.restoredTurnToolBlocks,
			ensureRestoredBlockExecutionStarted: (
				Task.prototype as unknown as {
					ensureRestoredBlockExecutionStarted(turnId: string, lifecycle: BlockLifecycle): Promise<BlockLifecycle>
				}
			).ensureRestoredBlockExecutionStarted,
			hasPendingToolResult: (
				Task.prototype as unknown as { hasPendingToolResult(dlineTid: string, functionId: string): boolean }
			).hasPendingToolResult,
			turnDriver: {
				hasPendingToolResult: (dlineTid: string, functionId: string) =>
					taskState.userMessageContent.some(
						(content) => content.dline_tid === dlineTid && content.function_id === functionId,
					),
				isTerminalRuntimeBlock: (phase: BlockPhase) =>
					[BlockPhase.COMPLETED, BlockPhase.REJECTED, BlockPhase.SKIPPED, BlockPhase.CANCELLED].includes(phase),
				execute: async () => {
					sequence.push("turn-finalized")
				},
			},
			dispatchRuntime: runtime.dispatch.bind(runtime),
			toolExecutor: {
				continueTurnEndInteraction: vi.fn(async () => {
					sequence.push("handler-continuation")
					return "<feedback>continue</feedback>"
				}),
				commitRestoredToolResult: vi.fn(async (_result: unknown, block: ToolUse) => {
					sequence.push("result-committed")
					taskState.userMessageContent.push({
						type: "tool_result",
						content: "<feedback>continue</feedback>",
						function_id: block.function_id,
						dline_tid: block.dline_tid,
					})
				}),
				commitInterruptedToolResult: vi.fn(async () => {}),
				executeTool: vi.fn(async () => {}),
			},
			isTerminalRuntimeBlock: (phase: BlockPhase) =>
				[BlockPhase.COMPLETED, BlockPhase.REJECTED, BlockPhase.SKIPPED, BlockPhase.CANCELLED].includes(phase),
			waitForTaskHeaderCompactionSettlement: async () => {
				sequence.push("compaction-waiting")
				await compactionSettlement
				sequence.push("compaction-settled")
			},
			syncRetainedMachines: () => sequence.push("machines-synced"),
			recursivelyMakeClineRequests: async (content: unknown[]) => {
				nextRequestContent = [...content]
				sequence.push("next-api")
				return false
			},
			requestCancellation: vi.fn(async () => ({ accepted: true })),
		} as unknown as Task
		const continueRestoredInteraction = (
			Task.prototype as unknown as {
				continueRestoredInteraction(context: DetachedInteractionContinuationContext): Promise<void>
			}
		).continueRestoredInteraction
		const interaction = runtime.getState().interaction
		if (!interaction) throw new Error("test interaction missing")
		const context: DetachedInteractionContinuationContext = {
			interaction,
			outcome: { actionId: "reply", draft: { text: "continue", images: [], files: [] } },
			isCurrent: () => true,
			resolve: async () => {
				sequence.push("interaction-resolved")
				const resolved = await runtime.dispatch({ type: "INTERACTION_RESOLVED", interactionId })
				expect(resolved.accepted).toBe(true)
			},
		}

		const continuation = continueRestoredInteraction.call(fakeTask, context)
		await vi.waitFor(() => expect(sequence).toEqual(["compaction-waiting"]))
		releaseCompaction?.()
		await continuation

		expect(sequence).toEqual([
			"compaction-waiting",
			"compaction-settled",
			"handler-continuation",
			"result-committed",
			"interaction-resolved",
			"machines-synced",
			"turn-finalized",
			"next-api",
		])
		expect(runtime.getState().interaction).toBeUndefined()
		expect(runtime.getState().turn?.blocks[0]?.phase).toBe(BlockPhase.COMPLETED)
		expect(taskState.abort).toBe(false)
		const serializedRequest = JSON.stringify(nextRequestContent)
		expect(serializedRequest).toContain("The previous task session was closed and has now been restored.")
		expect(serializedRequest.split("<feedback>continue</feedback>")).toHaveLength(2)
	})

	it("stops a detached continuation at the cancellation generation boundary", async () => {
		const interactionId = "qna-cancelled-continuation"
		const turnId = `turn:${interactionId}`
		const functionId = "qna-cancelled-function"
		const storedBlock = {
			type: "tool_use" as const,
			name: ClineDefaultTool.QNA_RESPOND,
			input: { response: "Restored question" },
			function_id: functionId,
			dline_tid: interactionId,
		}
		const taskState = {
			abort: true,
			userMessageContent: [] as Array<Record<string, unknown>>,
			assistantMessageContent: [] as ToolUse[],
			didCompleteReadingStream: false,
			resetOperationCancellation: vi.fn(),
		}
		let releaseHandler: (() => void) | undefined
		let handlerStarted: (() => void) | undefined
		const handlerGate = new Promise<void>((resolve) => {
			releaseHandler = resolve
		})
		const handlerStart = new Promise<void>((resolve) => {
			handlerStarted = resolve
		})
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({
					taskId: "task-1",
					phase: TaskPhase.EXECUTING,
					revision: 9,
					anchor: { apiIndex: 1, uiMessageTs: 100, turnId, interactionId },
				}),
				turn: {
					turnId,
					assistantApiIndex: 1,
					mode: "serial",
					blocks: [
						{
							dlineTid: interactionId,
							functionId,
							toolName: ClineDefaultTool.QNA_RESPOND,
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
					createdRevision: 8,
					anchor: { messageTs: 100, messageType: "ask" },
				},
			},
			{
				...runtimePorts(),
				cancelRuntime: async () => {
					taskState.abort = true
				},
			},
		)
		const commitRestoredToolResult = vi.fn(async () => undefined)
		const executeFinalizedAssistantTurn = vi.fn(async () => undefined)
		const recursivelyMakeClineRequests = vi.fn(async () => false)
		const fakeTask = {
			taskId: "task-1",
			taskRuntime: runtime,
			taskState,
			messageStateHandler: {
				apiConversationHistory: [
					{ role: "user" as const, content: "task" },
					{ role: "assistant" as const, content: [storedBlock] },
				],
				clineMessages: [],
			},
			restoreHandler: {
				storedToRuntime: (block: typeof storedBlock, ts: number): ToolUse => ({
					type: "tool_use",
					name: block.name,
					params: block.input,
					partial: false,
					function_id: block.function_id,
					dline_tid: block.dline_tid,
					ts,
				}),
			},
			restoredTurnToolBlocks: (Task.prototype as unknown as { restoredTurnToolBlocks(turn: unknown): ToolUse[] })
				.restoredTurnToolBlocks,
			ensureRestoredBlockExecutionStarted: (
				Task.prototype as unknown as {
					ensureRestoredBlockExecutionStarted(turnId: string, lifecycle: BlockLifecycle): Promise<BlockLifecycle>
				}
			).ensureRestoredBlockExecutionStarted,
			hasPendingToolResult: (
				Task.prototype as unknown as { hasPendingToolResult(dlineTid: string, functionId: string): boolean }
			).hasPendingToolResult,
			dispatchRuntime: runtime.dispatch.bind(runtime),
			toolExecutor: {
				continueTurnEndInteraction: vi.fn(async () => {
					handlerStarted?.()
					await handlerGate
					return "continued tool result"
				}),
				commitRestoredToolResult,
				commitInterruptedToolResult: vi.fn(async () => undefined),
				executeTool: vi.fn(async () => undefined),
			},
			isTerminalRuntimeBlock: (phase: BlockPhase) =>
				[BlockPhase.COMPLETED, BlockPhase.REJECTED, BlockPhase.SKIPPED, BlockPhase.CANCELLED].includes(phase),
			waitForTaskHeaderCompactionSettlement: vi.fn(async () => undefined),
			syncRetainedMachines: vi.fn(),
			executeFinalizedAssistantTurn,
			recursivelyMakeClineRequests,
		} as unknown as Task
		const coordinator = new InteractionCoordinator(runtime)
		;(fakeTask as unknown as { interactionCoordinator: InteractionCoordinator }).interactionCoordinator = coordinator
		const continueRestoredInteraction = (
			Task.prototype as unknown as {
				continueRestoredInteraction(context: DetachedInteractionContinuationContext): Promise<void>
			}
		).continueRestoredInteraction
		coordinator.registerDetachedContinuation((context) => continueRestoredInteraction.call(fakeTask, context))

		const response = await coordinator.respond({
			taskId: "task-1",
			turnId,
			interactionId,
			actionId: "reply",
			stateRevision: 9,
			draft: { text: "continue", images: [], files: [] },
		})
		expect(response.accepted).toBe(true)
		await handlerStart
		const cancelling = Task.prototype.requestCancellation.call(fakeTask)
		await vi.waitFor(() => expect(runtime.getState().phase).toBe(TaskPhase.CANCELLING))
		releaseHandler?.()
		await cancelling

		expect(commitRestoredToolResult).not.toHaveBeenCalled()
		expect(executeFinalizedAssistantTurn).not.toHaveBeenCalled()
		expect(recursivelyMakeClineRequests).not.toHaveBeenCalled()
		expect(taskState.abort).toBe(true)
		expect(runtime.getState()).toMatchObject({ phase: TaskPhase.PAUSED, interaction: { kind: "resume" } })
	})

	it("flushes the restored tool result before closing the previous turn and admitting the next request", async () => {
		const sequence: string[] = []
		const persistApiRequestUserMessage = (
			Task.prototype as unknown as {
				persistApiRequestUserMessage(
					content: unknown[],
					apiIndex: number,
					requestScope: unknown,
					beforeApiRequestStarted: () => Promise<void>,
				): Promise<boolean>
			}
		).persistApiRequestUserMessage
		const content = [{ type: "tool_result", function_id: "function-restored", dline_tid: "restored-interaction" }]
		const fakeTask = {
			inputQueueCoordinator: { hasStagedDelivery: false },
			messageStateHandler: {
				addToApiConversationHistory: vi.fn(async () => {
					sequence.push("user-message-appended")
				}),
				flushApiConversationHistory: vi.fn(async () => {
					sequence.push("user-message-flushed")
				}),
			},
			completeApiRequestGate: vi.fn(async (_requestScope, _apiIndex, beforeApiRequestStarted) => {
				await beforeApiRequestStarted?.()
				sequence.push("api-request-started")
				return true
			}),
		} as unknown as Task

		const approved = await persistApiRequestUserMessage.call(fakeTask, content, 6, {}, async () => {
			sequence.push("previous-turn-completed")
		})

		expect(approved).toBe(true)
		expect(sequence).toEqual([
			"user-message-appended",
			"user-message-flushed",
			"previous-turn-completed",
			"api-request-started",
		])
	})
})
