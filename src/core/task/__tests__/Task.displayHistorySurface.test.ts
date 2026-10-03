import { describe, expect, it, vi } from "vitest"
import { Task } from "../index"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function harness() {
	const secondary = deferred()
	const task = {
		taskId: "history-task",
		controllerDetached: false,
		messageResources: { openDisplay: vi.fn(async () => undefined) },
		activityStore: { hydrate: vi.fn(() => secondary.promise) },
		metrics: { reader: { readUsageSummary: vi.fn(async () => undefined) } },
		FocusChainManager: { readFocusChainFromDisk: vi.fn(async () => "saved checklist") },
		loadTaskSnapshot: vi.fn(async () => undefined),
		restoreHistoricalContextWindowIndicator: vi.fn(),
		taskState: { currentFocusChainChecklist: null as string | null, isInitialized: false },
	}
	return {
		task,
		secondary,
		display: (onMessagesReady: () => Promise<void>) =>
			Task.prototype.displayHistory.call(task as unknown as Task, { onMessagesReady }),
	}
}

describe("Task history message surface", () => {
	it("publishes the message window before waiting for secondary historical presentation", async () => {
		const { task, secondary, display } = harness()
		const published = vi.fn(async () => {
			expect(task.messageResources.openDisplay).toHaveBeenCalledOnce()
		})
		const displaying = display(published)
		try {
			await vi.waitFor(() => expect(task.activityStore.hydrate).toHaveBeenCalledOnce())
			expect(published).toHaveBeenCalledOnce()
			expect(task.taskState.isInitialized).toBe(false)
		} finally {
			secondary.resolve()
			await displaying
		}
		expect(task.taskState.isInitialized).toBe(true)
		expect(task.taskState.currentFocusChainChecklist).toBe("saved checklist")
	})

	it("does not publish a window after losing the Controller surface", async () => {
		const { task, secondary, display } = harness()
		task.messageResources.openDisplay.mockImplementationOnce(async () => {
			task.controllerDetached = true
		})
		const published = vi.fn(async () => undefined)
		secondary.resolve()
		await display(published)
		expect(published).not.toHaveBeenCalled()
		expect(task.activityStore.hydrate).not.toHaveBeenCalled()
	})

	it("propagates publication failures without starting secondary presentation IO", async () => {
		const { task, secondary, display } = harness()
		secondary.resolve()
		await expect(
			display(async () => {
				throw new Error("surface unavailable")
			}),
		).rejects.toThrow("surface unavailable")
		expect(task.taskState.isInitialized).toBe(false)
		expect(task.activityStore.hydrate).not.toHaveBeenCalled()
	})
})
