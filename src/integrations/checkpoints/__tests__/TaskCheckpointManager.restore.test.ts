import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import type { ClineMessage } from "@/shared/ExtensionMessage"

vi.unmock("@integrations/checkpoints")

import { TaskRuntime } from "@/core/task/runtime/TaskRuntime"
import { createTaskRuntimeState } from "@/core/task/runtime/TaskRuntimeState"
import { TaskPhase } from "@/core/task/TaskPhase"
import { TaskState } from "@/core/task/TaskState"
import { projectTaskView } from "@/core/task/view/TaskViewProjector"
import { createTaskCheckpointManager } from "../index"

interface RestoreHarness {
	manager: ReturnType<typeof createTaskCheckpointManager>
	taskState: TaskState & { taskId: string; askId: string }
	resetHead: ReturnType<typeof vi.fn>
	restoreFiles: ReturnType<typeof vi.fn>
	restoreChatRuntime: ReturnType<typeof vi.fn>
	resumeTask: ReturnType<typeof vi.fn>
	persistTaskHistory: ReturnType<typeof vi.fn>
	postStateToWebview: ReturnType<typeof vi.fn>
	truncateContextHistory: ReturnType<typeof vi.fn>
	truncateApiHistory: ReturnType<typeof vi.fn>
	truncateUiHistory: ReturnType<typeof vi.fn>
	clearTransientClineMessages: ReturnType<typeof vi.fn>
}

function createHarness(
	messages: ClineMessage[],
	trackedFiles?: string[],
	apiHistoryLength = 2,
	workspacePath?: string,
): RestoreHarness {
	const taskState = Object.assign(new TaskState(), {
		taskId: "task-1",
		userMessageContent: [{ type: "text", text: "active user content" }],
		assistantMessageContent: [{ type: "text", text: "active assistant content" }],
		userMessageContentReady: true,
		lastMessageTs: 99,
		askId: "task-1",
		consecutiveMistakeCount: 3,
		autoRetryAttempts: 2,
		consecutiveIdenticalToolCount: 4,
		lastToolName: "replace_in_file",
		lastToolParams: "stale-params",
	})
	const resetHead = vi.fn().mockResolvedValue(undefined)
	const restoreFiles = vi.fn().mockResolvedValue(undefined)
	const restoreChatRuntime = vi.fn().mockResolvedValue(undefined)
	const resumeTask = vi.fn().mockResolvedValue(undefined)
	const truncateApiHistory = vi.fn().mockResolvedValue(undefined)
	const truncateUiHistory = vi.fn().mockResolvedValue(undefined)
	const apiConversation = {
		count: apiHistoryLength,
		truncateByLineNum: truncateApiHistory,
		getAt: vi.fn(),
	}
	const uiMessage = { count: messages.length, truncateByLineNum: truncateUiHistory }
	const persistTaskHistory = vi.fn().mockResolvedValue(undefined)
	const postStateToWebview = vi.fn().mockResolvedValue(undefined)
	const truncateContextHistory = vi.fn().mockResolvedValue(undefined)
	const clearTransientClineMessages = vi.fn().mockReturnValue([])
	const messageStateHandler = {
		clineMessages: messages,
		// Restore reads the durable sequence, which excludes presentation overlays.
		// These fixtures carry durable rows only, so both views are identical here.
		durableClineMessages: messages,
		clearTransientClineMessages,
		apiConversationHistory: Array.from({ length: apiHistoryLength }, (_, index) => ({
			role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
			content: `message-${index}`,
		})),
		apiConversation,
		uiMessage,
		updateTaskHistory: persistTaskHistory,
		setCheckpointTracker: vi.fn(),
	}
	const manager = createTaskCheckpointManager(
		{
			taskId: "task-1",
			controller: { task: { resumeTask } },
		} as never,
		{ enableCheckpoints: true },
		{
			fileContextTracker: { detectFilesEditedAfterMessage: vi.fn().mockResolvedValue([]) },
			contextManager: { truncateContextHistory },
			diffViewProvider: {},
			messageStateHandler,
			taskState,
			...(trackedFiles === undefined
				? {}
				: { taskFileTracker: { getAllModifiedFiles: vi.fn().mockReturnValue(trackedFiles) } }),
			...(workspacePath
				? {
						workspaceManager: {
							getPrimaryRoot: () => ({ path: workspacePath }),
							getRoots: () => [{ path: workspacePath }],
						},
					}
				: {}),
		} as never,
		{
			updateTaskHistory: vi.fn().mockResolvedValue([]),
			cancelTask: vi.fn().mockResolvedValue(undefined),
			restoreChatRuntime,
			say: vi.fn().mockResolvedValue(100),
			postStateToWebview,
		} as never,
		{
			checkpointTracker: { resetHead, restoreFiles } as never,
		},
	)
	return {
		manager,
		taskState,
		resetHead,
		restoreFiles,
		restoreChatRuntime,
		resumeTask,
		persistTaskHistory,
		postStateToWebview,
		truncateContextHistory,
		truncateApiHistory,
		truncateUiHistory,
		clearTransientClineMessages,
	}
}

describe("TaskCheckpointManager restore isolation", () => {
	it("restores workspace files without clearing active chat state", async () => {
		const harness = createHarness([{ ts: 42, type: "say", say: "checkpoint_created", lastCheckpointHash: ["hash-1"] }])

		await harness.manager.restoreCheckpoint(42, "workspace")

		expect(harness.resetHead).toHaveBeenCalledWith("hash-1")
		expect(harness.taskState).toMatchObject({
			userMessageContent: [{ type: "text", text: "active user content" }],
			assistantMessageContent: [{ type: "text", text: "active assistant content" }],
			userMessageContentReady: true,
			lastMessageTs: 99,
			consecutiveMistakeCount: 3,
			autoRetryAttempts: 2,
			consecutiveIdenticalToolCount: 4,
			lastToolName: "replace_in_file",
			lastToolParams: "stale-params",
		})
		expect(harness.restoreChatRuntime).not.toHaveBeenCalled()
		expect(harness.resumeTask).not.toHaveBeenCalled()
		// A file-only restore must not touch conversation presentation state.
		expect(harness.clearTransientClineMessages).not.toHaveBeenCalled()
	})

	it("resolves a current single root by persisted identity instead of the first hash", async () => {
		const rootA = path.resolve("C:/workspace-a")
		const rootB = path.resolve("C:/workspace-b")
		const harness = createHarness(
			[
				{
					ts: 42,
					type: "say",
					say: "checkpoint_created",
					lastCheckpointHash: ["hash-a", "hash-b"],
					checkpointWorkspaceRoots: [rootA, rootB],
				},
			],
			undefined,
			2,
			rootB,
		)

		await harness.manager.restoreCheckpoint(42, "workspace")

		expect(harness.resetHead).toHaveBeenCalledWith("hash-b")
	})

	it("truncates a durable compaction failure card that follows the restore point", async () => {
		// A failed compaction carries no compactionConversationRange, so it is an ordinary
		// durable row. Restoring an earlier point must rewind past it and remove it.
		const failureCard: ClineMessage = {
			ts: 43,
			type: "say",
			say: "tool",
			partial: false,
			conversationHistoryIndex: 1,
			text: JSON.stringify({
				tool: "summarizeTask",
				content: "",
				compactionStatus: "failed",
				compactionUnitKind: "failure",
				error: "Internal compaction Pass did not return a valid summarize_task context",
			}),
		} as ClineMessage
		const harness = createHarness([
			{ ts: 42, type: "say", say: "checkpoint_created", lastCheckpointHash: ["hash-1"] },
			failureCard,
		])

		await harness.manager.restoreCheckpoint(42, "task")

		// uiKeepCount stops at the restored checkpoint row, so the failure card is dropped.
		expect(harness.truncateUiHistory).toHaveBeenCalledWith(1)
	})

	it("drops transient presentation overlays before resolving the chat boundary", async () => {
		const harness = createHarness([
			{ ts: 42, type: "say", say: "checkpoint_created", lastCheckpointHash: ["hash-1"] },
			{ ts: 43, type: "say", say: "text", text: "later" },
		])

		await harness.manager.restoreCheckpoint(42, "task")

		expect(harness.clearTransientClineMessages).toHaveBeenCalledOnce()
		expect(harness.clearTransientClineMessages.mock.invocationCallOrder[0]).toBeLessThan(
			harness.truncateUiHistory.mock.invocationCallOrder[0],
		)
	})

	it("restores only files owned by the active task when file tracking is available", async () => {
		const taskFiles = ["e:/workspace/panel-a-checkpoint.txt"]
		const harness = createHarness(
			[{ ts: 42, type: "say", say: "checkpoint_created", lastCheckpointHash: ["hash-1"] }],
			taskFiles,
		)

		await harness.manager.restoreCheckpoint(42, "workspace")

		expect(harness.restoreFiles).toHaveBeenCalledWith("hash-1", taskFiles)
		expect(harness.resetHead).not.toHaveBeenCalled()
	})

	it("projects the restored chat Resume as an interaction continuation instead of a task reload", async () => {
		const harness = createHarness([
			{ ts: 42, type: "say", say: "text", conversationHistoryIndex: 0 },
			{ ts: 43, type: "say", say: "text" },
		])
		const runtime = new TaskRuntime(createTaskRuntimeState({ taskId: "task-1", phase: TaskPhase.STREAMING, revision: 3 }), {
			postView: async () => {},
			persistSnapshot: async () => {},
			cancelRuntime: async () => {},
			prepareResume: async () => {},
			startApi: async () => {},
			executeTool: async () => {},
			appendSay: async () => {},
			appendAsk: async () => ({ uiMessageTs: 100 }),
			startNewTask: async () => {},
		})
		harness.restoreChatRuntime.mockImplementationOnce(async ({ apiIndex }: { apiIndex: number }) => {
			await runtime.dispatch({ type: "CHECKPOINT_CHAT_RESTORED", apiIndex })
		})

		await harness.manager.restoreCheckpoint(42, "task")

		const view = projectTaskView(runtime.getState())
		expect(view.activeInteraction).toMatchObject({ kind: "resume", status: "awaiting" })
		expect(view.footer.actions).toEqual([expect.objectContaining({ type: "resume" })])
		expect(view.footer.actions[0]?.dispatchTarget).not.toBe("task")
	})

	it("restores chat into a canonical paused runtime without auto-resuming", async () => {
		const harness = createHarness([
			{ ts: 42, type: "say", say: "text", conversationHistoryIndex: 0 },
			{ ts: 43, type: "say", say: "text" },
		])

		await harness.manager.restoreCheckpoint(42, "task")

		expect(harness.restoreChatRuntime).toHaveBeenCalledWith({ apiIndex: 1 })
		expect(harness.resumeTask).not.toHaveBeenCalled()
		expect(harness.truncateContextHistory).toHaveBeenCalledWith(42, expect.any(String))
	})

	it("clears mistake-limit detector state when restoring chat", async () => {
		const harness = createHarness([
			{ ts: 42, type: "say", say: "text", conversationHistoryIndex: 0 },
			{ ts: 43, type: "say", say: "text" },
		])

		await harness.manager.restoreCheckpoint(42, "task")

		expect(harness.taskState).toMatchObject({
			consecutiveMistakeCount: 0,
			autoRetryAttempts: 0,
			consecutiveIdenticalToolCount: 0,
			lastToolName: "",
			lastToolParams: "",
		})
	})

	it("restores chat and workspace through one combined success projection", async () => {
		const messages: ClineMessage[] = [
			{
				ts: 42,
				type: "say",
				say: "checkpoint_created",
				conversationHistoryIndex: 0,
				lastCheckpointHash: ["hash-1"],
			},
			{ ts: 43, type: "say", say: "text" },
		]
		const harness = createHarness(messages)

		await harness.manager.restoreCheckpoint(42, "taskAndWorkspace")

		expect(harness.resetHead).toHaveBeenCalledOnce()
		expect(harness.resetHead).toHaveBeenCalledWith("hash-1")
		expect(harness.restoreChatRuntime).toHaveBeenCalledOnce()
		expect(messages[0]?.isCheckpointCheckedOut).toBe(true)
		expect(harness.persistTaskHistory).toHaveBeenCalledOnce()
		expect(harness.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("uses the preceding file checkpoint while restoring the selected chat point", async () => {
		const harness = createHarness([
			{ ts: 41, type: "say", say: "checkpoint_created", lastCheckpointHash: ["fallback-hash"] },
			{ ts: 42, type: "say", say: "text", conversationHistoryIndex: 0 },
			{ ts: 43, type: "say", say: "text" },
		])

		await harness.manager.restoreCheckpoint(42, "taskAndWorkspace")

		expect(harness.resetHead).toHaveBeenCalledWith("fallback-hash")
		expect(harness.restoreChatRuntime).toHaveBeenCalledOnce()
	})

	it("restores chat when a combined restore has no file checkpoint hash", async () => {
		const harness = createHarness([
			{ ts: 42, type: "say", say: "text", conversationHistoryIndex: 0 },
			{ ts: 43, type: "say", say: "text" },
		])

		const result = await harness.manager.restoreCheckpoint(42, "taskAndWorkspace")

		expect(harness.resetHead).not.toHaveBeenCalled()
		expect(harness.restoreChatRuntime).toHaveBeenCalledOnce()
		expect(harness.restoreChatRuntime).toHaveBeenCalledWith({ apiIndex: 1 })
		expect(result.checkpointManagerErrorMessage).toBe("Failed to restore checkpoint: No valid checkpoint hash found")
		expect(harness.persistTaskHistory).toHaveBeenCalledOnce()
		expect(harness.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("restores chat when resetting workspace files fails", async () => {
		const harness = createHarness([
			{
				ts: 42,
				type: "say",
				say: "checkpoint_created",
				conversationHistoryIndex: 0,
				lastCheckpointHash: ["hash-1"],
			},
			{ ts: 43, type: "say", say: "text" },
		])
		harness.resetHead.mockRejectedValueOnce(new Error("reset failed"))

		const result = await harness.manager.restoreCheckpoint(42, "taskAndWorkspace")

		expect(harness.restoreChatRuntime).toHaveBeenCalledOnce()
		expect(result.checkpointManagerErrorMessage).toBe("Failed to restore checkpoint: reset failed")
	})

	it("keeps chat untouched when a workspace-only restore has no hash", async () => {
		const harness = createHarness([{ ts: 42, type: "say", say: "text", conversationHistoryIndex: 0 }])

		const result = await harness.manager.restoreCheckpoint(42, "workspace")

		expect(harness.resetHead).not.toHaveBeenCalled()
		expect(harness.restoreChatRuntime).not.toHaveBeenCalled()
		expect(harness.taskState).toMatchObject({
			userMessageContent: [{ type: "text", text: "active user content" }],
			assistantMessageContent: [{ type: "text", text: "active assistant content" }],
			userMessageContentReady: true,
			lastMessageTs: 99,
		})
		expect(harness.persistTaskHistory).not.toHaveBeenCalled()
		expect(harness.postStateToWebview).not.toHaveBeenCalled()
		expect(result.checkpointManagerErrorMessage).toBe("Failed to restore checkpoint: No valid checkpoint hash found")
	})

	it("restores a completed compaction card to its pre-compaction boundary through the ordinary transaction", async () => {
		const messages: ClineMessage[] = [
			{ ts: 10, type: "say", say: "task", conversationHistoryIndex: 0 },
			{ ts: 20, type: "say", say: "text", conversationHistoryIndex: 1 },
			{
				ts: 30,
				type: "say",
				say: "tool",
				conversationHistoryIndex: 3,
				conversationHistoryDeletedRange: [0, 1],
				compactionConversationRange: {
					logicalTurnRange: [0, 1],
					apiConversationRange: [0, 2],
					preCompactionApiEndIndex: 3,
				},
				text: JSON.stringify({ tool: "summarizeTask", content: "summary", compactionStatus: "completed" }),
			},
			{ ts: 40, type: "say", say: "text", conversationHistoryIndex: 4 },
		]
		const harness = createHarness(messages, undefined, 5)

		await harness.manager.restoreCheckpoint(30, "task")

		expect(harness.truncateApiHistory).toHaveBeenCalledOnce()
		expect(harness.truncateApiHistory).toHaveBeenCalledWith(4)
		expect(harness.truncateUiHistory).toHaveBeenCalledOnce()
		expect(harness.truncateUiHistory).toHaveBeenCalledWith(2)
		expect(harness.truncateContextHistory).toHaveBeenCalledWith(20, expect.any(String))
		expect(harness.restoreChatRuntime).toHaveBeenCalledOnce()
		expect(harness.restoreChatRuntime).toHaveBeenCalledWith({ apiIndex: 3 })
		expect(harness.taskState.conversationHistoryDeletedRange).toEqual([0, 1])
		expect(harness.resetHead).not.toHaveBeenCalled()
	})

	it("rejects an invalid compaction boundary before mutating API, UI, context, or runtime", async () => {
		const messages: ClineMessage[] = [
			{ ts: 10, type: "say", say: "task", conversationHistoryIndex: 0 },
			{
				ts: 30,
				type: "say",
				say: "tool",
				conversationHistoryIndex: 8,
				compactionConversationRange: {
					logicalTurnRange: [0, 0],
					apiConversationRange: [0, 1],
					preCompactionApiEndIndex: 8,
				},
				text: JSON.stringify({ tool: "summarizeTask", content: "summary", compactionStatus: "completed" }),
			},
		]
		const harness = createHarness(messages, undefined, 3)

		const result = await harness.manager.restoreCheckpoint(30, "task")

		expect(result.checkpointManagerErrorMessage).toMatch(/inconsistent with the current conversation/)
		expect(harness.truncateApiHistory).not.toHaveBeenCalled()
		expect(harness.truncateUiHistory).not.toHaveBeenCalled()
		expect(harness.truncateContextHistory).not.toHaveBeenCalled()
		expect(harness.restoreChatRuntime).not.toHaveBeenCalled()
		expect(harness.persistTaskHistory).not.toHaveBeenCalled()
	})

	it("continues an edited chat restore exactly once through the typed runtime", async () => {
		const harness = createHarness([
			{ ts: 42, type: "say", say: "text", conversationHistoryIndex: 0 },
			{ ts: 43, type: "say", say: "text" },
		])

		await harness.manager.restoreCheckpoint(42, "task", undefined, "edited input")

		expect(harness.restoreChatRuntime).toHaveBeenCalledOnce()
		expect(harness.restoreChatRuntime).toHaveBeenCalledWith({ apiIndex: 1, editedText: "edited input" })
		expect(harness.resetHead).not.toHaveBeenCalled()
		expect(harness.resumeTask).not.toHaveBeenCalled()
	})
})
