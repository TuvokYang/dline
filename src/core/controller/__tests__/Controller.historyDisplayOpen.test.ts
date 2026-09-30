import { Controller } from "@core/controller"
import type { HistoryItem } from "@shared/HistoryItem"
import { beforeEach, describe, expect, it, vi } from "vitest"

const historyLoad = vi.hoisted(() => ({ load: vi.fn<() => Promise<void>>(), instances: 0 }))
vi.mock("@core/storage/remote-config/fetch", () => ({ fetchRemoteConfig: vi.fn() }))
vi.mock("@/core/orchestrator/OrchestratorController", () => ({
	OrchestratorController: { getInstance: () => ({ registerController: vi.fn() }) },
}))
vi.mock("@core/task", () => ({
	Task: class {
		readonly taskId: string
		readonly taskInstanceId = `open-${++historyLoad.instances}`
		readonly readOnly: boolean
		constructor(params: { taskId: string; readOnly: boolean; uiMessage?: unknown; apiConversation?: unknown }) {
			this.taskId = params.taskId
			this.readOnly = params.readOnly
			if (params.uiMessage || params.apiConversation) throw new Error("History eagerly opened execution stores")
		}
		isReadOnly() {
			return this.readOnly
		}
		beginHistoryPreparation() {}
		displayHistory() {
			return historyLoad.load()
		}
		async prepareFromHistory(options?: { onReadyToDisplay?: () => Promise<void> }) {
			await options?.onReadyToDisplay?.()
		}
	},
}))

function historyItem(id: string): HistoryItem {
	return { id, ts: 1, task: `Task ${id}`, tokensIn: 0, tokensOut: 0, totalCost: 0 } as HistoryItem
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
	let resolve!: () => void
	let reject!: (error: Error) => void
	const promise = new Promise<void>((settle, fail) => {
		resolve = settle
		reject = fail
	})
	return { promise, resolve, reject }
}

/**
 * Build a Controller that already shows `visibleTaskId` and records every state
 * publication together with the lifecycle clear that preceded it.
 */
function createController(visibleTaskId: string) {
	const controller = Object.create(Controller.prototype) as Controller
	const events: string[] = []
	const clearTask = vi.fn(async (options?: { suppressPostState?: boolean; deferTeardown?: boolean }) => {
		events.push(`clear:${JSON.stringify(options ?? {})}`)
		controller.task = undefined
	})
	Object.assign(controller as unknown as Record<string, unknown>, {
		task: { taskId: visibleTaskId },
		stateManager: {
			loadTaskSettings: vi.fn(async () => undefined),
			clearTaskSettings: vi.fn(async () => undefined),
			getGlobalSettingsKey: () => undefined,
			getGlobalStateKey: (key: string) => (key === "taskHistory" ? [] : undefined),
			getTaskCacheRef: () => ({ taskCapabilityToggles: "{}", mode: "act" }),
		},
		lockService: { acquireTaskLock: vi.fn(async () => true) },
		workspaceManager: { getPrimaryRoot: () => ({ path: "E:/test/workspace" }) },
	})
	vi.spyOn(controller, "runTaskLifecycleOperation").mockImplementation(async (operation) => operation({ clearTask }))
	vi.spyOn(controller, "postStateToWebview").mockImplementation(async () => {
		events.push(`post:${controller.task?.taskId ?? "none"}`)
	})
	const internals = controller as unknown as Record<string, unknown>
	internals.ensureWorkspaceManager = vi.fn(async () => undefined)
	internals.ensureIgnoreController = vi.fn(async () => ({}))
	internals.resolveWorkspaceHistoryManager = () => ({
		beginTask: () => ({}),
		publishMetadata: vi.fn(),
		publishCompletion: vi.fn(),
		closeTask: vi.fn(),
	})
	internals.restartAccountUsagePolling = vi.fn()
	internals.syncPanelTitle = vi.fn(async () => undefined)
	internals.persistPanelStateIfNeeded = vi.fn(async () => undefined)
	internals.startLockPoll = vi.fn()
	internals.startLockHeartbeat = vi.fn()
	return { controller, events, clearTask }
}

/**
 * Opening a task from history replaces one visible task with another. The
 * intermediate "no task" state used to reach the Webview, which sent the user
 * to the home view until the history snapshot finished loading.
 */
describe("Controller history display open", () => {
	beforeEach(() => {
		historyLoad.load.mockReset()
	})

	it("replaces the visible task without publishing an empty surface", async () => {
		historyLoad.load.mockResolvedValue(undefined)
		const { controller, events } = createController("task-old")

		await controller.initTask(undefined, undefined, undefined, historyItem("task-new"))

		expect(events[0]).toBe(`clear:${JSON.stringify({ suppressPostState: true, deferTeardown: false })}`)
		expect(events).not.toContain("post:none")
		expect(events.slice(1).every((event) => event === "post:task-new")).toBe(true)
	})

	it("publishes the preparing surface before the history window finishes loading", async () => {
		const load = deferred()
		historyLoad.load.mockReturnValue(load.promise)
		const { controller, events } = createController("task-old")

		const publish = async () => controller.postStateToWebview({ immediate: true })
		const opening = controller.initTask(undefined, undefined, undefined, historyItem("task-new"), undefined, {
			onHistoryTaskPreparingToDisplay: publish,
			onHistoryTaskReadyToDisplay: publish,
		})
		await vi.waitFor(() => expect(events).toContain("post:task-new"))
		const publishedBeforeLoad = events.filter((event) => event === "post:task-new").length

		load.resolve()
		await opening

		expect(publishedBeforeLoad).toBe(1)
		// The ready projection follows once the durable window is loaded.
		expect(events.filter((event) => event === "post:task-new")).toHaveLength(3)
	})

	it("waits for teardown when the same task is reopened", async () => {
		historyLoad.load.mockResolvedValue(undefined)
		const { controller, clearTask } = createController("task-same")

		await controller.initTask(undefined, undefined, undefined, historyItem("task-same"))

		// Reopening the same task must not overlap its own teardown with the new load.
		expect(clearTask).toHaveBeenCalledWith({ suppressPostState: true, deferTeardown: false })
	})

	it("releases a history surface that failed to load", async () => {
		historyLoad.load.mockRejectedValue(new Error("history window unreadable"))
		const { controller, clearTask } = createController("task-old")

		await expect(controller.initTask(undefined, undefined, undefined, historyItem("task-broken"))).rejects.toThrow(
			"history window unreadable",
		)

		// The first clear replaced the old task; the second releases the broken
		// preparing surface so the user is not left on a disabled Resume view.
		expect(clearTask).toHaveBeenCalledTimes(2)
		expect(controller.task).toBeUndefined()
	})
})
