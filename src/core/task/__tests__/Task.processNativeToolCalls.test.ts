import { strict as assert } from "node:assert"
import type { AssistantMessageContent, TextStreamContent, ToolUse } from "@core/assistant-message"
import { registerPartialMessageCallback } from "@core/controller/ui/subscribeToPartialMessage"
import { formatResponse } from "@core/prompts/responses"
import { Task } from "@core/task"
import { type BlockLifecycle, BlockPhase } from "@core/task/BlockPhaseMachine"
import { TurnDriver } from "@core/task/executors/tool/TurnDriver"
import { TurnToolScheduler } from "@core/task/executors/tool/TurnToolScheduler"
import type { TaskEffectPorts } from "@core/task/runtime/TaskEffectRunner"
import type { TaskEvent } from "@core/task/runtime/TaskEvent"
import { TaskRuntime } from "@core/task/runtime/TaskRuntime"
import { createTaskRuntimeState } from "@core/task/runtime/TaskRuntimeState"
import { TaskPhase } from "@core/task/TaskPhase"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { ClineContent } from "@shared/messages/content"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"

interface TurnDriverHarnessOptions {
	taskId?: string
	toolBlocks: readonly ToolUse[]
	runtime?: TaskRuntime
	runtimeBlocks?: BlockLifecycle[]
	parallel?: boolean
	configuredLimit?: number
	autoApproved?: boolean
	userMessageContent?: ClineContent[]
	commitInterruptedResult?: (tool: ToolUse, reason: string) => Promise<void>
	awaitInitialCheckpoint?: (toolName: string) => Promise<void>
}

function createTurnDriverHarness(options: TurnDriverHarnessOptions): TurnDriver {
	const scheduler = new TurnToolScheduler({
		readConfiguredLimit: () => options.configuredLimit,
		isParallelToolCallingEnabled: () => options.parallel ?? false,
	})
	const requireRuntime = (): TaskRuntime => {
		if (!options.runtime) throw new Error("TurnDriver test harness requires a runtime for execute()")
		return options.runtime
	}
	return new TurnDriver({
		task: {
			getTaskId: () => options.taskId ?? "task-turn-driver-harness",
			isAborted: () => false,
			isCurrentTask: () => true,
			getAssistantMessageContent: () => options.toolBlocks,
			getAssistantApiIndex: () => 1,
			buildTurn: () => options.runtimeBlocks ?? [],
			isParallelToolCallingEnabled: () => options.parallel ?? false,
			getPendingUserMessageContent: () => options.userMessageContent ?? [],
			markPartialToolComplete: vi.fn(),
			recordToolCall: vi.fn(),
			markUserMessageContentReady: vi.fn(),
			applyCompactionFit: vi.fn(),
		},
		runtime: {
			getState: () => requireRuntime().getState(),
			dispatch: (event) => requireRuntime().dispatch(event),
		},
		block: {
			prepareAdmission: () => ({
				outcome: "admitted",
				decision: {
					kind: options.autoApproved === false ? "manual" : "automatic",
					scope: "read_workspace",
					ceiling: "auto",
				},
				presentation: options.autoApproved === false ? { ask: "tool", body: "Approve tool", notify: false } : undefined,
				lanes: [],
				run: async () => undefined,
			}),
			commitInterruptedResult: options.commitInterruptedResult ?? vi.fn(async () => undefined),
			describeDenial: vi.fn(async () => formatResponse.toolDenied()),
			presentDenial: vi.fn(async () => undefined),
			awaitInitialCheckpoint: options.awaitInitialCheckpoint ?? vi.fn(async () => undefined),
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
}

function createParallelReadPresentation(failingDlineTid?: string) {
	const toolBlocks: ToolUse[] = Array.from({ length: 4 }, (_, index) => ({
		type: "tool_use",
		name: ClineDefaultTool.FILE_READ,
		params: { path: `file-${index + 1}.txt` },
		partial: false,
		isNativeToolCall: true,
		function_id: `call-read-${index + 1}`,
		dline_tid: `dline-read-${index + 1}`,
		ts: 500 + index,
	}))
	const runtimeBlocks = toolBlocks.map((block, index) => ({
		dlineTid: `dline-read-${index + 1}`,
		functionId: block.function_id,
		toolName: block.name,
		phase: BlockPhase.STREAMING,
		ts: 500 + index,
		requiresApproval: false,
		conversationHistoryIndex: 1,
	}))
	const executeTool = vi.fn(async (effect: { dlineTid: string }) => {
		if (effect.dlineTid === failingDlineTid) {
			throw new Error("read_file result persistence failed")
		}
	})
	const postView = vi.fn(async () => undefined)
	const ports: TaskEffectPorts = {
		postView,
		persistSnapshot: vi.fn(async () => undefined),
		cancelRuntime: vi.fn(async () => undefined),
		prepareResume: vi.fn(async () => undefined),
		startApi: vi.fn(async () => undefined),
		executeTool,
		appendSay: vi.fn(async () => undefined),
		appendAsk: vi.fn(async () => ({ uiMessageTs: 1 })),
		startNewTask: vi.fn(async () => undefined),
	}
	const runtime = new TaskRuntime(
		createTaskRuntimeState({
			taskId: "task-parallel-read",
			phase: TaskPhase.STREAMING,
			anchor: { apiIndex: 1 },
		}),
		ports,
	)
	const driver = createTurnDriverHarness({
		taskId: "task-parallel-read",
		toolBlocks,
		runtime,
		runtimeBlocks,
		parallel: true,
	})

	return { executeTool, fakeTask: driver, postView, runtime }
}

describe("Task.processNativeToolCalls", () => {
	it("rejects the active runtime block and skips later tools when command execution is rejected", async () => {
		const toolBlocks: ToolUse[] = [
			{
				type: "tool_use",
				name: ClineDefaultTool.BASH,
				params: { command: "echo first", requires_approval: "false" },
				partial: false,
				isNativeToolCall: true,
				function_id: "call-command",
				dline_tid: "dline-command",
				ts: 601,
			},
			{
				type: "tool_use",
				name: ClineDefaultTool.FILE_READ,
				params: { path: "must-not-run.txt" },
				partial: false,
				isNativeToolCall: true,
				function_id: "call-later-read",
				dline_tid: "dline-later-read",
				ts: 602,
			},
			{
				type: "tool_use",
				name: ClineDefaultTool.SEARCH,
				params: { path: ".", regex: "must-not-run" },
				partial: false,
				isNativeToolCall: true,
				function_id: "call-later-search",
				dline_tid: "dline-later-search",
				ts: 603,
			},
		]
		const runtimeBlocks = toolBlocks.map((block) => {
			assert.ok(block.dline_tid)
			assert.notEqual(block.ts, undefined)
			return {
				dlineTid: block.dline_tid,
				functionId: block.function_id,
				toolName: block.name,
				phase: BlockPhase.STREAMING,
				ts: block.ts,
				requiresApproval: false,
				conversationHistoryIndex: 1,
			}
		})
		const commandExecutor = {
			execute: vi.fn(async () => ({
				userRejected: true,
				result: "Command was cancelled by the user.",
				completed: false,
				exitCode: 1,
				signal: null,
			})),
		}
		let fakeTask: Task
		const executeTool = vi.fn(async (block: ToolUse) => {
			if (block.dline_tid === "dline-command") {
				await Task.prototype.executeCommandTool.call(fakeTask, "echo first", undefined, { commandTs: block.ts })
			}
		})
		const userMessageContent: ClineContent[] = []
		const commitInterruptedToolResult = vi.fn(async (block: ToolUse, reason: string) => {
			if (!block.function_id || !block.dline_tid) throw new Error("Test tool block is missing canonical identity")
			userMessageContent.push({
				type: "tool_result",
				function_id: block.function_id,
				dline_tid: block.dline_tid,
				content: [{ type: "text", text: reason }],
				is_error: true,
			})
		})
		const runtime = new TaskRuntime(
			createTaskRuntimeState({
				taskId: "task-command-rejection",
				phase: TaskPhase.STREAMING,
				anchor: { apiIndex: 1 },
			}),
			{
				postView: vi.fn(async () => undefined),
				persistSnapshot: vi.fn(async () => undefined),
				cancelRuntime: vi.fn(async () => undefined),
				prepareResume: vi.fn(async () => undefined),
				startApi: vi.fn(async () => undefined),
				executeTool: async (effect) => {
					const block = toolBlocks.find((candidate) => candidate.dline_tid === effect.dlineTid)
					if (!block) throw new Error(`Missing test block ${effect.dlineTid}`)
					await executeTool(block)
				},
				appendSay: vi.fn(async () => undefined),
				appendAsk: vi.fn(async () => ({ uiMessageTs: 1 })),
				startNewTask: vi.fn(async () => undefined),
			},
		)
		const runtimeEvents: TaskEvent["type"][] = []
		runtime.subscribe((event) => runtimeEvents.push(event.type))
		fakeTask = Object.assign(Object.create(Task.prototype), {
			taskId: "task-command-rejection",
			controller: { task: { taskId: "task-command-rejection" } },
			commandExecutor,
			initialCheckpointCommitPromise: undefined,
			isParallelToolCallingEnabled: () => false,
			dispatchRuntime: runtime.dispatch.bind(runtime),
			taskRuntime: runtime,
			taskController: {
				buildTurn: vi.fn(),
				getBlocks: () => runtimeBlocks,
			},
			toolExecutor: {
				executeTool,
				commitInterruptedToolResult,
				takePostCommitDirective: () => undefined,
			},
			messageStateHandler: { apiConversationHistory: [{ role: "user" }, { role: "assistant" }] },
			taskState: {
				abort: false,
				assistantMessageContent: toolBlocks as AssistantMessageContent[],
				userMessageContent,
				userMessageContentReady: false,
			},
			markFinalizedToolPresented: vi.fn(),
		})

		const turnDriver = createTurnDriverHarness({
			taskId: "task-command-rejection",
			toolBlocks,
			runtime,
			runtimeBlocks,
			userMessageContent,
			commitInterruptedResult: commitInterruptedToolResult,
		})
		Object.assign(fakeTask, { turnDriver })
		await turnDriver.execute()

		expect(commandExecutor.execute).toHaveBeenCalledOnce()
		expect(executeTool).toHaveBeenCalledTimes(1)
		expect(commitInterruptedToolResult).toHaveBeenCalledTimes(2)
		expect(commitInterruptedToolResult.mock.calls).toEqual([
			[toolBlocks[1], "The tool was skipped after an earlier interaction was rejected."],
			[toolBlocks[2], "The tool was skipped after an earlier interaction was rejected."],
		])
		expect(userMessageContent).toMatchObject([
			{ type: "tool_result", function_id: "call-later-read", dline_tid: "dline-later-read", is_error: true },
			{ type: "tool_result", function_id: "call-later-search", dline_tid: "dline-later-search", is_error: true },
		])
		expect(runtimeEvents).toContain("BLOCK_EXECUTION_REJECTED")
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.BETWEEN_TURNS,
			turn: {
				blocks: [
					{ dlineTid: "dline-command", phase: BlockPhase.REJECTED },
					{ dlineTid: "dline-later-read", phase: BlockPhase.SKIPPED },
					{ dlineTid: "dline-later-search", phase: BlockPhase.SKIPPED },
				],
			},
		})
	})

	it("does not duplicate an existing durable result for a skipped tool", async () => {
		const block: ToolUse = {
			type: "tool_use",
			name: ClineDefaultTool.FILE_READ,
			params: { path: "already-closed.txt" },
			partial: false,
			isNativeToolCall: true,
			function_id: "call-existing-skipped",
			dline_tid: "dline-existing-skipped",
			ts: 604,
		}
		const commitInterruptedToolResult = vi.fn(async () => undefined)
		const userMessageContent = [
			{
				type: "tool_result",
				function_id: block.function_id,
				dline_tid: block.dline_tid,
				content: [{ type: "text", text: "existing durable result" }],
			},
		] as ClineContent[]
		const turnDriver = createTurnDriverHarness({
			toolBlocks: [block],
			userMessageContent,
			commitInterruptedResult: commitInterruptedToolResult,
		})

		await turnDriver.ensureTerminalToolResult(block, BlockPhase.SKIPPED)

		expect(commitInterruptedToolResult).not.toHaveBeenCalled()
	})

	it("finalizes a partial prev text block and reuses its ts for the state text block", async () => {
		const prevTextTs = 100
		const clineMessages: ClineMessage[] = [
			{
				ts: prevTextTs,
				type: "say",
				say: "text",
				text: "partial text before tool handoff",
				partial: true,
			},
		]

		const sayCalls: Array<{ text: string; partial: boolean; ts: number }> = []
		const emittedPartialMessages: Array<{ partial: boolean; text: string }> = []
		const unsubscribe = registerPartialMessageCallback((message) => {
			emittedPartialMessages.push({
				partial: message.partial,
				text: message.text,
			})
		})

		const toolBlocks: ToolUse[] = [
			{
				type: "tool_use",
				name: ClineDefaultTool.ASK,
				params: { question: "Need clarification" },
				partial: true,
				isNativeToolCall: true,
				function_id: "call-1",
				dline_tid: "dline-call-1",
				ts: Date.now(),
			},
		]

		const fakeTask = {
			genMessageTs: () => Date.now(),
			say: async (
				_type: string,
				text: string,
				_images: unknown,
				_files: unknown,
				partial: boolean,
				existingTs?: number,
			) => {
				sayCalls.push({ text, partial, ts: existingTs ?? 0 })
				return existingTs
			},
			messageStateHandler: {
				clineMessages: () => clineMessages,
				updateTaskHistory: async () => {},
				flushMessageUpdate: async (_index: number) => {},
			},
			taskState: {
				assistantMessageContent: [
					{ type: "text", content: "streamed so far", partial: true, ts: prevTextTs },
				] as AssistantMessageContent[],
				currentStreamingContentIndex: 0,
				userMessageContentReady: true,
			},
		}

		try {
			await (
				Task.prototype as unknown as { processNativeToolCalls: (text: string, blocks: ToolUse[]) => Promise<void> }
			).processNativeToolCalls.call(fakeTask, "visible streamed text", toolBlocks)

			// Should have finalized the prev partial text
			const finalizeCall = sayCalls.find((c) => c.partial === false && c.text !== "")
			assert.ok(finalizeCall, "Expected a finalize say call for the partial text")
			assert.equal(finalizeCall.ts, prevTextTs, "Finalize should reuse prev block ts")

			// The new text block in assistantMessageContent should have the same ts as prev
			const textBlock = fakeTask.taskState.assistantMessageContent.find((b) => b.type === "text") as TextStreamContent
			assert.ok(textBlock, "Expected a text block in assistantMessageContent")
			assert.equal(textBlock.ts, prevTextTs, "State text block ts should match prev block ts")
			assert.equal(textBlock.partial, false, "State text block should be finalized")
		} finally {
			unsubscribe()
		}
	})

	it("does NOT finalize a non-partial prev text block", async () => {
		const prevTextTs = 100
		const sayCalls: Array<{ text: string; partial: boolean; ts: number }> = []

		const toolBlocks: ToolUse[] = [
			{
				type: "tool_use",
				name: ClineDefaultTool.ASK,
				params: { question: "Need clarification" },
				partial: true,
				isNativeToolCall: true,
				function_id: "call-1",
				dline_tid: "dline-call-1",
				ts: Date.now(),
			},
		]

		const fakeTask = {
			genMessageTs: () => Date.now(),
			say: async (
				_type: string,
				text: string,
				_images: unknown,
				_files: unknown,
				partial: boolean,
				existingTs?: number,
			) => {
				sayCalls.push({ text, partial, ts: existingTs ?? 0 })
				return existingTs
			},
			messageStateHandler: {
				clineMessages: () => [],
				updateTaskHistory: async () => {},
				flushMessageUpdate: async (_index: number) => {},
			},
			taskState: {
				assistantMessageContent: [
					{ type: "text", content: "already finalized", partial: false, ts: prevTextTs },
				] as AssistantMessageContent[],
				currentStreamingContentIndex: 0,
				userMessageContentReady: true,
			},
		}

		await (
			Task.prototype as unknown as { processNativeToolCalls: (text: string, blocks: ToolUse[]) => Promise<void> }
		).processNativeToolCalls.call(fakeTask, "more text", toolBlocks)

		// Should NOT have a finalize say call — prev block is not partial
		const finalizeCalls = sayCalls.filter((c) => c.partial === false)
		assert.equal(finalizeCalls.length, 0, "Should not finalize a non-partial prev text block")
	})

	it("does NOT finalize when there is no prev text block", async () => {
		const sayCalls: Array<{ text: string; partial: boolean; ts: number }> = []

		const toolBlocks: ToolUse[] = [
			{
				type: "tool_use",
				name: ClineDefaultTool.ASK,
				params: { question: "Need clarification" },
				partial: true,
				isNativeToolCall: true,
				function_id: "call-1",
				dline_tid: "dline-call-1",
				ts: Date.now(),
			},
		]

		const fakeTask = {
			genMessageTs: () => Date.now(),
			say: async (
				_type: string,
				text: string,
				_images: unknown,
				_files: unknown,
				partial: boolean,
				existingTs?: number,
			) => {
				sayCalls.push({ text, partial, ts: existingTs ?? 0 })
				return existingTs
			},
			messageStateHandler: {
				clineMessages: () => [],
				updateTaskHistory: async () => {},
				flushMessageUpdate: async (_index: number) => {},
			},
			taskState: {
				assistantMessageContent: [] as AssistantMessageContent[],
				currentStreamingContentIndex: 0,
				userMessageContentReady: true,
			},
		}

		await (
			Task.prototype as unknown as { processNativeToolCalls: (text: string, blocks: ToolUse[]) => Promise<void> }
		).processNativeToolCalls.call(fakeTask, "more text", toolBlocks)

		// Should NOT have a finalize say call — no prev text block exists
		const finalizeCalls = sayCalls.filter((c) => c.partial === false)
		assert.equal(finalizeCalls.length, 0, "Should not finalize when there is no prev text block")
	})

	it("presents a partial native tool without requiring a canonical runtime turn", async () => {
		const partialTool: ToolUse = {
			type: "tool_use",
			name: ClineDefaultTool.QNA_RESPOND,
			params: { response: "Streaming response" },
			partial: true,
			isNativeToolCall: true,
			function_id: "call-qna",
			dline_tid: "dline-qna",
			ts: 200,
		}
		const executeTool = vi.fn(async () => undefined)
		const dispatchRuntime = vi.fn(async () => {
			throw new Error("Partial presentation must not dispatch runtime events")
		})
		const fakeTask = {
			taskId: "task-native-qna",
			initialCheckpointCommitPromise: undefined,
			awaitInitialCheckpointBeforeToolSideEffects: async () => undefined,
			reRenderUpdatedPartialBlocks: async () => undefined,
			isParallelToolCallingEnabled: () => false,
			dispatchRuntime,
			taskController: {
				hasAnyRejection: () => false,
				shouldSkip: () => false,
			},
			toolExecutor: { executeTool },
			taskRuntime: { getState: () => ({ turn: undefined }) },
			taskState: {
				abort: false,
				assistantMessageContent: [partialTool] as AssistantMessageContent[],
				currentStreamingContentIndex: 0,
				didAlreadyUseTool: false,
				didCompleteReadingStream: false,
				lastRenderedPartialByTs: new Map<number, string>(),
				partialToolLifecycleByTs: new Map<number, "partial-shown" | "complete-running" | "complete-done">(),
				presentAssistantMessageHasPendingUpdates: false,
				presentAssistantMessageLocked: false,
				userMessageContentReady: false,
			},
		}

		await expect(Task.prototype.presentAssistantMessage.call(fakeTask as never)).resolves.toBeUndefined()
		expect(executeTool).toHaveBeenCalledOnce()
		expect(executeTool).toHaveBeenCalledWith(partialTool)
		expect(dispatchRuntime).not.toHaveBeenCalled()
		expect(fakeTask.taskState.currentStreamingContentIndex).toBe(0)
		expect(fakeTask.taskState.partialToolLifecycleByTs.get(200)).toBe("partial-shown")
	})

	it("waits for the initial checkpoint before presenting a mutating partial native tool", async () => {
		const partialTool: ToolUse = {
			type: "tool_use",
			name: ClineDefaultTool.FILE_NEW,
			params: { path: "checkpoint-race.txt", content: "content" },
			partial: true,
			isNativeToolCall: true,
			function_id: "call-write",
			dline_tid: "dline-write",
			ts: 201,
		}
		let resolveCheckpoint!: (value: string | undefined) => void
		const initialCheckpointCommitPromise = new Promise<string | undefined>((resolve) => {
			resolveCheckpoint = resolve
		})
		const executeTool = vi.fn(async () => undefined)
		const fakeTask = Object.assign(Object.create(Task.prototype), {
			taskId: "task-native-write",
			initialCheckpointCommitPromise,
			reRenderUpdatedPartialBlocks: async () => undefined,
			isParallelToolCallingEnabled: () => false,
			taskController: {
				hasAnyRejection: () => false,
				shouldSkip: () => false,
			},
			toolExecutor: { executeTool },
			taskState: {
				abort: false,
				assistantMessageContent: [partialTool] as AssistantMessageContent[],
				currentStreamingContentIndex: 0,
				didAlreadyUseTool: false,
				didCompleteReadingStream: false,
				lastRenderedPartialByTs: new Map<number, string>(),
				partialToolLifecycleByTs: new Map<number, "partial-shown" | "complete-running" | "complete-done">(),
				presentAssistantMessageHasPendingUpdates: false,
				presentAssistantMessageLocked: false,
				userMessageContentReady: false,
			},
		})

		const presentation = Task.prototype.presentAssistantMessage.call(fakeTask as never)
		await Promise.resolve()
		expect(executeTool).not.toHaveBeenCalled()

		resolveCheckpoint("initial-checkpoint")
		await expect(presentation).resolves.toBeUndefined()
		expect(executeTool).toHaveBeenCalledOnce()
		expect(executeTool).toHaveBeenCalledWith(partialTool)
		expect(fakeTask.initialCheckpointCommitPromise).toBeUndefined()
	})

	it("does not wait for the initial checkpoint before presenting a read-only partial native tool", async () => {
		const partialTool: ToolUse = {
			type: "tool_use",
			name: ClineDefaultTool.FILE_READ,
			params: { path: "README.md" },
			partial: true,
			isNativeToolCall: true,
			function_id: "call-read",
			dline_tid: "dline-read",
			ts: 202,
		}
		const initialCheckpointCommitPromise = new Promise<string | undefined>(() => {})
		const executeTool = vi.fn(async () => undefined)
		const fakeTask = Object.assign(Object.create(Task.prototype), {
			taskId: "task-native-read",
			initialCheckpointCommitPromise,
			reRenderUpdatedPartialBlocks: async () => undefined,
			isParallelToolCallingEnabled: () => false,
			taskController: {
				hasAnyRejection: () => false,
				shouldSkip: () => false,
			},
			toolExecutor: { executeTool },
			taskState: {
				abort: false,
				assistantMessageContent: [partialTool] as AssistantMessageContent[],
				currentStreamingContentIndex: 0,
				didAlreadyUseTool: false,
				didCompleteReadingStream: false,
				lastRenderedPartialByTs: new Map<number, string>(),
				partialToolLifecycleByTs: new Map<number, "partial-shown" | "complete-running" | "complete-done">(),
				presentAssistantMessageHasPendingUpdates: false,
				presentAssistantMessageLocked: false,
				userMessageContentReady: false,
			},
		})

		await expect(Task.prototype.presentAssistantMessage.call(fakeTask as never)).resolves.toBeUndefined()
		expect(executeTool).toHaveBeenCalledOnce()
		expect(executeTool).toHaveBeenCalledWith(partialTool)
		expect(fakeTask.initialCheckpointCommitPromise).toBe(initialCheckpointCommitPromise)
	})

	it("defers a complete XML tool until stream finalization can build the canonical turn", async () => {
		const completeTool: ToolUse = {
			type: "tool_use",
			name: ClineDefaultTool.FILE_READ,
			params: { path: "README.md" },
			partial: false,
			isNativeToolCall: false,
			function_id: "call-read",
			dline_tid: "dline-read",
			ts: 300,
		}
		const executeTool = vi.fn(async () => undefined)
		const dispatchRuntime = vi.fn(async () => {
			throw new Error("Complete tool must wait for stream finalization")
		})
		const fakeTask = {
			taskId: "task-xml-read",
			initialCheckpointCommitPromise: undefined,
			reRenderUpdatedPartialBlocks: async () => undefined,
			isParallelToolCallingEnabled: () => false,
			dispatchRuntime,
			taskController: {
				hasAnyRejection: () => false,
				shouldSkip: () => false,
			},
			toolExecutor: { executeTool },
			taskRuntime: { getState: () => ({ turn: undefined }) },
			taskState: {
				abort: false,
				assistantMessageContent: [completeTool] as AssistantMessageContent[],
				currentStreamingContentIndex: 0,
				didAlreadyUseTool: false,
				didCompleteReadingStream: false,
				lastRenderedPartialByTs: new Map<number, string>(),
				partialToolLifecycleByTs: new Map<number, "partial-shown" | "complete-running" | "complete-done">(),
				presentAssistantMessageHasPendingUpdates: false,
				presentAssistantMessageLocked: false,
				userMessageContentReady: false,
			},
		}

		await expect(Task.prototype.presentAssistantMessage.call(fakeTask as never)).resolves.toBeUndefined()
		expect(executeTool).not.toHaveBeenCalled()
		expect(dispatchRuntime).not.toHaveBeenCalled()
		expect(fakeTask.taskState.currentStreamingContentIndex).toBe(0)
	})

	it("does not execute a finalized tool from repeated presentation flushes", async () => {
		const completeTool: ToolUse = {
			type: "tool_use",
			name: ClineDefaultTool.QNA_RESPOND,
			params: { response: "Hello" },
			partial: false,
			isNativeToolCall: true,
			function_id: "call-qna",
			dline_tid: "dline-qna",
			ts: 400,
		}
		const dispatchRuntime = vi.fn(async () => {
			throw new Error("Presentation must not own finalized tool execution")
		})
		const executeTool = vi.fn(async () => undefined)
		const fakeTask = {
			taskId: "task-native-qna",
			reRenderUpdatedPartialBlocks: async () => undefined,
			isParallelToolCallingEnabled: () => true,
			dispatchRuntime,
			taskController: {
				hasAnyRejection: () => false,
			},
			toolExecutor: { executeTool },
			taskState: {
				abort: false,
				assistantMessageContent: [completeTool] as AssistantMessageContent[],
				currentStreamingContentIndex: 0,
				didAlreadyUseTool: false,
				didCompleteReadingStream: true,
				lastRenderedPartialByTs: new Map<number, string>(),
				partialToolLifecycleByTs: new Map<number, "partial-shown" | "complete-running" | "complete-done">(),
				presentAssistantMessageHasPendingUpdates: false,
				presentAssistantMessageLocked: false,
				userMessageContentReady: false,
			},
		}

		await expect(Task.prototype.presentAssistantMessage.call(fakeTask as never)).resolves.toBeUndefined()
		await expect(Task.prototype.presentAssistantMessage.call(fakeTask as never)).resolves.toBeUndefined()

		expect(dispatchRuntime).not.toHaveBeenCalled()
		expect(executeTool).not.toHaveBeenCalled()
		expect(fakeTask.taskState.currentStreamingContentIndex).toBe(1)
		expect(fakeTask.taskState.userMessageContentReady).toBe(false)
	})

	it("preserves the real execute-tool failure for the fourth parallel read block", async () => {
		const { executeTool, fakeTask, postView, runtime } = createParallelReadPresentation("dline-read-4")

		await expect((fakeTask as TurnDriver).execute()).rejects.toThrow("read_file result persistence failed")
		expect(executeTool).toHaveBeenCalledTimes(4)
		expect(runtime.getState().phase).toBe(TaskPhase.PAUSED)
		// TURN_CREATED + three completed blocks + fourth READY/STARTED + EFFECT_FAILED.
		expect(postView).toHaveBeenCalledTimes(13)
	})

	it("completes four auto-approved parallel read blocks in one canonical turn", async () => {
		const { executeTool, fakeTask, postView, runtime } = createParallelReadPresentation()

		await expect((fakeTask as TurnDriver).execute()).resolves.toBeUndefined()

		expect(executeTool.mock.calls.map(([effect]) => effect.dlineTid)).toEqual([
			"dline-read-1",
			"dline-read-2",
			"dline-read-3",
			"dline-read-4",
		])
		expect(runtime.getState()).toMatchObject({
			phase: TaskPhase.BETWEEN_TURNS,
			turn: {
				turnId: "turn:dline-read-1",
				assistantApiIndex: 1,
				blocks: [
					{ dlineTid: "dline-read-1", phase: BlockPhase.COMPLETED },
					{ dlineTid: "dline-read-2", phase: BlockPhase.COMPLETED },
					{ dlineTid: "dline-read-3", phase: BlockPhase.COMPLETED },
					{ dlineTid: "dline-read-4", phase: BlockPhase.COMPLETED },
				],
			},
		})
		// TURN_CREATED + three block events per tool + TURN_COMPLETED.
		expect(postView).toHaveBeenCalledTimes(14)
	})

	it("moves turn-ending native tool calls after regular tool calls", async () => {
		const clineMessages: ClineMessage[] = []
		const toolBlocks: ToolUse[] = [
			{
				type: "tool_use",
				name: ClineDefaultTool.ATTEMPT,
				params: { result: "done" },
				partial: true,
				isNativeToolCall: true,
				function_id: "call-attempt",
				dline_tid: "dline-call-attempt",
				ts: Date.now(),
			},
			{
				type: "tool_use",
				name: ClineDefaultTool.FILE_NEW,
				params: { path: "result.txt", content: "content" },
				partial: true,
				isNativeToolCall: true,
				function_id: "call-write",
				dline_tid: "dline-call-write",
				ts: Date.now(),
			},
		]

		const fakeTask = {
			genMessageTs: () => Date.now(),
			say: async () => undefined,
			messageStateHandler: {
				clineMessages: () => clineMessages,
				updateTaskHistory: async () => {},
				flushMessageUpdate: async (_index: number) => {},
			},
			taskState: {
				assistantMessageContent: [] as AssistantMessageContent[],
				currentStreamingContentIndex: 0,
				userMessageContentReady: true,
			},
		}

		await (
			Task.prototype as unknown as { processNativeToolCalls: (text: string, blocks: ToolUse[]) => Promise<void> }
		).processNativeToolCalls.call(fakeTask, "", toolBlocks)

		assert.deepEqual(
			fakeTask.taskState.assistantMessageContent.map((block) => (block.type === "tool_use" ? block.function_id : "")),
			["call-write", "call-attempt"],
		)
		assert.equal(fakeTask.taskState.currentStreamingContentIndex, 0)
		assert.equal(fakeTask.taskState.userMessageContentReady, false)
	})
})
