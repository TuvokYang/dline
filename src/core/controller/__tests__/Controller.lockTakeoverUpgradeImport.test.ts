import { describe, expect, it, vi } from "vitest"
import { ShowMessageType } from "@/shared/proto/dline/host/window"
import { Controller } from "../index"

const host = vi.hoisted(() => ({ showMessage: vi.fn() }))

vi.mock("@/core/storage/disk", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/core/storage/disk")>()),
	cleanupStaleTaskTempFiles: vi.fn(async () => undefined),
}))

vi.mock("@/hosts/host-provider", () => ({ HostProvider: { window: { showMessage: host.showMessage } } }))

type TakeOver = (owner: unknown, scope: unknown) => Promise<void>

const prototype = Controller.prototype as unknown as {
	takeOverTaskAfterUnlock: TakeOver
	reopenForUpgradeImport: (taskId: string, scope: unknown) => Promise<void>
}

/**
 * A window that opened the task without its lock, now taking it over.
 *
 * Only the members the takeover reads are present, so an unexpected path fails
 * loudly instead of passing against a stub.
 */
function subject(upgradeImportPending: boolean) {
	const owner = { taskId: "task-1" }
	const clearTask = vi.fn(async () => undefined)
	const open = vi.fn(async () => undefined)
	const controller = {
		disposed: false,
		taskLockAcquired: false,
		historyDisplaySession: undefined,
		currentOpening: () => owner,
		task: {
			taskId: "task-1",
			upgradeImportPending,
			activateCollaboration: vi.fn(),
			task: { open },
			activateBackgroundIngress: vi.fn(async () => undefined),
		},
		lockService: { acquireTaskLock: vi.fn(async () => true) },
		stopLockPoll: vi.fn(),
		startLockHeartbeat: vi.fn(),
		postStateToWebview: vi.fn(async () => undefined),
		getTaskWithId: vi.fn(async () => ({ historyItem: { id: "task-1" } })),
		initTask: vi.fn(async () => undefined),
		reopenForUpgradeImport: prototype.reopenForUpgradeImport,
	}
	const takeOver = () => prototype.takeOverTaskAfterUnlock.call(controller, owner, { clearTask })
	return { controller, clearTask, open, takeOver }
}

describe("Controller lock takeover of a task with data from an earlier version", () => {
	// Opening in place would let the session's first journal write close the
	// import off for good, so the follow-up would be sent without the history.
	it("reopens the session so the import runs before the kernel reads the stores", async () => {
		const { controller, clearTask, open, takeOver } = subject(true)

		await takeOver()

		expect(clearTask).toHaveBeenCalledExactlyOnceWith({ suppressPostState: true })
		expect(controller.initTask).toHaveBeenCalledExactlyOnceWith(
			undefined,
			undefined,
			undefined,
			{ id: "task-1" },
			undefined,
			{
				activateHistory: true,
				skipInitialClear: true,
			},
		)
		// initTask takes the lock itself; acquiring it here as well would leave
		// the reopened session racing its own lock file.
		expect(controller.lockService.acquireTaskLock).not.toHaveBeenCalled()
		expect(open).not.toHaveBeenCalled()
		expect(controller.taskLockAcquired).toBe(false)
	})

	// The takeover runs from a timer, so nothing else would tell the user why
	// the chat they were looking at emptied.
	it("tells the user when the reopen fails and leaves the failure to the caller", async () => {
		const { controller, takeOver } = subject(true)
		const failure = new Error("journal.db is read-only")
		controller.initTask.mockRejectedValue(failure)

		await expect(takeOver()).rejects.toBe(failure)

		expect(host.showMessage).toHaveBeenCalledExactlyOnceWith({
			type: ShowMessageType.ERROR,
			message: expect.stringContaining("journal.db is read-only"),
		})
		expect(controller.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("opens the session in place when nothing waits to be imported", async () => {
		const { controller, clearTask, open, takeOver } = subject(false)

		await takeOver()

		expect(controller.lockService.acquireTaskLock).toHaveBeenCalledExactlyOnceWith("task-1")
		expect(controller.taskLockAcquired).toBe(true)
		expect(open).toHaveBeenCalledOnce()
		expect(clearTask).not.toHaveBeenCalled()
		expect(controller.initTask).not.toHaveBeenCalled()
	})
})
