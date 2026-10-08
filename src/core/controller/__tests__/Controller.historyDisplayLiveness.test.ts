import type { HistoryItem } from "@shared/HistoryItem"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Controller } from "../index"
import { OpeningHandoff } from "../task/OpeningHandoff"

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
		readonly surfacePublished = vi.fn()
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
	/** The user's own Profile pick written to the task. */
	bind: vi.fn(),
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
		setProfileIdentityBindings(...args: unknown[]) {
			profile.bind(...args)
			return {}
		}
		restoreProfileState() {}
	},
}))

type PrivateController = {
	initHistoryDisplaySession(historyItem: HistoryItem, options?: unknown): Promise<string>
	promoteHistoryDisplay(session: unknown): Promise<void>
	promoteHistoryDisplayForActivityControl(taskId: string): Promise<boolean>
	commitHistoryDisplayProfile(
		display: unknown,
		resolution: { profileId: string; profileName: string },
		modes: readonly string[],
	): Promise<{ status: string }>
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
		openingHandoff: new OpeningHandoff(),
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
		restartAccountUsagePolling: vi.fn(),
	}
	return { controller, events, flushPendingState }
}

const historyItem = { id: "history-task", ts: 1, task: "Earlier task" } as HistoryItem

describe("opening a task from History", () => {
	beforeEach(() => {
		display.instances.length = 0
		profile.adopt.mockClear()
		profile.bind.mockClear()
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
		// The frame went out while the Profile was still resolving.
		expect(events).toEqual(["post:immediate", "ready"])
		// Activity IO blocks the host, so the display learns the frame is out only after it was posted.
		expect(session?.surfacePublished).toHaveBeenCalledTimes(1)
		expect(session?.surfacePublished.mock.invocationCallOrder[0]).toBeGreaterThan(ready.mock.invocationCallOrder[0] ?? 0)

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

	// The switcher is usable before the task's own binding lands; writing the
	// pick first let the late adoption overwrite it with the old Profile.
	it("writes a Profile picked while the binding is pending after that binding, so the pick wins", async () => {
		const resolution = deferred<void>()
		profile.gate = resolution.promise
		const { controller } = subject()
		await controllerPrototype.initHistoryDisplaySession.call(controller, historyItem)
		const session = Object.assign(display.instances[0] ?? {}, { isLocked: () => false })

		const switched = controllerPrototype.commitHistoryDisplayProfile.call(
			controller,
			session,
			{ profileId: "profile-2", profileName: "Chosen" },
			["act"],
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(profile.bind).not.toHaveBeenCalled()

		resolution.resolve()
		await expect(switched).resolves.toMatchObject({ status: "switched" })
		expect(profile.adopt).toHaveBeenCalledTimes(1)
		expect(profile.adopt.mock.invocationCallOrder[0]).toBeLessThan(profile.bind.mock.invocationCallOrder[0] ?? 0)
	})

	// Retry on a retained subagent acts on the new opening at once; until the
	// Webview learns that opening it ignores the activity stream keyed to it.
	it("hands the promoted opening to the Webview before an activity control acts on it", async () => {
		const patch = deferred<void>()
		const controller = {
			task: undefined as { taskId: string } | undefined,
			historyDisplaySession: { taskId: "history-task", isLocked: () => false },
			runTaskLifecycleOperation: <T>(operation: () => Promise<T>) => operation(),
			canPromoteHistoryDisplay: controllerPrototype.canPromoteHistoryDisplay,
			promoteHistoryDisplay: vi.fn(async () => {
				controller.task = { taskId: "history-task" }
			}),
			postTaskViewPatchToWebview: vi.fn(() => patch.promise),
		}
		let settled = false

		const promoted = controllerPrototype.promoteHistoryDisplayForActivityControl
			.call(controller, "history-task")
			.finally(() => {
				settled = true
			})
		await vi.waitFor(() => expect(controller.postTaskViewPatchToWebview).toHaveBeenCalledTimes(1))
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(settled).toBe(false)

		patch.resolve()
		await expect(promoted).resolves.toBe(true)
	})
})
