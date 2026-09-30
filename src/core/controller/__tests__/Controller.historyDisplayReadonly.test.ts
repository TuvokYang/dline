import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Controller } from "@core/controller"
import { Task } from "@core/task"
import { TaskPhase } from "@core/task/TaskPhase"
import type { TaskViewState } from "@shared/ExtensionMessage"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TaskLockService } from "@/core/locks/TaskLockService"

const FOREIGN_INSTANCE = "other-instance:4242"
const LOCAL_INSTANCE = "this-instance:1"

/** Exercise the production Task read-only gate and Controller projector without admitting IO or execution. */
function boundTask(readOnly: boolean) {
	const task = Object.create(Task.prototype) as Task
	const runtimeState = {
		taskId: "history-task",
		phase: TaskPhase.PAUSED,
		revision: 7,
		anchor: { apiIndex: 1, uiMessageTs: 100, turnId: "turn-1", interactionId: "resume-1" },
		interaction: {
			taskId: "history-task",
			turnId: "turn-1",
			interactionId: "resume-1",
			kind: "resume" as const,
			status: "awaiting" as const,
			createdRevision: 7,
			anchor: { messageTs: 100, messageType: "ask" as const },
		},
	}
	Object.assign(task, {
		taskId: runtimeState.taskId,
		taskInstanceId: "open-1",
		readOnly,
		controllerDetached: false,
		taskRuntime: { getState: () => runtimeState },
		isHistoryPreparationPending: () => false,
		getReadyBackgroundHandoffActivityId: () => undefined,
		hasAutoRetrySequence: () => false,
		hasPendingAutoRetry: () => false,
		getContextCompactionOperationId: () => undefined,
		isForceTruncateAvailable: () => false,
		isBackgroundHandoffRequested: () => false,
	})
	const controller = Object.create(Controller.prototype) as Controller
	controller.task = task
	const project = () =>
		(controller as unknown as { projectCurrentTaskViewState(): TaskViewState }).projectCurrentTaskViewState()
	return { task, runtimeState, project }
}

/** Historical and active Task views share one identity and the same write permission gate. */
describe("canonical Task read-only lock projection", () => {
	let docsDir: string
	let tasksRoot: string
	beforeEach(async () => {
		docsDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-history-lock-"))
		tasksRoot = path.join(docsDir, "tasks")
		vi.stubEnv("DLINE_DOCS_DIR", docsDir)
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		await fs.rm(docsDir, { recursive: true, force: true })
	})

	it("reports a live foreign lock and refuses local write admission", async () => {
		const foreign = new TaskLockService(tasksRoot, FOREIGN_INSTANCE)
		expect(await foreign.acquireTaskLock("foreign-task")).toBe(true)
		const local = new TaskLockService(tasksRoot, LOCAL_INSTANCE)
		expect(await local.checkTaskLock("foreign-task")).toMatchObject({ isLocked: true, lockedBy: FOREIGN_INSTANCE })
		expect(await local.acquireTaskLock("foreign-task")).toBe(false)
	})

	it("recognizes a lock held by this Controller identity", async () => {
		const local = new TaskLockService(tasksRoot, LOCAL_INSTANCE)
		expect(await local.acquireTaskLock("owned-task")).toBe(true)
		expect(await local.checkTaskLock("owned-task")).toMatchObject({ isLocked: true, lockedBy: LOCAL_INSTANCE })
	})

	it("disables input and footer writes while preserving canonical Task and interaction identity", () => {
		const { task, project } = boundTask(true)
		const view = project()
		expect(view).toMatchObject({ taskId: task.taskId, taskInstanceId: task.taskInstanceId })
		expect(view.activeInteraction?.interactionId).toBe("resume-1")
		expect(view.input.enabled).toBe(false)
		expect(view.input.acceptsText).toBe(false)
		expect(view.footer.actions.every((action) => !action.enabled)).toBe(true)
	})

	it("grants write access on the same Task without replacing its opening or interaction", () => {
		const { task, project } = boundTask(true)
		const before = project()
		task.grantWriteAccess()
		const after = project()
		expect(after.taskId).toBe(before.taskId)
		expect(after.taskInstanceId).toBe(before.taskInstanceId)
		expect(after.activeInteraction).toMatchObject({ interactionId: "resume-1", stateRevision: 7 })
		expect(after.input.enabled).toBe(true)
		expect(after.footer.actions.some((action) => action.enabled)).toBe(true)
	})

	it("rejects a causal interaction while locked before admitting execution resources", async () => {
		const { task, runtimeState } = boundTask(true)
		const prepare = vi.fn()
		Object.assign(task, { prepareExecutionResources: prepare })
		await expect(
			task.dispatchRuntime({
				type: "INTERACTION_RESPONDED",
				response: {
					taskId: task.taskId,
					turnId: "turn-1",
					interactionId: "resume-1",
					actionId: "resume",
					stateRevision: 7,
				},
			}),
		).resolves.toMatchObject({ accepted: false, error: { code: "stale_interaction" } })
		expect(prepare).not.toHaveBeenCalled()
		expect(task.getRuntimeState()).toBe(runtimeState)
	})
})
