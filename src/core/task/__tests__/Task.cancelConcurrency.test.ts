import type { ToolUse } from "@core/assistant-message"
import { Task } from "@core/task"
import { TurnDriver } from "@core/task/executors/tool/TurnDriver"
import { TurnToolScheduler } from "@core/task/executors/tool/TurnToolScheduler"
import { InteractionCoordinator } from "@core/task/interaction/InteractionCoordinator"
import type { TaskEffectPorts } from "@core/task/runtime/TaskEffectRunner"
import type { TaskEvent } from "@core/task/runtime/TaskEvent"
import { TaskRuntime } from "@core/task/runtime/TaskRuntime"
import { createTaskRuntimeState } from "@core/task/runtime/TaskRuntimeState"
import { TaskPhase } from "@core/task/TaskPhase"
import { ToolExecutor } from "@core/task/ToolExecutor"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { BlockPhase } from "../BlockPhaseMachine"

function ports(overrides: Partial<TaskEffectPorts> = {}): TaskEffectPorts {
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

function makeToolBlock(): ToolUse {
	return {
		type: "tool_use",
		name: ClineDefaultTool.FILE_READ,
		params: { path: "README.md" },
		partial: false,
		function_id: "function-read",
		dline_tid: "dline-read",
		ts: 100,
	}
}

function invokeFinalizedTurn(task: Task): Promise<void> {
	const harness = task as unknown as {
		taskId: string
		controller: { task?: { taskId: string } }
		taskRuntime: TaskRuntime
		dispatchRuntime(event: TaskEvent): ReturnType<TaskRuntime["dispatch"]>
		messageStateHandler: { apiConversationHistory: unknown[] }
		taskController: { buildTurn(...args: unknown[]): void; getBlocks(): unknown[] }
		toolExecutor: {
			commitInterruptedToolResult?(tool: ToolUse, reason: string): Promise<void>
		}
		isParallelToolCallingEnabled(): boolean
		awaitInitialCheckpointBeforeToolSideEffects(toolName: string): Promise<void>
		taskState: {
			abort: boolean
			assistantMessageContent: ToolUse[]
			userMessageContent?: []
			userMessageContentReady: boolean
			partialToolLifecycleByTs: Map<number, string>
		}
	}
	const scheduler = new TurnToolScheduler({
		readConfiguredLimit: () => undefined,
		isParallelToolCallingEnabled: () => harness.isParallelToolCallingEnabled(),
	})
	const driver = new TurnDriver({
		task: {
			getTaskId: () => harness.taskId,
			isAborted: () => harness.taskState.abort,
			isCurrentTask: () => harness.controller.task?.taskId === harness.taskId,
			getAssistantMessageContent: () => harness.taskState.assistantMessageContent,
			getAssistantApiIndex: () => harness.messageStateHandler.apiConversationHistory.length - 1,
			buildTurn: (assistantApiIndex, autoApprove) => {
				harness.taskController.buildTurn(
					harness.taskState.assistantMessageContent.map((block) => ({
						...block,
						conversationHistoryIndex: assistantApiIndex,
					})),
					autoApprove,
				)
				return harness.taskController.getBlocks() as never[]
			},
			isParallelToolCallingEnabled: () => harness.isParallelToolCallingEnabled(),
			getPendingUserMessageContent: () => harness.taskState.userMessageContent ?? [],
			markPartialToolComplete: (ts) => harness.taskState.partialToolLifecycleByTs.set(ts, "complete-done"),
			recordToolCall: vi.fn(),
			markUserMessageContentReady: () => {
				harness.taskState.userMessageContentReady = true
			},
			applyCompactionFit: vi.fn(),
		},
		runtime: {
			getState: () => harness.taskRuntime.getState(),
			dispatch: (event) => harness.dispatchRuntime(event),
		},
		block: {
			prepareAdmission: () => ({
				outcome: "admitted",
				decision: { kind: "automatic", scope: "read_workspace", ceiling: "auto" },
				lanes: [],
				run: async () => undefined,
			}),
			commitInterruptedResult: (tool, reason) =>
				harness.toolExecutor.commitInterruptedToolResult?.(tool, reason) ?? Promise.resolve(),
			awaitInitialCheckpoint: (toolName) => harness.awaitInitialCheckpointBeforeToolSideEffects(toolName),
		},
		approval: {
			request: vi.fn(async () => ({ actionId: "approve" as const })),
			stageFeedback: vi.fn(async () => undefined),
		},
		scheduler,
		provider: { registerExecution: vi.fn() },
		postCommit: {
			takeDirective: () => undefined,
			startSuccessor: vi.fn(async () => undefined),
		},
	})
	Object.assign(harness, { turnDriver: driver })
	return driver.execute()
}

describe("Task cancellation concurrency", () => {
	it("lets a PreToolUse cancellation retain its tool result before the deferred effect exits", async () => {
		const block = makeToolBlock()
		const durableResults: string[] = []
		const taskState = {
			abort: false,
			consecutiveMistakeCount: 0,
			lastToolName: undefined,
			lastToolParams: undefined,
			userMessageContent: [],
		}
		let executePreToolBlock: (() => Promise<void>) | undefined
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 1 } }),
				turn: {
					turnId: "turn:dline-read",
					assistantApiIndex: 1,
					mode: "serial",
					blocks: [
						{
							dlineTid: "dline-read",
							functionId: "function-read",
							toolName: ClineDefaultTool.FILE_READ,
							phase: BlockPhase.AUTO_EXECUTING,
							ts: 100,
							requiresApproval: false,
							conversationHistoryIndex: 1,
						},
					],
				},
			},
			ports({
				cancelRuntime: async () => {
					taskState.abort = true
				},
				executeTool: async () => executePreToolBlock?.(),
			}),
		)
		const interactionCoordinator = new InteractionCoordinator(runtime)
		const fakeTask = {
			taskId: "task-1",
			taskRuntime: runtime,
			interactionCoordinator,
			dispatchRuntime: runtime.dispatch.bind(runtime),
		} as unknown as Task
		const cancelTask = vi.fn(async () => {
			await Task.prototype.requestCancellation.call(fakeTask)
		})
		const noop = vi.fn(async () => undefined)
		const executor = Object.assign(Object.create(ToolExecutor.prototype), {
			taskId: "task-1",
			ulid: "ulid-1",
			cwd: "E:/workspace/vscode/dline",
			getMode: () => "act",
			isParallelToolCallingEnabled: () => false,
			stateManager: {
				getGlobalSettingsKey: (key: string) => {
					if (key === "strictPlanModeEnabled" || key === "hooksEnabled") return false
					if (key === "focusChainSettings") return { enabled: false }
					if (key === "maxConsecutiveMistakes") return 3
					return undefined
				},
			},
			taskState,
			taskController: {},
			messageStateHandler: {},
			api: {},
			autoApprover: {},
			interactions: {},
			coordinator: {
				execute: async (config: { callbacks: { cancelTask(): Promise<void> } }) => {
					await config.callbacks.cancelTask()
					return "Tool execution cancelled by PreToolUse hook"
				},
			},
			getTaskCapabilityToggles: () => ({}),
			identityFactory: {},
			activityStore: {},
			focusChainForceUpdate: noop,
			say: noop,
			ask: noop,
			saveCheckpoint: noop,
			cancelTask,
			executeCommandTool: noop,
			cancelRunningCommandTool: noop,
			doesLatestTaskCompletionHaveNewChanges: noop,
			updateFCListFromToolResponse: noop,
			sayAndCreateMissingParamError: noop,
			shouldAutoApproveTool: () => false,
			shouldAutoApproveToolWithPath: noop,
			applyLatestBrowserSettings: noop,
			switchToActMode: noop,
			setActiveHookExecution: noop,
			clearActiveHookExecution: noop,
			getActiveHookExecution: noop,
			runUserPromptSubmitHook: noop,
			updateClineMessage: noop,
			pushToolResult: vi.fn((result: string) => ({
				type: "tool_result",
				content: result,
				function_id: "function-read",
				dline_tid: "dline-read",
			})),
			recordPartialToolResult: vi.fn(async (result: { content: string }) => {
				durableResults.push(result.content)
			}),
		}) as ToolExecutor
		const config = (
			ToolExecutor.prototype as unknown as {
				asToolConfig(): { callbacks: { cancelTask(): Promise<void> } }
			}
		).asToolConfig.call(executor)
		const handleCompleteBlock = (
			ToolExecutor.prototype as unknown as {
				handleCompleteBlock(block: ToolUse, config: unknown): Promise<void>
			}
		).handleCompleteBlock
		executePreToolBlock = () => handleCompleteBlock.call(executor, block, config)

		const admitted = await runtime.dispatchAtAdmission({
			type: "BLOCK_EXECUTION_STARTED",
			turnId: "turn:dline-read",
			dlineTid: "dline-read",
		})
		expect(admitted.accepted).toBe(true)
		await vi.waitFor(() => expect(cancelTask).toHaveBeenCalledOnce())
		await vi.waitFor(() => expect(runtime.getState().phase).toBe(TaskPhase.PAUSED), { timeout: 250 })

		expect(durableResults).toEqual(["Tool execution cancelled by PreToolUse hook"])
		expect(cancelTask).toHaveBeenCalledOnce()
	})

	it("lets a PostToolUse cancellation finish without the deferred tool effect waiting on itself", async () => {
		const block = makeToolBlock()
		const taskState = {
			abort: false,
			consecutiveMistakeCount: 0,
			lastToolName: undefined,
			lastToolParams: undefined,
			userMessageContent: [],
		}
		let executeCompleteBlock: (() => Promise<void>) | undefined
		const runtime = new TaskRuntime(
			{
				...createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 1 } }),
				turn: {
					turnId: "turn:dline-read",
					assistantApiIndex: 1,
					mode: "serial",
					blocks: [
						{
							dlineTid: "dline-read",
							functionId: "function-read",
							toolName: ClineDefaultTool.FILE_READ,
							phase: BlockPhase.AUTO_EXECUTING,
							ts: 100,
							requiresApproval: false,
							conversationHistoryIndex: 1,
						},
					],
				},
			},
			ports({
				cancelRuntime: async () => {
					taskState.abort = true
				},
				executeTool: async () => executeCompleteBlock?.(),
			}),
		)
		const interactionCoordinator = new InteractionCoordinator(runtime)
		const fakeTask = {
			taskId: "task-1",
			taskRuntime: runtime,
			interactionCoordinator,
			dispatchRuntime: runtime.dispatch.bind(runtime),
		} as unknown as Task
		const cancelTask = vi.fn(async () => {
			await Task.prototype.requestCancellation.call(fakeTask)
		})
		const executor = Object.assign(Object.create(ToolExecutor.prototype), {
			stateManager: {
				getGlobalSettingsKey: (key: string) => {
					if (key === "hooksEnabled") return true
					if (key === "focusChainSettings") return { enabled: false }
					if (key === "maxConsecutiveMistakes") return 3
					return undefined
				},
			},
			taskState,
			coordinator: { execute: vi.fn(async () => "tool result") },
			pushToolResult: vi.fn(),
			recordPartialToolResult: vi.fn(async () => undefined),
			runPostToolUseHook: vi.fn(async () => true),
			updateFCListFromToolResponse: vi.fn(async () => undefined),
		}) as ToolExecutor
		const handleCompleteBlock = (
			ToolExecutor.prototype as unknown as {
				handleCompleteBlock(block: ToolUse, config: unknown): Promise<void>
			}
		).handleCompleteBlock
		executeCompleteBlock = () =>
			handleCompleteBlock.call(executor, block, {
				callbacks: { cancelTask },
			})

		const admitted = await runtime.dispatchAtAdmission({
			type: "BLOCK_EXECUTION_STARTED",
			turnId: "turn:dline-read",
			dlineTid: "dline-read",
		})
		expect(admitted.accepted).toBe(true)
		await vi.waitFor(() => expect(cancelTask).toHaveBeenCalledOnce())
		await vi.waitFor(() => expect(runtime.getState().phase).toBe(TaskPhase.PAUSED), { timeout: 250 })

		expect(cancelTask).toHaveBeenCalledOnce()
		expect(runtime.getState().interaction).toMatchObject({ kind: "resume", status: "awaiting" })
	})

	it.each([
		"TURN_CREATED",
		"BLOCK_READY",
		"BLOCK_EXECUTION_COMPLETED",
		"TURN_COMPLETED",
	] as const)("exits quietly when Cancel wins immediately before %s admission", async (cancelBefore) => {
		const block = makeToolBlock()
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 1 } }),
			ports(),
		)
		const dispatch = runtime.dispatch.bind(runtime)
		let didCancel = false
		const dispatchRuntime = async (event: TaskEvent) => {
			if (event.type === cancelBefore && !didCancel) {
				didCancel = true
				const cancelled = await dispatch({ type: "TASK_CANCEL_REQUESTED", source: "user" })
				expect(cancelled.accepted).toBe(true)
				return {
					accepted: false,
					next: runtime.getState(),
					effects: [],
					error: { code: "invalid_runtime_event" as const },
				}
			}
			return dispatch(event)
		}
		const fakeTask = {
			taskId: "task-1",
			controller: { task: { taskId: "task-1" } },
			taskRuntime: runtime,
			dispatchRuntime,
			messageStateHandler: { apiConversationHistory: [{ role: "user" }, { role: "assistant" }] },
			taskController: {
				buildTurn: vi.fn(),
				getBlocks: () => [
					{
						dlineTid: "dline-read",
						functionId: "function-read",
						toolName: ClineDefaultTool.FILE_READ,
						ts: 100,
						requiresApproval: false,
						conversationHistoryIndex: 1,
					},
				],
			},
			toolExecutor: {},
			isParallelToolCallingEnabled: () => false,
			initialCheckpointCommitPromise: undefined,
			awaitInitialCheckpointBeforeToolSideEffects: vi.fn(async () => undefined),
			taskState: {
				abort: false,
				assistantMessageContent: [block],
				userMessageContentReady: false,
				partialToolLifecycleByTs: new Map(),
			},
		} as unknown as Task

		await expect(invokeFinalizedTurn(fakeTask)).resolves.toBeUndefined()
		expect(didCancel).toBe(true)
		expect(runtime.getState().phase).toBe(TaskPhase.CANCELLING)
	})

	it.each([
		["TURN_CREATED", "Turn creation rejected: invalid_runtime_event"],
		["BLOCK_READY", "Block readiness rejected: invalid_runtime_event"],
		["BLOCK_EXECUTION_COMPLETED", "Block completion rejected: invalid_runtime_event"],
		["TURN_COMPLETED", "Turn completion rejected: invalid_runtime_event"],
	] as const)("still reports a rejected %s outside a cancellation boundary", async (rejectedEvent, expectedError) => {
		const block = makeToolBlock()
		const runtime = new TaskRuntime(
			createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, anchor: { apiIndex: 1 } }),
			ports(),
		)
		const dispatch = runtime.dispatch.bind(runtime)
		const fakeTask = {
			taskId: "task-1",
			controller: { task: { taskId: "task-1" } },
			taskRuntime: runtime,
			dispatchRuntime: async (event: TaskEvent) => {
				if (event.type === rejectedEvent) {
					return { accepted: false, next: runtime.getState(), effects: [], error: { code: "invalid_runtime_event" } }
				}
				return dispatch(event)
			},
			messageStateHandler: { apiConversationHistory: [{ role: "user" }, { role: "assistant" }] },
			taskController: {
				buildTurn: vi.fn(),
				getBlocks: () => [
					{
						dlineTid: "dline-read",
						functionId: "function-read",
						toolName: ClineDefaultTool.FILE_READ,
						ts: 100,
						requiresApproval: false,
						conversationHistoryIndex: 1,
					},
				],
			},
			toolExecutor: {},
			isParallelToolCallingEnabled: () => false,
			initialCheckpointCommitPromise: undefined,
			awaitInitialCheckpointBeforeToolSideEffects: vi.fn(async () => undefined),
			taskState: {
				abort: false,
				assistantMessageContent: [block],
				userMessageContentReady: false,
				partialToolLifecycleByTs: new Map(),
			},
		} as unknown as Task

		await expect(invokeFinalizedTurn(fakeTask)).rejects.toThrow(expectedError)
		expect(runtime.getState().phase).not.toBe(TaskPhase.CANCELLING)
	})
})
