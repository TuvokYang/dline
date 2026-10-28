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
        readonly disposeForPromotion = vi.fn(async () => undefined)
        /** False when the display read a legacy history its runtime renumbers on import. */
        canonicalIndexes = true
        hasCanonicalMessageIndexes(): boolean {
            return this.canonicalIndexes
        }
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
        messageIndexSpace: 0,
        historyDisplayProfileBindings: new WeakMap(),
        openingHandoff: new OpeningHandoff(),
        taskLockAcquired: true,
        stateManager: {
            loadTaskSettings: vi.fn(async () => undefined),
            getApiConfigurationForTask: vi.fn(() => ({})),
            flushPendingState,
        },
        // An unlocked task makes this surface its owner, so the Profile binding runs.
        lockService: {
            instanceAddress: "this-window",
            checkTaskLock: vi.fn(async () => ({ isLocked: false, isStale: false })),
        },
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

    it("promotes without waiting for the background Profile binding", async () => {
        const resolution = deferred<void>()
        profile.gate = resolution.promise
        const { controller, events } = subject()
        await controllerPrototype.initHistoryDisplaySession.call(controller, historyItem)
        const [session] = display.instances

        await controllerPrototype.promoteHistoryDisplay.call(controller, session)

        expect(controller.initTask).toHaveBeenCalledTimes(1)
        expect(events).toContain("initTask")
        expect(events).not.toContain("flush")
        expect(session?.disposeForPromotion).toHaveBeenCalledTimes(1)
        expect(session?.dispose).not.toHaveBeenCalled()

        resolution.resolve()
        await vi.waitFor(() => expect(events).toContain("flush"))
    })

    // The display kept its opening, so only the index space tells the Webview
    // that the window it holds is numbered differently from the runtime's rows.
    it("renumbers the shown window when the promoted display read a legacy history", async () => {
        const { controller } = subject()
        await controllerPrototype.initHistoryDisplaySession.call(controller, historyItem)
        const [session] = display.instances
        if (!session) throw new Error("expected a history display")
        session.canonicalIndexes = false

        await controllerPrototype.promoteHistoryDisplay.call(controller, session)

        expect(controller.messageIndexSpace).toBe(1)
    })

    // The runtime publishes its canonical totals as soon as initTask installs it.
    // A state carrying those totals with the display's numbering makes the Webview
    // page forward from display positions and splice old rows into its window.
    it("announces the new numbering before the promoted runtime can publish its rows", async () => {
        const { controller } = subject()
        await controllerPrototype.initHistoryDisplaySession.call(controller, historyItem)
        const [session] = display.instances
        if (!session) throw new Error("expected a history display")
        session.canonicalIndexes = false
        const numberingSeenByRuntime: number[] = []
        controller.initTask.mockImplementation(async () => {
            numberingSeenByRuntime.push(controller.messageIndexSpace)
        })

        await controllerPrototype.promoteHistoryDisplay.call(controller, session)

        expect(numberingSeenByRuntime).toEqual([1])
        expect(controller.messageIndexSpace).toBe(1)
    })

    it("keeps the window numbering when the promoted display read the task's own rows", async () => {
        const { controller } = subject()
        await controllerPrototype.initHistoryDisplaySession.call(controller, historyItem)
        const [session] = display.instances

        await controllerPrototype.promoteHistoryDisplay.call(controller, session)

        expect(controller.messageIndexSpace).toBe(0)
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
