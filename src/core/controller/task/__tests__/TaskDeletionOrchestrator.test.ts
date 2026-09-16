import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "chai"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import type { TaskLockService } from "../../../locks/TaskLockService"
import { TaskDeletionOrchestrator } from "../TaskDeletionOrchestrator"

/**
 * Unit tests for TaskDeletionOrchestrator — primarily the closePanelsForTask
 * logic which ensures Editor Tab panels are disposed when their task is deleted.
 */
describe("TaskDeletionOrchestrator", () => {
	let orchestrator: TaskDeletionOrchestrator
	let mockController: any
	let mockLockService: TaskLockService

	beforeEach(() => {
		mockController = {
			task: undefined,
			clearTask: async () => {},
			getTaskWithId: async (_id: string) => {
				throw new Error("Task not found")
			},
			deleteTaskFromState: async (_id: string) => [],
			postStateToWebview: async () => {},
		}

		mockLockService = {
			checkTaskLock: async (_taskId: string) => ({ isLocked: false, isStale: false }),
		} as unknown as TaskLockService

		orchestrator = new TaskDeletionOrchestrator(mockController, mockLockService)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	// ──────────────────────────────────────────────
	// closePanelsForTask (private, tested via deleteSingle)
	// ──────────────────────────────────────────────

	it("should skip deletion when task is locked", async () => {
		const lockedService = {
			checkTaskLock: async (_taskId: string) => ({
				isLocked: true,
				isStale: false,
				lockedBy: "instance-b",
				lockedAt: Date.now(),
			}),
		} as unknown as TaskLockService

		const svc = new TaskDeletionOrchestrator(mockController, lockedService)
		const result = await (svc as any).deleteSingle("locked-task")

		expect(result.success).to.be.false
		expect(result.skippedLocked).to.be.true
		expect(result.taskId).to.equal("locked-task")
	})

	it("should handle zombie task (missing files) gracefully", async () => {
		const result = await (orchestrator as any).deleteSingle("zombie-task")

		// 'zombie-task' doesn't exist in state, so getTaskWithId throws
		// and it's treated as a zombie (success=true, state cleaned)
		expect(result.success).to.be.true
		expect(result.skippedLocked).to.be.false
		expect(result.taskId).to.equal("zombie-task")
	})

	it("should clear active task when deleting currently active task", async () => {
		let clearCalled = false
		mockController.task = { taskId: "active-task" }
		mockController.clearTask = async () => {
			clearCalled = true
		}

		await (orchestrator as any).deleteSingle("active-task")

		expect(clearCalled).to.be.true
	})

	it("should not clear active task when deleting a different task", async () => {
		let clearCalled = false
		mockController.task = { taskId: "different-task" }
		mockController.clearTask = async () => {
			clearCalled = true
		}

		await (orchestrator as any).deleteSingle("other-task")

		expect(clearCalled).to.be.false
	})

	it("recursively deletes the complete task-owned directory", async () => {
		const parent = path.join(process.cwd(), "tmp")
		await fs.mkdir(parent, { recursive: true })
		const taskDirPath = await fs.mkdtemp(path.join(parent, "task-delete-metrics-"))
		const taskId = "task-with-sqlite"
		const paths = {
			apiConversationHistoryFilePath: path.join(taskDirPath, "api.jsonl"),
			uiMessagesFilePath: path.join(taskDirPath, "ui.jsonl"),
			contextHistoryFilePath: path.join(taskDirPath, "context.jsonl"),
			taskMetadataFilePath: path.join(taskDirPath, "metadata.json"),
			taskDirPath,
		}
		const databasePath = path.join(taskDirPath, `${taskId}.db`)
		const nestedArtifactPath = path.join(taskDirPath, "artifacts", "nested", "result.txt")
		const taskOwnedPaths = [
			path.join(taskDirPath, "api_rate_metrics.jsonl"),
			path.join(taskDirPath, "settings.json"),
			path.join(taskDirPath, "snapshot.json"),
			databasePath,
			`${databasePath}-wal`,
			`${databasePath}-shm`,
			nestedArtifactPath,
		]
		await fs.mkdir(path.dirname(nestedArtifactPath), { recursive: true })
		await Promise.all([...Object.values(paths).slice(0, 4), ...taskOwnedPaths].map((filePath) => fs.writeFile(filePath, "x")))
		mockController.getTaskWithId = async () => paths
		mockController.deleteTaskFromState = async () => [taskId]

		try {
			const result = await orchestrator.deleteSingle(taskId)
			expect(result.success).to.be.true
			const taskDirectoryExists = await fs.access(taskDirPath).then(
				() => true,
				() => false,
			)
			expect(taskDirectoryExists).to.be.false
		} finally {
			await fs.rm(taskDirPath, { recursive: true, force: true })
		}
	})

	it("retries a transient Windows EBUSY while deleting the task directory", async () => {
		const parent = path.join(process.cwd(), "tmp")
		await fs.mkdir(parent, { recursive: true })
		const taskDirPath = await fs.mkdtemp(path.join(parent, "task-delete-ebusy-"))
		const taskId = "task-with-transient-lock"
		const paths = {
			apiConversationHistoryFilePath: path.join(taskDirPath, "api.jsonl"),
			uiMessagesFilePath: path.join(taskDirPath, "ui.jsonl"),
			contextHistoryFilePath: path.join(taskDirPath, "context.jsonl"),
			taskMetadataFilePath: path.join(taskDirPath, "metadata.json"),
			taskDirPath,
		}
		await fs.writeFile(paths.taskMetadataFilePath, "x")
		mockController.getTaskWithId = async () => paths
		mockController.deleteTaskFromState = async () => [taskId]

		const originalRm = fs.rm
		let taskDirectoryAttempts = 0
		vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
			if (target === taskDirPath) {
				taskDirectoryAttempts++
				if (taskDirectoryAttempts === 1) {
					throw Object.assign(new Error("resource busy"), { code: "EBUSY" })
				}
			}
			return originalRm(target, options)
		})

		try {
			const result = await orchestrator.deleteSingle(taskId)
			expect(result.success).to.be.true
			expect(taskDirectoryAttempts).to.equal(2)
			const taskDirectoryExists = await fs.access(taskDirPath).then(
				() => true,
				() => false,
			)
			expect(taskDirectoryExists).to.be.false
		} finally {
			vi.restoreAllMocks()
			await fs.rm(taskDirPath, { recursive: true, force: true })
		}
	})

	it("deleteBatch should process multiple tasks independently", async () => {
		const result = await orchestrator.deleteBatch(["zombie-1", "zombie-2"])

		expect(result.totalRequested).to.equal(2)
		expect(result.deleted).to.equal(2)
		expect(result.failed).to.equal(0)
		expect(result.skippedLocked).to.equal(0)
	})

	it("deleteBatch should skip locked tasks", async () => {
		const lockedService = {
			checkTaskLock: async (taskId: string) => ({
				isLocked: taskId === "locked-1",
				isStale: false,
				lockedBy: "instance-b",
				lockedAt: Date.now(),
			}),
		} as unknown as TaskLockService

		const svc = new TaskDeletionOrchestrator(mockController, lockedService)
		const result = await svc.deleteBatch(["locked-1"])

		expect(result.totalRequested).to.equal(1)
		expect(result.skippedLocked).to.equal(1)
		expect(result.deleted).to.equal(0)
	})

	it("deletes a locked task when the lock is held by a registered controller", async () => {
		let releasedTaskId: string | undefined
		let clearedTaskId: string | undefined
		const lockedService = {
			checkTaskLock: async () => ({
				isLocked: true,
				isStale: false,
				lockedBy: "vscode-panel",
				lockedAt: Date.now(),
			}),
			releaseTaskLock: async (taskId: string) => {
				releasedTaskId = taskId
			},
		} as unknown as TaskLockService
		const holderController = {
			task: { taskId: "panel-task" },
			clearTask: async () => {
				clearedTaskId = "panel-task"
			},
		}

		const svc = new TaskDeletionOrchestrator(mockController, lockedService, {
			getControllerForTask: () => holderController as never,
		})
		const result = await svc.deleteBatch(["panel-task"])

		expect(result.totalRequested).to.equal(1)
		expect(result.skippedLocked).to.equal(0)
		expect(result.deleted).to.equal(1)
		expect(clearedTaskId).to.equal("panel-task")
		expect(releasedTaskId).to.equal("panel-task")
	})
})
