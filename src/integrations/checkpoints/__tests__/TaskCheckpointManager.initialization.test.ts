import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type CheckpointTracker from "@integrations/checkpoints/CheckpointTracker"
import { ensureCheckpointInitialized } from "@integrations/checkpoints/initializer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UIMessage } from "@/core/storage/UIMessage"
import { MessageStateHandler } from "@/core/task/message-state"
import { TaskState } from "@/core/task/TaskState"
import type { ClineMessage } from "@/shared/ExtensionMessage"

vi.unmock("@integrations/checkpoints")

import { createTaskCheckpointManager } from "../index"

type CreateCheckpointTracker = (
	taskId: string,
	enableCheckpoints: boolean,
	workspacePath: string,
) => Promise<CheckpointTracker | undefined>

function createManager(
	createCheckpointTracker: CreateCheckpointTracker,
	initialError?: string,
	options?: { messages?: ClineMessage[]; tracker?: CheckpointTracker },
) {
	const messages = options?.messages ?? []
	const taskState: { taskId: string; checkpointManagerErrorMessage?: string } = {
		taskId: "task-1",
		...(initialError === undefined ? {} : { checkpointManagerErrorMessage: initialError }),
	}
	const setCheckpointTracker = vi.fn()
	const postStateToWebview = vi.fn().mockResolvedValue(undefined)
	const say = vi.fn(async () => {
		const message: ClineMessage = { ts: 42, type: "say", say: "checkpoint_created" }
		messages.push(message)
		return message.ts
	})
	const updateClineMessage = vi.fn(async (index: number, updates: Partial<ClineMessage>) => {
		Object.assign(messages[index], updates)
	})
	const flushMessageUpdate = vi.fn().mockResolvedValue(undefined)
	const manager = createTaskCheckpointManager(
		{ taskId: "task-1", controller: {} } as never,
		{ enableCheckpoints: true, createCheckpointTracker },
		{
			fileContextTracker: {},
			diffViewProvider: {},
			messageStateHandler: {
				clineMessages: messages,
				setCheckpointTracker,
				updateClineMessage,
				flushMessageUpdate,
				updateTaskHistory: vi.fn().mockResolvedValue(undefined),
			},
			taskState,
			workspaceManager: { getPrimaryRoot: () => ({ path: "C:/workspace" }) },
		} as never,
		{
			updateTaskHistory: vi.fn(),
			cancelTask: vi.fn(),
			restoreChatRuntime: vi.fn(),
			say,
			postStateToWebview,
		} as never,
		{
			checkpointManagerErrorMessage: initialError,
			...(options?.tracker ? { checkpointTracker: options.tracker } : {}),
		},
	)
	return { manager, taskState, setCheckpointTracker, postStateToWebview, updateClineMessage, flushMessageUpdate }
}

describe("TaskCheckpointManager checkpoint initialization", () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it("retries a transient shadow initialization failure and clears the projected error", async () => {
		const tracker = { setTaskFileTracker: vi.fn() } as never
		const create = vi
			.fn<CreateCheckpointTracker>()
			.mockRejectedValueOnce(new Error("EBUSY: shadow index is locked"))
			.mockResolvedValueOnce(tracker)
		const harness = createManager(create, "Previous checkpoint initialization failed")

		const result = await harness.manager.retryCheckpointInitialization()

		expect(result).toBe(true)
		expect(create).toHaveBeenCalledTimes(2)
		expect(harness.setCheckpointTracker).toHaveBeenCalledWith(tracker)
		expect(harness.taskState.checkpointManagerErrorMessage).toBeUndefined()
		expect(harness.postStateToWebview).toHaveBeenCalled()
	})

	it("uses a 120 second total initialization budget by default", async () => {
		vi.useFakeTimers()
		try {
			const checkpointManager = {
				checkpointTrackerCheckAndInit: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 90_000))),
			} as never
			const initialization = expect(ensureCheckpointInitialized({ checkpointManager })).resolves.toBeUndefined()

			await vi.advanceTimersByTimeAsync(90_000)

			await initialization
		} finally {
			vi.useRealTimers()
		}
	})

	it("allows a slow shadow initialization to complete within the extended attempt budget", async () => {
		vi.useFakeTimers()
		try {
			const tracker = { setTaskFileTracker: vi.fn() } as never
			const slowTracker = new Promise<CheckpointTracker | undefined>((resolve) =>
				setTimeout(() => resolve(tracker), 45_000),
			)
			const create = vi.fn<CreateCheckpointTracker>(() => slowTracker)
			const harness = createManager(create)

			const initialization = harness.manager.retryCheckpointInitialization()
			await vi.advanceTimersByTimeAsync(45_000)

			await expect(initialization).resolves.toBe(true)
			expect(create).toHaveBeenCalledOnce()
			expect(harness.setCheckpointTracker).toHaveBeenCalledWith(tracker)
		} finally {
			vi.useRealTimers()
		}
	})

	it("reuses the timed-out attempt on retry instead of starting a second tracker", async () => {
		vi.useFakeTimers()
		try {
			const tracker = { setTaskFileTracker: vi.fn() } as never
			// Resolves after the 55s attempt timeout but well within the retry wait:
			// the first attempt times out, the retry must join this same promise.
			const slowTracker = new Promise<CheckpointTracker | undefined>((resolve) =>
				setTimeout(() => resolve(tracker), 60_000),
			)
			const create = vi.fn<CreateCheckpointTracker>(() => slowTracker)
			const harness = createManager(create)

			const initialization = harness.manager.retryCheckpointInitialization()
			await vi.advanceTimersByTimeAsync(60_100)

			await expect(initialization).resolves.toBe(true)
			// A second create would have raced the first for the shadow-repo mutex
			// and repeated the full baseline scan.
			expect(create).toHaveBeenCalledOnce()
			expect(harness.setCheckpointTracker).toHaveBeenCalledWith(tracker)
		} finally {
			vi.useRealTimers()
		}
	})

	it("creates a chat-only checkpoint when Git initialization is unavailable", async () => {
		const messages: ClineMessage[] = []
		const create = vi.fn<CreateCheckpointTracker>().mockRejectedValue(new Error("Git must be installed to use checkpoints."))
		const harness = createManager(create, undefined, { messages })

		await harness.manager.saveCheckpoint()

		expect(create).toHaveBeenCalledOnce()
		expect(messages).toEqual([expect.objectContaining({ say: "checkpoint_created" })])
		expect(messages[0]).not.toHaveProperty("lastCheckpointHash")
		expect(harness.taskState.checkpointManagerErrorMessage).toContain("Git must be installed")
	})

	it("binds the first chat checkpoint to the initialized shadow baseline when no files were tracked", async () => {
		const messages: ClineMessage[] = []
		const baselineHash = "shadow-baseline-hash"
		const tracker = {
			setTaskFileTracker: vi.fn(),
			commit: vi.fn().mockResolvedValue(baselineHash),
		} as unknown as CheckpointTracker
		const create = vi.fn<CreateCheckpointTracker>().mockResolvedValue(tracker)
		const harness = createManager(create, undefined, { messages, tracker })

		await harness.manager.saveCheckpoint()

		expect(tracker.commit).toHaveBeenCalledOnce()
		expect(messages).toEqual([
			expect.objectContaining({
				say: "checkpoint_created",
				lastCheckpointHash: [baselineHash],
				checkpointWorkspaceRoots: ["C:/workspace"],
			}),
		])
		expect(harness.updateClineMessage).toHaveBeenCalledWith(0, {
			lastCheckpointHash: [baselineHash],
			checkpointWorkspaceRoots: ["C:/workspace"],
		})
		expect(harness.flushMessageUpdate).toHaveBeenCalledWith(0)
		expect(harness.updateClineMessage.mock.invocationCallOrder[0]).toBeLessThan(
			harness.flushMessageUpdate.mock.invocationCallOrder[0],
		)
		expect(harness.flushMessageUpdate.mock.invocationCallOrder[0]).toBeLessThan(
			harness.postStateToWebview.mock.invocationCallOrder[0],
		)
	})

	it("durably binds a completion checkpoint before posting its updated UI state", async () => {
		const completionMessage: ClineMessage = { ts: 84, type: "say", say: "completion_result" }
		const messages = [completionMessage]
		const completionHash = "completion-checkpoint-hash"
		const tracker = {
			setTaskFileTracker: vi.fn(),
			commit: vi.fn().mockResolvedValue(completionHash),
			getConsecutiveStagingFailures: vi.fn().mockReturnValue(0),
		} as unknown as CheckpointTracker
		const harness = createManager(vi.fn<CreateCheckpointTracker>().mockResolvedValue(tracker), undefined, {
			messages,
			tracker,
		})

		await harness.manager.saveCheckpoint(true, completionMessage.ts)

		expect(messages[0]).toEqual(
			expect.objectContaining({ lastCheckpointHash: [completionHash], checkpointWorkspaceRoots: ["C:/workspace"] }),
		)
		expect(harness.updateClineMessage).toHaveBeenCalledWith(0, {
			lastCheckpointHash: [completionHash],
			checkpointWorkspaceRoots: ["C:/workspace"],
		})
		expect(harness.flushMessageUpdate).toHaveBeenCalledWith(0)
		expect(harness.flushMessageUpdate.mock.invocationCallOrder[0]).toBeLessThan(
			harness.postStateToWebview.mock.invocationCallOrder[0],
		)
	})

	it("reopens the checkpoint hash from ui_messages.jsonl before publishing the committed state", async () => {
		const previousDocsDir = process.env.DLINE_DOCS_DIR
		const docsDir = await mkdtemp(path.join(os.tmpdir(), "dline-checkpoint-message-"))
		process.env.DLINE_DOCS_DIR = docsDir
		try {
			const taskId = "task-durable-checkpoint-message"
			const checkpointHash = "durable-checkpoint-hash"
			const uiMessage = await UIMessage.open(taskId)
			const messageStateHandler = new MessageStateHandler({
				taskId,
				ulid: "ulid-durable-checkpoint-message",
				taskState: new TaskState(),
				uiMessage,
				updateTaskHistory: async () => [],
			})
			const tracker = {
				setTaskFileTracker: vi.fn(),
				commit: vi.fn().mockResolvedValue(checkpointHash),
			} as unknown as CheckpointTracker
			let nextMessageTs = 100
			const hashesObservedByPost: Array<string[] | undefined> = []
			const postStateToWebview = vi.fn(async () => {
				const reopenedAtPost = await UIMessage.open(taskId)
				hashesObservedByPost.push(reopenedAtPost.getAll().at(-1)?.lastCheckpointHash)
			})
			const manager = createTaskCheckpointManager(
				{ taskId, controller: {} } as never,
				{ enableCheckpoints: true, createCheckpointTracker: vi.fn().mockResolvedValue(tracker) },
				{
					fileContextTracker: {},
					diffViewProvider: {},
					messageStateHandler,
					taskState: new TaskState(),
					workspaceManager: { getPrimaryRoot: () => ({ path: "C:/workspace" }) },
				} as never,
				{
					updateTaskHistory: vi.fn(),
					cancelTask: vi.fn(),
					restoreChatRuntime: vi.fn(),
					say: async () => {
						const ts = ++nextMessageTs
						await messageStateHandler.addToClineMessages({ ts, type: "say", say: "checkpoint_created" })
						await postStateToWebview()
						return ts
					},
					postStateToWebview,
				} as never,
				{ checkpointTracker: tracker },
			)

			await manager.saveCheckpoint()

			const reopened = await UIMessage.open(taskId)
			expect(reopened.getAll().at(-1)?.lastCheckpointHash).toEqual([checkpointHash])
			expect(hashesObservedByPost.at(-1)).toEqual([checkpointHash])
		} finally {
			if (previousDocsDir === undefined) delete process.env.DLINE_DOCS_DIR
			else process.env.DLINE_DOCS_DIR = previousDocsDir
			await rm(docsDir, { force: true, recursive: true })
		}
	})

	it("does not retry a permanent missing Git capability error", async () => {
		const create = vi.fn<CreateCheckpointTracker>().mockRejectedValue(new Error("Git must be installed to use checkpoints."))
		const harness = createManager(create)

		const result = await harness.manager.retryCheckpointInitialization()

		expect(result).toBe(false)
		expect(create).toHaveBeenCalledOnce()
		expect(harness.taskState.checkpointManagerErrorMessage).toContain("Git must be installed")
	})
})
