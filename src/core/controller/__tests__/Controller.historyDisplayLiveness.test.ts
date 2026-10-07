import type { HistoryItem } from "@shared/HistoryItem"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Controller } from "../index"

/** A promise the test settles by hand, standing in for slow durable work. */
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

const display = vi.hoisted(() => {
	class FakeHistoryDisplaySession {
		readonly taskId: string
		loadOptions: unknown
		readonly startMaintenance = vi.fn()
		readonly markLocked = vi.fn()
		readonly dispose = vi.fn(async () => undefined)
		constructor(readonly historyItem: { id: string }) {
			this.taskId = historyItem.id
			display.instances.push(this)
		}
		async load(options: unknown): Promise<void> {
			this.loadOptions = options
		}
	}
	return { instances: [] as FakeHistoryDisplaySession[], FakeHistoryDisplaySession }
})

const profile = vi.hoisted(() => ({
	/** Replaced per test; the Profile resolution waits for it. */
	gate: Promise.resolve() as Promise<void>,
	adopt: vi.fn(),
}))

vi.mock("../task/HistoryDisplaySession", () => ({ HistoryDisplaySession: display.FakeHistoryDisplaySession }))
vi.mock("../task/history-task-readiness", () => ({
	prepareHistoryTaskForDisplay: async (options: {
		displayHistory: () => Promise<void>
		isCurrent: () => boolean
		onReadyToDisplay?: () => Promise<void>
	}) => {
		await options.displayHistory()
		if (!options.isCurrent()) return false
		await options.onReadyToDisplay?.()
		return true
	},
}))
vi.mock("@/core/task/ApiProfileRecovery", () => ({
	resolveTaskApiProfileFresh: async () => {
		await profile.gate
		return { usedFallback: false, resolvedProfileId: "profile-1", resolvedProfile: { name: "Renamed" } }
	},
}))
vi.mock("@/core/task/TaskStateManager", () => ({
	TaskStateManager: class {
		readonly mode = "act"
		adoptResolvedProfileIdentity(...args: unknown[]) {
			profile.adopt(...args)
		}
	},
}))

type PrivateController = {
	initHistoryDisplaySession(historyItem: HistoryItem, options?: unknown): Promise<string>
	promoteHistoryDisplay(session: unknown): Promise<void>
}
const controllerPrototype = Controller.prototype as unknown as PrivateController & Record<string, unknown>

function subject() {
	const events: string[] = []
	const flushPendingState = vi.fn(async () => {
		events.push("flush")
	})
	const controller = {
		historyDisplaySession: undefined as unknown,
		historyDisplayProfileBindings: new WeakMap(),
		taskLockAcquired: true,
		stateManager: {
			loadTaskSettings: vi.fn(async () => undefined),
			getApiConfigurationForTask: vi.fn(() => ({})),
			flushPendingState,
		},
		isTaskLockedByAnotherInstance: vi.fn(async () => false),
		postStateToWebview: vi.fn(async (options?: { immediate?: boolean }) => {
			events.push(options?.immediate ? "post:immediate" : "post")
		}),
		syncPanelTitle: vi.fn(async () => undefined),
		persistPanelStateIfNeeded: vi.fn(async () => undefined),
		startLockPoll: vi.fn(),
		stopLockPoll: vi.fn(),
		initTask: vi.fn(async () => {
			events.push("initTask")
		}),
		adoptHistoryDisplayProfileIdentity: controllerPrototype.adoptHistoryDisplayProfileIdentity,
	}
	return { controller, events, flushPendingState }
}

const historyItem = { id: "history-task", ts: 1, task: "Earlier task" } as HistoryItem

describe("opening a task from History", () => {
	beforeEach(() => {
		display.instances.length = 0
		profile.adopt.mockClear()
	})

	it("publishes the first frame without waiting for the Profile binding or the maintenance", async () => {
		const resolution = deferred<void>()
		profile.gate = resolution.promise
		const { controller, events } = subject()
		const ready = vi.fn(async () => {
			events.push("ready")
		})

		await controllerPrototype.initHistoryDisplaySession.call(controller, historyItem, {
			onHistoryTaskReadyToDisplay: ready,
		})

		const [session] = display.instances
		expect(session?.loadOptions).toMatchObject({ deferMaintenance: true })
		// The frame went out while the Profile was still resolving.
		expect(events).toEqual(["post:immediate", "ready"])
		// Maintenance blocks the host while it hydrates, so it starts after the frame.
		expect(session?.startMaintenance).toHaveBeenCalledTimes(1)
		expect(session?.startMaintenance.mock.invocationCallOrder[0]).toBeGreaterThan(ready.mock.invocationCallOrder[0] ?? 0)

		resolution.resolve()
		await vi.waitFor(() => expect(events).toEqual(["post:immediate", "ready", "flush", "post"]))
		expect(profile.adopt).toHaveBeenCalledWith("act", "profile-1", { name: "Renamed" })
	})

	it("does not redraw a display that was replaced before its binding landed", async () => {
		const resolution = deferred<void>()
		profile.gate = resolution.promise
		const { controller, events } = subject()

		await controllerPrototype.initHistoryDisplaySession.call(controller, historyItem)
		controller.historyDisplaySession = undefined
		resolution.resolve()

		await vi.waitFor(() => expect(events).toContain("flush"))
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(events).toEqual(["post:immediate", "flush"])
	})

	it("promotes only after the binding was written, since the runtime reloads task settings", async () => {
		const resolution = deferred<void>()
		profile.gate = resolution.promise
		const { controller, events } = subject()
		await controllerPrototype.initHistoryDisplaySession.call(controller, historyItem)
		const [session] = display.instances

		const promoted = controllerPrototype.promoteHistoryDisplay.call(controller, session)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(controller.initTask).not.toHaveBeenCalled()

		resolution.resolve()
		await promoted
		expect(events.indexOf("flush")).toBeLessThan(events.indexOf("initTask"))
		expect(session?.dispose).toHaveBeenCalledTimes(1)
	})
})
