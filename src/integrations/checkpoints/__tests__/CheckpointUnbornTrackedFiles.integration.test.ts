import fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import simpleGit from "simple-git"
import { describe, expect, it, vi } from "vitest"
import { TaskState } from "@/core/task/TaskState"
import type { ClineMessage, ClineSay } from "@/shared/ExtensionMessage"

vi.unmock("@integrations/checkpoints")

import { GitOperations } from "../CheckpointGitOperations"
import CheckpointTracker from "../CheckpointTracker"
import { getShadowGitPath, hashWorkingDir } from "../CheckpointUtils"
import { createTaskCheckpointManager } from "../index"
import { TaskFileTracker } from "../TaskFileTracker"
import { WorkspaceFileRegistry } from "../WorkspaceFileRegistry"

interface CheckpointSandbox {
	sandbox: string
	workspacePath: string
	documentsPath: string
	trackedFile: string
	staleFile: string
	missingFile: string
	previousDocumentsPath: string | undefined
}

/** Create one single-root user repository whose HEAD is unborn. */
async function createUnbornSandbox(): Promise<CheckpointSandbox> {
	const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "dline-unborn-tracked-"))
	const workspacePath = path.join(sandbox, "workspace")
	const documentsPath = path.join(sandbox, "documents")
	const trackedFile = path.join(workspacePath, "write_test.txt")
	const staleFile = path.join(workspacePath, "stale_test.txt")
	const missingFile = path.join(workspacePath, "missing_test.txt")
	const previousDocumentsPath = process.env.DLINE_DOCS_DIR
	process.env.DLINE_DOCS_DIR = documentsPath
	await fs.mkdir(workspacePath, { recursive: true })
	await fs.writeFile(trackedFile, "before checkpoint")
	await fs.writeFile(staleFile, "before deletion")
	await simpleGit(workspacePath).init()
	return {
		sandbox,
		workspacePath,
		documentsPath,
		trackedFile,
		staleFile,
		missingFile,
		previousDocumentsPath,
	}
}

async function disposeSandbox(input: CheckpointSandbox): Promise<void> {
	if (input.previousDocumentsPath === undefined) delete process.env.DLINE_DOCS_DIR
	else process.env.DLINE_DOCS_DIR = input.previousDocumentsPath
	await fs.rm(input.sandbox, { recursive: true, force: true })
}

function expectCheckpointHash(value: string | undefined): asserts value is string {
	expect(value).toMatch(/^[0-9a-f]{40}$/)
}

function createManagerHarness(input: {
	taskId: string
	workspacePath: string
	taskFileTracker: TaskFileTracker
	messages: ClineMessage[]
}) {
	const setCheckpointTracker = vi.fn()
	const updateTaskHistory = vi.fn().mockResolvedValue(undefined)
	let nextMessageTs = 200
	const say = vi.fn(async (type: ClineSay) => {
		const message: ClineMessage = {
			ts: ++nextMessageTs,
			type: "say",
			say: type,
		}
		input.messages.push(message)
		return message.ts
	})
	const manager = createTaskCheckpointManager(
		{ taskId: input.taskId, controller: {} } as never,
		{
			enableCheckpoints: true,
			createCheckpointTracker: (taskId, enableCheckpoints, workspacePath) =>
				CheckpointTracker.create(taskId, enableCheckpoints, workspacePath),
		},
		{
			fileContextTracker: {},
			diffViewProvider: {},
			messageStateHandler: {
				clineMessages: input.messages,
				setCheckpointTracker,
				updateClineMessage: async (index: number, updates: Partial<ClineMessage>) => {
					Object.assign(input.messages[index], updates)
				},
				flushMessageUpdate: vi.fn().mockResolvedValue(undefined),
				updateTaskHistory,
			},
			taskState: new TaskState(),
			taskFileTracker: input.taskFileTracker,
			workspaceManager: {
				getPrimaryRoot: () => ({ path: input.workspacePath }),
			},
		} as never,
		{
			updateTaskHistory: vi.fn().mockResolvedValue([]),
			cancelTask: vi.fn().mockResolvedValue(undefined),
			restoreChatRuntime: vi.fn().mockResolvedValue(undefined),
			say,
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		} as never,
		{},
	)

	return { manager, setCheckpointTracker, updateTaskHistory }
}

describe("CheckpointTracker with tracked files in an unborn user repository", () => {
	it("does not create an empty baseline commit when an existing shadow already matches the workspace", async () => {
		const sandbox = await createUnbornSandbox()
		const firstTaskId = "task-clean-shadow-first"
		const nextTaskId = "task-clean-shadow-next"
		try {
			const firstTracker = await CheckpointTracker.create(firstTaskId, true, sandbox.workspacePath)
			if (!firstTracker) throw new Error("checkpoint_tracker_missing")
			firstTracker.setTaskFileTracker(new TaskFileTracker(firstTaskId))
			const firstHash = await firstTracker.commit()
			expectCheckpointHash(firstHash)

			const nextTracker = await CheckpointTracker.create(nextTaskId, true, sandbox.workspacePath)
			if (!nextTracker) throw new Error("checkpoint_tracker_missing")
			nextTracker.setTaskFileTracker(new TaskFileTracker(nextTaskId))
			const nextHash = await nextTracker.commit()

			expect(nextHash).toBe(firstHash)
		} finally {
			WorkspaceFileRegistry.getInstance().releaseTask(firstTaskId)
			WorkspaceFileRegistry.getInstance().releaseTask(nextTaskId)
			await disposeSandbox(sandbox)
		}
	})

	it("refreshes an existing shadow baseline before the next task reuses an empty checkpoint", async () => {
		const sandbox = await createUnbornSandbox()
		const firstTaskId = "task-existing-shadow-first"
		const nextTaskId = "task-existing-shadow-next"
		try {
			const firstTracker = await CheckpointTracker.create(firstTaskId, true, sandbox.workspacePath)
			if (!firstTracker) throw new Error("checkpoint_tracker_missing")
			const firstTaskFiles = new TaskFileTracker(firstTaskId)
			firstTracker.setTaskFileTracker(firstTaskFiles)
			const firstHash = await firstTracker.commit()
			expectCheckpointHash(firstHash)

			await fs.writeFile(sandbox.trackedFile, "changed before the next task")
			const nextTracker = await CheckpointTracker.create(nextTaskId, true, sandbox.workspacePath)
			if (!nextTracker) throw new Error("checkpoint_tracker_missing")
			const nextTaskFiles = new TaskFileTracker(nextTaskId)
			nextTracker.setTaskFileTracker(nextTaskFiles)
			const nextHash = await nextTracker.commit()
			expectCheckpointHash(nextHash)

			const shadowGitPath = await getShadowGitPath(hashWorkingDir(sandbox.workspacePath))
			const shadowGit = simpleGit(path.dirname(shadowGitPath))
			expect(nextHash).not.toBe(firstHash)
			expect(await shadowGit.show([`${nextHash}:write_test.txt`])).toBe("changed before the next task")
		} finally {
			WorkspaceFileRegistry.getInstance().releaseTask(firstTaskId)
			WorkspaceFileRegistry.getInstance().releaseTask(nextTaskId)
			await disposeSandbox(sandbox)
		}
	})

	it("reuses the shadow index for an unchanged exclusion ruleset instead of rebuilding it", async () => {
		const sandbox = await createUnbornSandbox()
		const firstTaskId = "task-index-reuse-first"
		const nextTaskId = "task-index-reuse-next"
		try {
			const firstTracker = await CheckpointTracker.create(firstTaskId, true, sandbox.workspacePath)
			if (!firstTracker) throw new Error("checkpoint_tracker_missing")
			firstTracker.setTaskFileTracker(new TaskFileTracker(firstTaskId))
			expectCheckpointHash(await firstTracker.commit())

			// Discarding the index forces git to re-hash every tracked file. That is
			// only justified when the exclusion ruleset changed, because nothing else
			// can invalidate an already-indexed entry.
			const modes: string[] = []
			const addCheckpointFiles = GitOperations.prototype.addCheckpointFiles
			const spy = vi.spyOn(GitOperations.prototype, "addCheckpointFiles").mockImplementation(async function (
				this: GitOperations,
				options,
			) {
				if (options.taskId === nextTaskId) modes.push(options.mode)
				return addCheckpointFiles.call(this, options)
			})
			try {
				await fs.writeFile(sandbox.trackedFile, "changed without touching exclusions")
				const nextTracker = await CheckpointTracker.create(nextTaskId, true, sandbox.workspacePath)
				if (!nextTracker) throw new Error("checkpoint_tracker_missing")
				nextTracker.setTaskFileTracker(new TaskFileTracker(nextTaskId))
				const nextHash = await nextTracker.commit()
				expectCheckpointHash(nextHash)

				expect(modes).not.toContain("baseline")
				const shadowGitPath = await getShadowGitPath(hashWorkingDir(sandbox.workspacePath))
				const shadowGit = simpleGit(path.dirname(shadowGitPath))
				expect(await shadowGit.show([`${nextHash}:write_test.txt`])).toBe("changed without touching exclusions")
			} finally {
				spy.mockRestore()
			}
		} finally {
			WorkspaceFileRegistry.getInstance().releaseTask(firstTaskId)
			WorkspaceFileRegistry.getInstance().releaseTask(nextTaskId)
			await disposeSandbox(sandbox)
		}
	})

	it("rebuilds the shadow index when the exclusion ruleset changed", async () => {
		const sandbox = await createUnbornSandbox()
		const firstTaskId = "task-index-rebuild-first"
		const nextTaskId = "task-index-rebuild-next"
		try {
			const firstTracker = await CheckpointTracker.create(firstTaskId, true, sandbox.workspacePath)
			if (!firstTracker) throw new Error("checkpoint_tracker_missing")
			firstTracker.setTaskFileTracker(new TaskFileTracker(firstTaskId))
			expectCheckpointHash(await firstTracker.commit())

			const modes: string[] = []
			const addCheckpointFiles = GitOperations.prototype.addCheckpointFiles
			const spy = vi.spyOn(GitOperations.prototype, "addCheckpointFiles").mockImplementation(async function (
				this: GitOperations,
				options,
			) {
				if (options.taskId === nextTaskId) modes.push(options.mode)
				return addCheckpointFiles.call(this, options)
			})
			try {
				// Checkpoints follow the repository's own rules, so only .gitignore
				// (plus the built-in floor) can change what the shadow index tracks.
				await fs.writeFile(path.join(sandbox.workspacePath, ".gitignore"), "stale_test.txt\n")
				const nextTracker = await CheckpointTracker.create(nextTaskId, true, sandbox.workspacePath)
				if (!nextTracker) throw new Error("checkpoint_tracker_missing")
				nextTracker.setTaskFileTracker(new TaskFileTracker(nextTaskId))
				expectCheckpointHash(await nextTracker.commit())

				expect(modes).toContain("baseline")
			} finally {
				spy.mockRestore()
			}
		} finally {
			WorkspaceFileRegistry.getInstance().releaseTask(firstTaskId)
			WorkspaceFileRegistry.getInstance().releaseTask(nextTaskId)
			await disposeSandbox(sandbox)
		}
	})

	it("removes a previously tracked file when refreshed exclusions begin ignoring it", async () => {
		const sandbox = await createUnbornSandbox()
		const firstTaskId = "task-ignore-shadow-first"
		const nextTaskId = "task-ignore-shadow-next"
		const laterIgnoredFile = path.join(sandbox.workspacePath, "later-ignored.txt")
		try {
			await fs.writeFile(laterIgnoredFile, "must leave the refreshed baseline")
			const firstTracker = await CheckpointTracker.create(firstTaskId, true, sandbox.workspacePath)
			if (!firstTracker) throw new Error("checkpoint_tracker_missing")
			firstTracker.setTaskFileTracker(new TaskFileTracker(firstTaskId))
			const firstHash = await firstTracker.commit()
			expectCheckpointHash(firstHash)

			await fs.writeFile(path.join(sandbox.workspacePath, ".gitignore"), "later-ignored.txt\n")
			const nextTracker = await CheckpointTracker.create(nextTaskId, true, sandbox.workspacePath)
			if (!nextTracker) throw new Error("checkpoint_tracker_missing")
			nextTracker.setTaskFileTracker(new TaskFileTracker(nextTaskId))
			const nextHash = await nextTracker.commit()
			expectCheckpointHash(nextHash)

			const shadowGitPath = await getShadowGitPath(hashWorkingDir(sandbox.workspacePath))
			const shadowGit = simpleGit(path.dirname(shadowGitPath))
			expect(await shadowGit.show([`${firstHash}:later-ignored.txt`])).toBe("must leave the refreshed baseline")
			await expect(shadowGit.show([`${nextHash}:later-ignored.txt`])).rejects.toThrow()
		} finally {
			WorkspaceFileRegistry.getInstance().releaseTask(firstTaskId)
			WorkspaceFileRegistry.getInstance().releaseTask(nextTaskId)
			await disposeSandbox(sandbox)
		}
	})

	it("restores the shadow index when an existing baseline refresh fails after staging", async () => {
		const sandbox = await createUnbornSandbox()
		const firstTaskId = "task-rollback-shadow-first"
		const failedTaskId = "task-rollback-shadow-failed"
		const retryTaskId = "task-rollback-shadow-retry"
		try {
			const firstTracker = await CheckpointTracker.create(firstTaskId, true, sandbox.workspacePath)
			if (!firstTracker) throw new Error("checkpoint_tracker_missing")
			firstTracker.setTaskFileTracker(new TaskFileTracker(firstTaskId))
			const firstHash = await firstTracker.commit()
			expectCheckpointHash(firstHash)
			const checkpointEvents = vi.spyOn(
				CheckpointTracker.prototype as unknown as {
					sendCheckpointSubscriptionEvent: (operation: string, isActive: boolean) => Promise<void>
				},
				"sendCheckpointSubscriptionEvent",
			)

			await fs.writeFile(sandbox.trackedFile, "staged before simulated failure")
			const originalAddCheckpointFiles = GitOperations.prototype.addCheckpointFiles
			const addCheckpointFiles = vi.spyOn(GitOperations.prototype, "addCheckpointFiles").mockImplementation(async function (
				this: GitOperations,
				options,
			) {
				const result = await originalAddCheckpointFiles.call(this, options)
				// Existing-shadow refresh stages the whole worktree; it picks
				// "baseline" or "workspace-scan" depending on whether the exclusion
				// ruleset changed, so match on that role rather than one mode name.
				const isRefreshStaging = options.mode === "baseline" || options.mode === "workspace-scan"
				return options.taskId === failedTaskId && isRefreshStaging
					? { success: false, stagedCount: 0, rejectedPaths: [] }
					: result
			})

			await expect(CheckpointTracker.create(failedTaskId, true, sandbox.workspacePath)).rejects.toThrow(
				"Failed to refresh the existing checkpoints shadow baseline",
			)
			addCheckpointFiles.mockRestore()
			expect(checkpointEvents.mock.calls.map(([operation, isActive]) => [operation, isActive])).toEqual([
				["CHECKPOINT_INIT", true],
				["CHECKPOINT_INIT", false],
			])

			const shadowGitPath = await getShadowGitPath(hashWorkingDir(sandbox.workspacePath))
			const shadowGit = simpleGit(path.dirname(shadowGitPath))
			expect(await shadowGit.diff(["--cached", "--name-only"])).toBe("")
			expect((await shadowGit.revparse(["HEAD"])).trim()).toBe(firstHash)

			await fs.writeFile(sandbox.trackedFile, "retry after add failure")
			const retryTracker = await CheckpointTracker.create(retryTaskId, true, sandbox.workspacePath)
			if (!retryTracker) throw new Error("checkpoint_tracker_missing")
			retryTracker.setTaskFileTracker(new TaskFileTracker(retryTaskId))
			const retryHash = await retryTracker.commit()
			expectCheckpointHash(retryHash)
			expect(retryHash).not.toBe(firstHash)
			expect(await shadowGit.show([`${retryHash}:write_test.txt`])).toBe("retry after add failure")
		} finally {
			vi.restoreAllMocks()
			WorkspaceFileRegistry.getInstance().releaseTask(firstTaskId)
			WorkspaceFileRegistry.getInstance().releaseTask(failedTaskId)
			WorkspaceFileRegistry.getInstance().releaseTask(retryTaskId)
			await disposeSandbox(sandbox)
		}
	})

	it("clears a stale index after commit failure before retrying the baseline refresh", async () => {
		const sandbox = await createUnbornSandbox()
		const firstTaskId = "task-commit-rollback-first"
		const failedTaskId = "task-commit-rollback-failed"
		const retryTaskId = "task-commit-rollback-retry"
		const retryFile = path.join(sandbox.workspacePath, "retry-only.txt")
		try {
			const firstTracker = await CheckpointTracker.create(firstTaskId, true, sandbox.workspacePath)
			if (!firstTracker) throw new Error("checkpoint_tracker_missing")
			firstTracker.setTaskFileTracker(new TaskFileTracker(firstTaskId))
			const firstHash = await firstTracker.commit()
			expectCheckpointHash(firstHash)

			const shadowGitPath = await getShadowGitPath(hashWorkingDir(sandbox.workspacePath))
			const shadowGit = simpleGit(path.dirname(shadowGitPath))
			await fs.writeFile(sandbox.staleFile, "staged residue from an earlier failure")
			await shadowGit.add(["stale_test.txt"])
			expect(await shadowGit.diff(["--cached", "--name-only"])).toContain("stale_test.txt")

			await fs.writeFile(sandbox.trackedFile, "refresh whose commit must fail")
			await shadowGit.addConfig("commit.gpgSign", "true")
			await shadowGit.addConfig("user.signingkey", "dline-checkpoint-test-missing-signing-key")
			await expect(CheckpointTracker.create(failedTaskId, true, sandbox.workspacePath)).rejects.toThrow()

			expect(await shadowGit.diff(["--cached", "--name-only"])).toBe("")
			expect((await shadowGit.revparse(["HEAD"])).trim()).toBe(firstHash)

			await shadowGit.addConfig("commit.gpgSign", "false")
			await fs.writeFile(sandbox.staleFile, "before deletion")
			await fs.writeFile(sandbox.trackedFile, "retry after commit failure")
			await fs.writeFile(retryFile, "retry-only content")
			const retryTracker = await CheckpointTracker.create(retryTaskId, true, sandbox.workspacePath)
			if (!retryTracker) throw new Error("checkpoint_tracker_missing")
			retryTracker.setTaskFileTracker(new TaskFileTracker(retryTaskId))
			const retryHash = await retryTracker.commit()
			expectCheckpointHash(retryHash)
			expect(retryHash).not.toBe(firstHash)
			expect(await shadowGit.show([`${retryHash}:write_test.txt`])).toBe("retry after commit failure")
			expect(await shadowGit.show([`${retryHash}:stale_test.txt`])).toBe("before deletion")
			expect(await shadowGit.show([`${retryHash}:retry-only.txt`])).toBe("retry-only content")
		} finally {
			WorkspaceFileRegistry.getInstance().releaseTask(firstTaskId)
			WorkspaceFileRegistry.getInstance().releaseTask(failedTaskId)
			WorkspaceFileRegistry.getInstance().releaseTask(retryTaskId)
			await disposeSandbox(sandbox)
		}
	})

	it("creates a restore point for a tracked file and Restore Files recovers its content", async () => {
		const sandbox = await createUnbornSandbox()
		try {
			const tracker = await CheckpointTracker.create("task-unborn-tracked", true, sandbox.workspacePath)
			if (!tracker) throw new Error("checkpoint_tracker_missing")
			const taskFiles = new TaskFileTracker("task-unborn-tracked")
			taskFiles.trackModification(sandbox.trackedFile)
			tracker.setTaskFileTracker(taskFiles)

			await fs.writeFile(sandbox.trackedFile, "checkpoint content")
			const checkpointHash = await tracker.commit()
			expectCheckpointHash(checkpointHash)

			await fs.writeFile(sandbox.trackedFile, "after checkpoint")
			await tracker.restoreFiles(checkpointHash, [sandbox.trackedFile])

			expect(await fs.readFile(sandbox.trackedFile, "utf8")).toBe("checkpoint content")
			expect((await simpleGit(sandbox.workspacePath).branchLocal()).current).toBe("")
		} finally {
			await disposeSandbox(sandbox)
		}
	})

	it("captures untracked command writes when a root is forced to scan", async () => {
		const sandbox = await createUnbornSandbox()
		const commandOutput = path.join(sandbox.workspacePath, "command-output.txt")
		try {
			const tracker = await CheckpointTracker.create("task-command-scan", true, sandbox.workspacePath)
			if (!tracker) throw new Error("checkpoint_tracker_missing")
			await fs.writeFile(commandOutput, "created by command")

			const checkpointHash = await tracker.commitForFiles([], { forceWorkspaceScan: true })
			expectCheckpointHash(checkpointHash)
			const shadowGit = simpleGit(path.dirname(await getShadowGitPath(hashWorkingDir(sandbox.workspacePath))))
			expect(await shadowGit.show([`${checkpointHash}:command-output.txt`])).toBe("created by command")
		} finally {
			await disposeSandbox(sandbox)
		}
	})

	it("records command-scanned files as task-owned so selective restore includes them", async () => {
		const sandbox = await createUnbornSandbox()
		const taskId = "task-command-scan-restore"
		const commandOutput = path.join(sandbox.workspacePath, "command-output.txt")
		const taskFiles = new TaskFileTracker(taskId)
		const messages: ClineMessage[] = []
		try {
			const harness = createManagerHarness({
				taskId,
				workspacePath: sandbox.workspacePath,
				taskFileTracker: taskFiles,
				messages,
			})
			await harness.manager.saveCheckpoint()
			messages.push({ ts: 999, type: "say", say: "text" })
			taskFiles.trackModification(sandbox.trackedFile)
			taskFiles.markWorkspaceScanRequired()
			await fs.writeFile(sandbox.trackedFile, "tracked checkpoint content")
			await fs.writeFile(commandOutput, "command checkpoint content")

			await harness.manager.saveCheckpoint()

			const checkpointMessage = messages.filter((message) => message.say === "checkpoint_created").at(-1)
			const checkpointHash = checkpointMessage?.lastCheckpointHash?.[0]
			expectCheckpointHash(checkpointHash)
			expect(taskFiles.getAllModifiedFiles()).toEqual(expect.arrayContaining([sandbox.trackedFile, commandOutput]))
			const tracker = harness.setCheckpointTracker.mock.calls.at(-1)?.[0] as CheckpointTracker | undefined
			if (!tracker) throw new Error("checkpoint_tracker_missing")
			await fs.writeFile(sandbox.trackedFile, "after checkpoint")
			await fs.writeFile(commandOutput, "after checkpoint")

			await tracker.restoreFiles(checkpointHash, taskFiles.getAllModifiedFiles())

			expect(await fs.readFile(sandbox.trackedFile, "utf8")).toBe("tracked checkpoint content")
			expect(await fs.readFile(commandOutput, "utf8")).toBe("command checkpoint content")
		} finally {
			WorkspaceFileRegistry.getInstance().releaseTask(taskId)
			await disposeSandbox(sandbox)
		}
	})

	it("keeps using the shadow repository bound during tracker creation", async () => {
		const sandbox = await createUnbornSandbox()
		const taskId = "task-bound-shadow-path"
		const alternateDocumentsPath = path.join(sandbox.sandbox, "alternate-documents")
		try {
			const tracker = await CheckpointTracker.create(taskId, true, sandbox.workspacePath)
			if (!tracker) throw new Error("checkpoint_tracker_missing")
			const taskFiles = new TaskFileTracker(taskId)
			taskFiles.trackModification(sandbox.trackedFile)
			tracker.setTaskFileTracker(taskFiles)

			await fs.writeFile(sandbox.trackedFile, "checkpoint content")
			process.env.DLINE_DOCS_DIR = alternateDocumentsPath
			const checkpointHash = await tracker.commit()
			expectCheckpointHash(checkpointHash)

			await fs.writeFile(sandbox.trackedFile, "after checkpoint")
			await tracker.restoreFiles(checkpointHash, [sandbox.trackedFile])

			expect(await fs.readFile(sandbox.trackedFile, "utf8")).toBe("checkpoint content")
		} finally {
			WorkspaceFileRegistry.getInstance().releaseTask(taskId)
			await disposeSandbox(sandbox)
		}
	})

	it("binds and restores a valid file when stale and missing paths are tracked", async () => {
		const sandbox = await createUnbornSandbox()
		const taskId = "task-unborn-manager"
		const addCheckpointFiles = vi.spyOn(GitOperations.prototype, "addCheckpointFiles")
		try {
			const taskFiles = new TaskFileTracker(taskId)
			taskFiles.trackModification(sandbox.trackedFile)
			taskFiles.trackModification(sandbox.staleFile)
			taskFiles.trackModification(sandbox.missingFile)
			await fs.writeFile(sandbox.trackedFile, "checkpoint content")
			await fs.rm(sandbox.staleFile)
			await expect(fs.stat(sandbox.staleFile)).rejects.toMatchObject({ code: "ENOENT" })
			await expect(fs.stat(sandbox.missingFile)).rejects.toMatchObject({ code: "ENOENT" })

			const messages: ClineMessage[] = []
			const harness = createManagerHarness({
				taskId,
				workspacePath: sandbox.workspacePath,
				taskFileTracker: taskFiles,
				messages,
			})

			await harness.manager.saveCheckpoint()

			const trackedAddIndex = addCheckpointFiles.mock.calls.findIndex(([options]) => options.mode === "tracked")
			expect(trackedAddIndex).toBeGreaterThanOrEqual(0)
			const trackedAddResult = await addCheckpointFiles.mock.results[trackedAddIndex]?.value
			const checkpointMessage = messages.find((message) => message.say === "checkpoint_created")
			expect({
				staging: trackedAddResult,
				lastCheckpointHash: checkpointMessage?.lastCheckpointHash,
			}).toMatchObject({
				staging: { success: true },
				lastCheckpointHash: [expect.stringMatching(/^[0-9a-f]{40}$/)],
			})
			expectCheckpointHash(checkpointMessage?.lastCheckpointHash?.[0])
			const tracker = harness.manager.getCurrentState().checkpointTracker
			if (!tracker) throw new Error("checkpoint_tracker_missing")
			expect(harness.setCheckpointTracker).toHaveBeenCalledWith(tracker)

			await fs.writeFile(sandbox.trackedFile, "after checkpoint")
			await tracker.restoreFiles(checkpointMessage.lastCheckpointHash[0], [sandbox.trackedFile])

			expect(await fs.readFile(sandbox.trackedFile, "utf8")).toBe("checkpoint content")
			expect((await simpleGit(sandbox.workspacePath).branchLocal()).current).toBe("")
		} finally {
			addCheckpointFiles.mockRestore()
			WorkspaceFileRegistry.getInstance().releaseTask(taskId)
			await disposeSandbox(sandbox)
		}
	})

	it("captures and restores a tracked deletion that existed in the shadow baseline", async () => {
		const sandbox = await createUnbornSandbox()
		try {
			const tracker = await CheckpointTracker.create("task-unborn-deletion", true, sandbox.workspacePath)
			if (!tracker) throw new Error("checkpoint_tracker_missing")
			const taskFiles = new TaskFileTracker("task-unborn-deletion")
			taskFiles.trackModification(sandbox.staleFile)
			tracker.setTaskFileTracker(taskFiles)

			await fs.rm(sandbox.staleFile)
			const checkpointHash = await tracker.commit()
			expectCheckpointHash(checkpointHash)

			await fs.writeFile(sandbox.staleFile, "recreated after checkpoint")
			await tracker.restoreFiles(checkpointHash, [sandbox.staleFile])

			await expect(fs.stat(sandbox.staleFile)).rejects.toMatchObject({ code: "ENOENT" })
			expect((await simpleGit(sandbox.workspacePath).branchLocal()).current).toBe("")
		} finally {
			WorkspaceFileRegistry.getInstance().releaseTask("task-unborn-deletion")
			await disposeSandbox(sandbox)
		}
	})

	it("treats a bracketed tracked path literally during staging and restore", async () => {
		const sandbox = await createUnbornSandbox()
		const taskId = "task-literal-pathspec"
		const trackedBracketFile = path.join(sandbox.workspacePath, "tracked[1].txt")
		const globNeighborFile = path.join(sandbox.workspacePath, "tracked1.txt")
		try {
			await fs.writeFile(trackedBracketFile, "bracket baseline")
			await fs.writeFile(globNeighborFile, "neighbor baseline")
			const tracker = await CheckpointTracker.create(taskId, true, sandbox.workspacePath)
			if (!tracker) throw new Error("checkpoint_tracker_missing")
			const taskFiles = new TaskFileTracker(taskId)
			taskFiles.trackModification(trackedBracketFile)
			tracker.setTaskFileTracker(taskFiles)

			await fs.writeFile(trackedBracketFile, "bracket checkpoint")
			await fs.writeFile(globNeighborFile, "neighbor must not be checkpointed")
			const checkpointHash = await tracker.commit()
			expectCheckpointHash(checkpointHash)

			const shadowGitPath = await getShadowGitPath(hashWorkingDir(sandbox.workspacePath))
			const shadowGit = simpleGit(path.dirname(shadowGitPath))
			const bracketRelative = path.relative(sandbox.workspacePath, trackedBracketFile).replaceAll("\\", "/")
			const neighborRelative = path.relative(sandbox.workspacePath, globNeighborFile).replaceAll("\\", "/")
			expect(await shadowGit.show([`${checkpointHash}:${bracketRelative}`])).toBe("bracket checkpoint")
			expect(await shadowGit.show([`${checkpointHash}:${neighborRelative}`])).toBe("neighbor baseline")

			await fs.writeFile(trackedBracketFile, "bracket after checkpoint")
			await fs.writeFile(globNeighborFile, "neighbor after checkpoint")
			await tracker.restoreFiles(checkpointHash, [trackedBracketFile])

			expect(await fs.readFile(trackedBracketFile, "utf8")).toBe("bracket checkpoint")
			expect(await fs.readFile(globNeighborFile, "utf8")).toBe("neighbor after checkpoint")
		} finally {
			WorkspaceFileRegistry.getInstance().releaseTask(taskId)
			await disposeSandbox(sandbox)
		}
	})

	it("restores an older file checkpoint without staging changes against the current shadow HEAD", async () => {
		const sandbox = await createUnbornSandbox()
		const taskId = "task-worktree-only-restore"
		try {
			const tracker = await CheckpointTracker.create(taskId, true, sandbox.workspacePath)
			if (!tracker) throw new Error("checkpoint_tracker_missing")
			const taskFiles = new TaskFileTracker(taskId)
			taskFiles.trackModification(sandbox.trackedFile)
			tracker.setTaskFileTracker(taskFiles)
			const shadowGitPath = await getShadowGitPath(hashWorkingDir(sandbox.workspacePath))
			const shadowGit = simpleGit(path.dirname(shadowGitPath))
			const olderHash = (await shadowGit.revparse(["HEAD"])).trim()

			await fs.writeFile(sandbox.trackedFile, "newer checkpoint")
			const newerHash = await tracker.commit()
			expectCheckpointHash(newerHash)
			expect(newerHash).not.toBe(olderHash)

			await fs.writeFile(sandbox.trackedFile, "after newer checkpoint")
			await tracker.restoreFiles(olderHash, [sandbox.trackedFile])

			expect(await fs.readFile(sandbox.trackedFile, "utf8")).toBe("before checkpoint")
			expect((await shadowGit.revparse(["HEAD"])).trim()).toBe(newerHash)
			expect((await shadowGit.raw(["diff", "--cached", "--name-only"])).trim()).toBe("")
		} finally {
			WorkspaceFileRegistry.getInstance().releaseTask(taskId)
			await disposeSandbox(sandbox)
		}
	})

	it("reuses shadow HEAD and clears tracking when every tracked path was never created", async () => {
		const sandbox = await createUnbornSandbox()
		const taskId = "task-only-missing-paths"
		try {
			const tracker = await CheckpointTracker.create(taskId, true, sandbox.workspacePath)
			if (!tracker) throw new Error("checkpoint_tracker_missing")
			const taskFiles = new TaskFileTracker(taskId)
			taskFiles.trackModification(sandbox.missingFile)
			tracker.setTaskFileTracker(taskFiles)
			const shadowGitPath = await getShadowGitPath(hashWorkingDir(sandbox.workspacePath))
			const shadowGit = simpleGit(path.dirname(shadowGitPath))
			const headBeforeCommit = (await shadowGit.revparse(["HEAD"])).trim()

			const checkpointHash = await tracker.commit()

			expect(checkpointHash).toBe(headBeforeCommit)
			expect(taskFiles.getModifiedFiles()).toEqual([])
		} finally {
			WorkspaceFileRegistry.getInstance().releaseTask(taskId)
			await disposeSandbox(sandbox)
		}
	})

	it("limits completion diffs to checkpoint commits owned by the requesting task", async () => {
		const sandbox = await createUnbornSandbox()
		const taskAId = "task-completion-owner-a"
		const taskBId = "task-completion-owner-b"
		try {
			const taskATracker = await CheckpointTracker.create(taskAId, true, sandbox.workspacePath)
			const taskBTracker = await CheckpointTracker.create(taskBId, true, sandbox.workspacePath)
			if (!taskATracker || !taskBTracker) throw new Error("checkpoint_tracker_missing")
			const taskAFiles = new TaskFileTracker(taskAId)
			const taskBFiles = new TaskFileTracker(taskBId)
			taskATracker.setTaskFileTracker(taskAFiles)
			taskBTracker.setTaskFileTracker(taskBFiles)

			const shadowGitPath = await getShadowGitPath(hashWorkingDir(sandbox.workspacePath))
			const shadowGit = simpleGit(path.dirname(shadowGitPath))
			const taskStartHash = (await shadowGit.revparse(["HEAD"])).trim()

			taskAFiles.trackModification(sandbox.trackedFile)
			await fs.writeFile(sandbox.trackedFile, "task A change")
			const taskAHash = await taskATracker.commit()
			expectCheckpointHash(taskAHash)
			expect(await taskBTracker.getTaskDiffCount(taskStartHash, taskAHash)).toBe(0)

			taskBFiles.trackModification(sandbox.staleFile)
			await fs.writeFile(sandbox.staleFile, "task B change")
			const taskBHash = await taskBTracker.commit()
			expectCheckpointHash(taskBHash)

			const taskADiff = await taskATracker.getTaskDiffSet(taskStartHash, taskBHash)
			expect(taskADiff).toEqual([
				expect.objectContaining({
					relativePath: "write_test.txt",
					before: "before checkpoint",
					after: "task A change",
				}),
			])
			expect(await taskATracker.getTaskDiffCount(taskStartHash, taskBHash)).toBe(1)
		} finally {
			WorkspaceFileRegistry.getInstance().releaseTask(taskAId)
			WorkspaceFileRegistry.getInstance().releaseTask(taskBId)
			await disposeSandbox(sandbox)
		}
	})

	it("hides completion changes when a task restores its touched file to the segment baseline", async () => {
		const sandbox = await createUnbornSandbox()
		const taskId = "task-completion-net-zero"
		try {
			const tracker = await CheckpointTracker.create(taskId, true, sandbox.workspacePath)
			if (!tracker) throw new Error("checkpoint_tracker_missing")
			const taskFiles = new TaskFileTracker(taskId)
			tracker.setTaskFileTracker(taskFiles)
			const shadowGitPath = await getShadowGitPath(hashWorkingDir(sandbox.workspacePath))
			const shadowGit = simpleGit(path.dirname(shadowGitPath))
			const taskStartHash = (await shadowGit.revparse(["HEAD"])).trim()

			taskFiles.trackModification(sandbox.trackedFile)
			await fs.writeFile(sandbox.trackedFile, "temporary task change")
			expectCheckpointHash(await tracker.commit())

			taskFiles.trackModification(sandbox.trackedFile)
			await fs.writeFile(sandbox.trackedFile, "before checkpoint")
			const completionHash = await tracker.commit()
			expectCheckpointHash(completionHash)

			expect(await tracker.getTaskDiffCount(taskStartHash, completionHash)).toBe(0)
			expect(await tracker.getTaskDiffSet(taskStartHash, completionHash)).toEqual([])
		} finally {
			WorkspaceFileRegistry.getInstance().releaseTask(taskId)
			await disposeSandbox(sandbox)
		}
	})

	it("rejects a tracked path outside the checkpoint worktree before invoking git add", async () => {
		const workspacePath = path.resolve("checkpoint-owned-worktree")
		const outsidePath = path.resolve("outside-worktree", "write_test.txt")
		const operations = new GitOperations(workspacePath)
		const add = vi.fn(async () => undefined)

		const result = await operations.addCheckpointFiles({
			git: { add } as never,
			mode: "tracked",
			fileList: [outsidePath],
			taskId: "task-path-mismatch",
		})

		expect(result).toMatchObject({ success: false })
		expect(add).not.toHaveBeenCalled()
	})
})
