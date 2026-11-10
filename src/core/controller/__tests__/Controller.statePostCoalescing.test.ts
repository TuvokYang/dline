import { PromptFreshnessInvalidationCoordinator } from "@core/prompts/system-prompt-cache/PromptFreshnessInvalidationCoordinator"
import { createInitialTaskState } from "@core/task/kernel"
import type { MessageStateHandler } from "@core/task/message-state"
import { TaskInputPresenter } from "@core/task/session/TaskInputPresenter"
import { InMemoryTaskPayloadStore } from "@core/task/stores/InMemoryRuntimeStores"
import { encodeTaskPayload } from "@core/task/stores/payload/TaskPayloadCodec"
import { projectCanonicalTaskView } from "@core/task/view/canonical/projectCanonicalTaskView"
import type { ExtensionState, TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import type { PromptFreshnessSnapshot } from "@shared/PromptFreshness"
import type { UiLanguagePreference } from "@shared/UiLanguage"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Controller } from "../index"
import { OpeningHandoff } from "../task/OpeningHandoff"

vi.mock(import("../state/subscribeToState"), async (importOriginal) => ({
    ...(await importOriginal()),
    cleanupStateSubscriptions: vi.fn(() => ({
        subscriberCount: 0,
        hadPendingUpdate: false,
        hadDebounceTimer: false,
        hadSendChain: false,
    })),
    sendStatePatch: vi.fn(async () => undefined),
    sendStateUpdate: vi.fn(async () => undefined),
}))

import { sendStatePatch, sendStateUpdate } from "../state/subscribeToState"

type BuildSpy = ReturnType<typeof vi.fn>

/**
 * Build a controller whose state build is observable and free of real IO.
 *
 * Only the collaborators that postStateToWebview actually touches are
 * supplied, so a regression in the coalescing path cannot be masked by an
 * unrelated stub resolving first.
 */
function createController(taskId?: string): { controller: Controller; buildState: BuildSpy; setActiveTaskId: BuildSpy } {
    const controller = Object.create(Controller.prototype) as Controller
    const setActiveTaskId = vi.fn()
    let revision = 0
    const buildState = vi.fn(async () => ({ stateRevision: revision }) as never)

    Object.assign(controller, {
        uiDetached: false,
        disposed: false,
        suppressedStatePostsAfterDetach: 0,
        stateBuildsAfterDetach: 0,
        nextStateRevision: 0,
        latestStateRevision: 0,
        publicationSequence: 0,
        pendingStatePostTimer: undefined,
        openingHandoff: new OpeningHandoff(),
        _accountUsage: undefined,
        task: taskId ? { taskId } : undefined,
        stateManager: { setActiveTaskId },
    })

    vi.spyOn(controller as Controller & { buildState(r: number): Promise<never> }, "buildState").mockImplementation(
        async (r: number) => {
            revision = r
            return buildState() as never
        },
    )

    return { controller, buildState, setActiveTaskId }
}

/**
 * Let a real `postTaskViewPatchToWebview` reach `sendStatePatch`.
 *
 * The patch path is what owns the throttle bookkeeping, so replacing the method
 * itself would leave those steps unexecuted and make the assertions vacuous.
 */
function stubTaskView(controller: Controller): void {
    Object.assign(controller, {
        taskViewPatchScheduled: false,
        taskViewPatchScheduledAt: 0,
        taskViewPatchThrottleTimer: undefined,
    })
    vi.spyOn(
        controller as unknown as { projectCurrentTaskViewState(): TaskViewState | undefined },
        "projectCurrentTaskViewState",
    ).mockReturnValue({ taskId: "task-a" } as TaskViewState)
}

describe("Controller state publication coalescing", () => {
    beforeEach(() => {
        vi.mocked(sendStatePatch).mockClear()
        vi.mocked(sendStateUpdate).mockClear()
    })

    it("builds state once for a burst of ordinary publications", async () => {
        vi.useFakeTimers()
        try {
            const { controller, buildState } = createController()

            await controller.postStateToWebview()
            await controller.postStateToWebview()
            await controller.postStateToWebview()

            // The whole point of merging before the build: a burst must not pay
            // for three full builds that are then thrown away.
            expect(buildState).not.toHaveBeenCalled()

            await vi.advanceTimersByTimeAsync(50)

            expect(buildState).toHaveBeenCalledTimes(1)
            expect(sendStateUpdate).toHaveBeenCalledTimes(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it("delivers an accepted task title after an empty opening without provider activity", async () => {
        vi.useFakeTimers()
        const { controller } = createController("task-a")
        try {
            const rows: UiMessage[] = []
            const payloads = new InMemoryTaskPayloadStore()
            const payloadRef = await payloads.put(
                encodeTaskPayload({ kind: "user_input", entryId: "entry-a", text: "new task input" }),
            )
            const messages = {
                clineMessages: rows,
                captureConversationPosition: () => ({ conversationHistoryIndex: -1 }),
                addToClineMessages: async (row: UiMessage) => {
                    rows.push(row)
                },
            } as unknown as MessageStateHandler
            vi.spyOn(controller as Controller & { buildState(r: number): Promise<never> }, "buildState").mockImplementation(
                async (stateRevision: number) =>
                    ({
                        stateRevision,
                        taskTitleMessage: rows.find((row) => row.say === "task"),
                        totalMessageCount: rows.filter((row) => row.say !== "task").length,
                    }) satisfies Pick<ExtensionState, "stateRevision" | "taskTitleMessage" | "totalMessageCount"> as never,
            )
            await controller.postStateToWebview({ immediate: true })
            expect(vi.mocked(sendStateUpdate).mock.calls[0]?.[1].taskTitleMessage).toBeUndefined()
            const presenter = new TaskInputPresenter(
                payloads,
                messages,
                () => 1000,
                () => controller.postStateToWebview(),
            )
            const prepared = await presenter.prepare({ entryId: "entry-a", payloadRef })
            await prepared.commit()
            await vi.advanceTimersByTimeAsync(50)

            const delivered = vi.mocked(sendStateUpdate).mock.calls.at(-1)?.[1]
            expect(delivered?.taskTitleMessage).toMatchObject({ say: "task", text: "new task input", interactionId: "entry-a" })
            expect(delivered?.totalMessageCount).toBe(0)
            expect(sendStatePatch).not.toHaveBeenCalled()
        } finally {
            Object.assign(controller, { disposed: true })
            vi.clearAllTimers()
            vi.useRealTimers()
        }
    })

    it("holds a late input publication across an opening handoff and publishes only the new opening", async () => {
        vi.useFakeTimers()
        const { controller } = createController("task-a")
        const handoff = new OpeningHandoff()
        const rows: UiMessage[] = []
        const payloads = new InMemoryTaskPayloadStore()
        const payloadRef = await payloads.put(
            encodeTaskPayload({ kind: "user_input", entryId: "old-entry", text: "old task input" }),
        )
        const messages = {
            clineMessages: rows,
            captureConversationPosition: () => ({ conversationHistoryIndex: -1 }),
            addToClineMessages: async (row: UiMessage) => {
                rows.push(row)
            },
        } as unknown as MessageStateHandler
        const newTitle: UiMessage = { ts: 2000, type: "say", say: "task", text: "new opening input" }
        Object.assign(controller, { openingHandoff: handoff })
        vi.spyOn(controller as Controller & { buildState(r: number): Promise<never> }, "buildState").mockImplementation(
            async (stateRevision: number) =>
                ({
                    stateRevision,
                    taskTitleMessage:
                        controller.currentOpening()?.taskId === "task-b" ? newTitle : rows.find((row) => row.say === "task"),
                    totalMessageCount: 0,
                }) satisfies Pick<ExtensionState, "stateRevision" | "taskTitleMessage" | "totalMessageCount"> as never,
        )
        let finishHandoff!: () => void
        const replacing = new Promise<void>((resolve) => {
            finishHandoff = resolve
        })
        let replacement: Promise<void> | undefined
        try {
            await controller.postStateToWebview({ immediate: true })
            replacement = handoff.run(
                async () => {
                    Object.assign(controller, { task: undefined })
                    await replacing
                    Object.assign(controller, { task: { taskId: "task-b" } })
                },
                () => controller.postStateToWebview({ immediate: true }),
            )
            const presenter = new TaskInputPresenter(
                payloads,
                messages,
                () => 1000,
                () => controller.postStateToWebview(),
            )
            await (await presenter.prepare({ entryId: "old-entry", payloadRef })).commit()
            await vi.advanceTimersByTimeAsync(50)
            expect(vi.mocked(sendStateUpdate).mock.calls.map((call) => call[1].taskTitleMessage)).toEqual([undefined])
            finishHandoff()
            await replacement

            expect(vi.mocked(sendStateUpdate).mock.calls.map((call) => call[1].taskTitleMessage?.text)).toEqual([
                undefined,
                "new opening input",
            ])
            expect(controller.getCurrentTaskId()).toBe("task-b")
        } finally {
            Object.assign(controller, { disposed: true })
            finishHandoff()
            await replacement
            vi.clearAllTimers()
            vi.useRealTimers()
        }
    })

    it("builds and sends an immediate publication without waiting", async () => {
        vi.useFakeTimers()
        try {
            const { controller, buildState } = createController()

            await controller.postStateToWebview({ immediate: true })

            expect(buildState).toHaveBeenCalledTimes(1)
            expect(sendStateUpdate).toHaveBeenCalledTimes(1)
            expect(vi.mocked(sendStateUpdate).mock.calls[0]?.[3]).toEqual({ immediate: true })
        } finally {
            vi.useRealTimers()
        }
    })

    it("coalesces transient Task view publications without building full state", async () => {
        const { controller, buildState } = createController("task-a")
        const publishPatch = vi.spyOn(controller, "postTaskViewPatchToWebview").mockResolvedValue(undefined)
        const transient = controller as unknown as { scheduleTaskViewPatch(): void }

        transient.scheduleTaskViewPatch()
        transient.scheduleTaskViewPatch()
        transient.scheduleTaskViewPatch()
        await Promise.resolve()
        await Promise.resolve()

        expect(publishPatch).toHaveBeenCalledTimes(1)
        expect(buildState).not.toHaveBeenCalled()
        expect(sendStateUpdate).not.toHaveBeenCalled()
    })

    it("publishes an interaction-critical Task view without building full state", async () => {
        const { controller, buildState, setActiveTaskId } = createController("task-a")
        const taskViewState = { taskId: "task-a", stateRevision: 7 } as TaskViewState
        vi.spyOn(
            controller as unknown as { projectCurrentTaskViewState(): TaskViewState | undefined },
            "projectCurrentTaskViewState",
        ).mockReturnValue(taskViewState)

        await controller.postTaskViewPatchToWebview()

        expect(setActiveTaskId).toHaveBeenCalledWith("task-a")
        expect(buildState).not.toHaveBeenCalled()
        expect(sendStatePatch).toHaveBeenCalledWith(controller, { stateRevision: 1, taskViewState }, undefined)
    })

    // A reopened task publishes its restored dialog through the interaction
    // patch rather than a full state build. Projecting that patch without the
    // task's rows left the anchor unresolved, so the composer stayed disabled
    // and the interaction was never offered: the task looked permanently stuck
    // even though its dialog was awaiting an answer.
    it("projects the interaction patch against the task's own messages", async () => {
        const { controller } = createController("task-a")
        const initial = createInitialTaskState("task-a")
        const view = projectCanonicalTaskView({
            ...initial,
            revision: 7,
            flow: { phase: "paused" },
            dialog: {
                approvalsByBlock: {},
                primary: {
                    interactionId: "interaction-1",
                    turnId: "turn-1",
                    kind: "completion",
                    status: "awaiting",
                    createdRevision: 6,
                    presentationRef: "completion:turn-1",
                    receiverGeneration: 0,
                    actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
                },
            },
        })
        Object.assign(controller, {
            task: {
                taskId: "task-a",
                writable: true,
                projectView: () => view,
                owners: {
                    messages: {
                        clineMessages: [
                            {
                                type: "ask",
                                ask: "completion_result",
                                ts: 20,
                                text: "done",
                                interactionId: "interaction-1",
                                partial: false,
                            },
                        ],
                    },
                    commands: {
                        getReadyBackgroundHandoffActivityId: () => undefined,
                        isBackgroundHandoffRequested: () => false,
                    },
                },
            },
        })

        await controller.postTaskViewPatchToWebview()

        const patched = vi.mocked(sendStatePatch).mock.calls[0]?.[1] as { taskViewState?: TaskViewState }
        expect(patched.taskViewState?.activeInteraction).toMatchObject({
            interactionId: "interaction-1",
            status: "awaiting",
            askMessageTs: 20,
        })
        expect(patched.taskViewState?.input).toMatchObject({ enabled: true, enterAction: "reply" })
    })

    it("lets an immediate publication supersede a pending merge window", async () => {
        vi.useFakeTimers()
        try {
            const { controller, buildState } = createController()

            await controller.postStateToWebview()
            await controller.postStateToWebview({ immediate: true })
            await vi.advanceTimersByTimeAsync(50)

            // The pending window must be dropped rather than firing a second
            // redundant build after the immediate one already published.
            expect(buildState).toHaveBeenCalledTimes(1)
            expect(sendStateUpdate).toHaveBeenCalledTimes(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it("synchronizes the active task id before the build is deferred", async () => {
        vi.useFakeTimers()
        try {
            const { controller, setActiveTaskId } = createController("task-a")

            await controller.postStateToWebview()

            // buildState is the only writer of the active task id, so deferring it
            // without this would leave task-scoped setting reads on the old task
            // for the whole merge window.
            expect(setActiveTaskId).toHaveBeenCalledWith("task-a")
        } finally {
            vi.useRealTimers()
        }
    })

    it("drops a pending merge window when the UI detaches", async () => {
        vi.useFakeTimers()
        try {
            const { controller, buildState } = createController()

            await controller.postStateToWebview()
            controller.detachUi()
            await vi.advanceTimersByTimeAsync(50)

            expect(buildState).not.toHaveBeenCalled()
            expect(sendStateUpdate).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })

    it("suppresses publications requested after detach", async () => {
        const { controller, buildState } = createController()
        controller.detachUi()

        await controller.postStateToWebview({ immediate: true })

        expect(buildState).not.toHaveBeenCalled()
        expect(sendStateUpdate).not.toHaveBeenCalled()
    })

    /** Let a released build's promise chain run to its end. */
    async function settle(): Promise<void> {
        for (let turn = 0; turn < 20; turn++) await Promise.resolve()
    }

    /** Hold the first state build open until released; later builds finish at once. */
    function holdFirstBuild(controller: Controller): { release(): void; builds(): number } {
        let release!: () => void
        const firstBuild = new Promise<void>((resolve) => {
            release = resolve
        })
        let builds = 0
        vi.spyOn(controller as Controller & { buildState(r: number): Promise<never> }, "buildState").mockImplementation(
            async (revision: number) => {
                builds++
                if (builds === 1) await firstBuild
                return { stateRevision: revision } as never
            },
        )
        return { release, builds: () => builds }
    }

    it("publishes again when a state read that never delivers overtakes a publication", async () => {
        vi.useFakeTimers()
        try {
            const { controller } = createController()
            const build = holdFirstBuild(controller)

            await controller.postStateToWebview()
            await vi.advanceTimersByTimeAsync(50)
            // A unary read (getLatestState, getProcessInfo) finishes while the
            // publication is still building, which makes that build stale.
            await controller.getStateToPostToWebview()
            build.release()
            await settle()
            expect(sendStateUpdate).not.toHaveBeenCalled()

            // Nothing else will publish once a dialog is revealed, so the dropped
            // build must be replaced by one that reaches the webview.
            await vi.advanceTimersByTimeAsync(50)
            await settle()
            expect(sendStateUpdate).toHaveBeenCalledTimes(1)
            expect(build.builds()).toBe(3)
            expect(vi.mocked(sendStateUpdate).mock.calls[0]?.[1]).toMatchObject({ stateRevision: 3 })
        } finally {
            vi.useRealTimers()
        }
    })

    it.each([
        "zh-CN",
        "auto",
    ] as const)("delivers committed %s while streaming Task patches keep full snapshots stale", async (preference) => {
        vi.useFakeTimers()
        const releases: (() => void)[] = []
        let publication: Promise<void> | undefined
        let languagePublication: Promise<void> | undefined
        const { controller } = createController("task-a")
        try {
            stubTaskView(controller)
            let committed: UiLanguagePreference = "en"
            Object.assign(controller.stateManager, { getUiLanguagePreference: () => committed })
            vi.spyOn(controller as Controller & { buildState(r: number): Promise<never> }, "buildState").mockImplementation(
                async (stateRevision: number) => {
                    const snapshot = { stateRevision, uiLanguage: committed }
                    await new Promise<void>((release) => releases.push(release))
                    return snapshot as never
                },
            )
            publication = controller.postStateToWebview({ immediate: true })
            await settle()

            committed = preference
            const languageOnly = { immediate: true, projection: "ui-language" as const }
            languagePublication = controller.postStateToWebview(languageOnly)
            await settle()
            for (let round = 0; round < 3; round++) {
                await controller.postTaskViewPatchToWebview()
                releases.shift()?.()
                await settle()
                await vi.advanceTimersByTimeAsync(50)
            }

            // A real publication must carry the committed preference before
            // any full build becomes deliverable. Merely retrying a full
            // snapshot can be starved forever by a streaming Task.
            const languagePatches = vi.mocked(sendStatePatch).mock.calls.map((call) => call[1])
            expect(languagePatches.find((patch) => patch.uiLanguage === preference)).toMatchObject({
                uiLanguage: preference,
            })
            expect(sendStateUpdate).not.toHaveBeenCalled()
            expect(languagePatches.at(-1)?.stateRevision).toBeGreaterThan(languagePatches[0].stateRevision)
            await languagePublication
        } finally {
            Object.assign(controller, { disposed: true })
            for (const release of releases) release()
            await Promise.all([publication, languagePublication])
            await settle()
            vi.clearAllTimers()
            vi.useRealTimers()
        }
    })

    it.each([
        { patches: 1, replacement: false },
        { patches: 3, replacement: false },
        { patches: 1, replacement: true },
        { patches: 3, replacement: true },
    ])("delivers stale prompt freshness after $patches patches (replacement=$replacement)", async ({ patches, replacement }) => {
        vi.useFakeTimers()
        const { controller } = createController("task-a")
        const releases: (() => void)[] = []
        let holdBuilds = false
        let freshness: PromptFreshnessSnapshot = { status: "fresh", changes: [], checkedAt: 0 }
        const coordinator = new PromptFreshnessInvalidationCoordinator({
            reevaluate: async () => {
                freshness = { status: "stale", changes: [{ kind: "rules", summary: "Rules changed" }], checkedAt: 1 }
            },
            publishState: () => controller.postStateToWebview(),
        })
        try {
            stubTaskView(controller)
            vi.spyOn(controller as Controller & { buildState(r: number): Promise<never> }, "buildState").mockImplementation(
                async (stateRevision: number) => {
                    const snapshot = { stateRevision, promptFreshness: freshness }
                    if (holdBuilds) await new Promise<void>((release) => releases.push(release))
                    return snapshot as never
                },
            )
            await controller.postStateToWebview({ immediate: true })
            holdBuilds = true
            coordinator.invalidate("prompt_input_file")
            await vi.advanceTimersByTimeAsync(250)

            for (let round = 0; round < patches; round++) {
                expect(releases).toHaveLength(1)
                await controller.postTaskViewPatchToWebview()
                if (replacement && round === patches - 1) {
                    holdBuilds = false
                    await controller.postStateToWebview({ immediate: true })
                }
                releases.shift()?.()
                await settle()
                if (round < patches - 1) await vi.advanceTimersByTimeAsync(50)
            }
            // Once the finite burst ends, the dropped full snapshot must be
            // replaced without another invalidation or a unary state read.
            holdBuilds = false
            await vi.advanceTimersByTimeAsync(150)
            await settle()

            expect(sendStatePatch).toHaveBeenCalledTimes(patches)
            expect(sendStateUpdate).toHaveBeenCalledTimes(2)
            const delivered = vi.mocked(sendStateUpdate).mock.calls.at(-1)?.[1]
            expect(delivered?.promptFreshness).toMatchObject({
                status: "stale",
                changes: [{ kind: "rules" }],
            })
            expect(delivered?.stateRevision).toBeGreaterThan(
                vi.mocked(sendStatePatch).mock.calls.at(-1)?.[1].stateRevision ?? Number.POSITIVE_INFINITY,
            )
        } finally {
            coordinator.dispose()
            Object.assign(controller, { disposed: true })
            for (const release of releases) release()
            await settle()
            vi.clearAllTimers()
            vi.useRealTimers()
        }
    })

    it("does not publish again when a newer publication overtook the dropped build", async () => {
        vi.useFakeTimers()
        try {
            const { controller } = createController()
            const build = holdFirstBuild(controller)

            await controller.postStateToWebview()
            await vi.advanceTimersByTimeAsync(50)
            await controller.postStateToWebview({ immediate: true })
            build.release()
            await settle()
            await vi.advanceTimersByTimeAsync(100)
            await settle()

            expect(build.builds()).toBe(2)
            expect(sendStateUpdate).toHaveBeenCalledTimes(1)
            expect(vi.mocked(sendStateUpdate).mock.calls[0]?.[1]).toMatchObject({ stateRevision: 2 })
        } finally {
            vi.useRealTimers()
        }
    })

    // A hidden panel still owns and runs its task; only presentation stops. The
    // cost that made parallel panels expensive was paying for a build and a
    // delivery that no surface could show.
    it("skips the build and the delivery while the surface is hidden", async () => {
        const { controller, buildState } = createController("task-a")
        controller.setSurfaceVisible(false)

        await controller.postStateToWebview({ immediate: true })

        expect(buildState).not.toHaveBeenCalled()
        expect(sendStateUpdate).not.toHaveBeenCalled()
    })

    it("publishes once from current state when the surface becomes visible again", async () => {
        const { controller, buildState } = createController("task-a")
        controller.setSurfaceVisible(false)
        await controller.postStateToWebview({ immediate: true })
        await controller.postStateToWebview({ immediate: true })
        expect(buildState).not.toHaveBeenCalled()

        controller.setSurfaceVisible(true)
        await settle()

        // Replaying every skipped revision would rebuild once per hidden update;
        // the webview only needs the newest state, so exactly one build runs.
        expect(buildState).toHaveBeenCalledTimes(1)
        expect(sendStateUpdate).toHaveBeenCalledTimes(1)
        expect(vi.mocked(sendStateUpdate).mock.calls[0]?.[3]).toEqual({ immediate: true })
    })

    it("does not rebuild on return to sight when nothing was skipped", async () => {
        const { controller, buildState } = createController("task-a")

        controller.setSurfaceVisible(false)
        controller.setSurfaceVisible(true)
        await settle()

        expect(buildState).not.toHaveBeenCalled()
        expect(sendStateUpdate).not.toHaveBeenCalled()
    })

    it("throttles a stream of transient patches to one per window", async () => {
        vi.useFakeTimers()
        try {
            const { controller } = createController("task-a")
            stubTaskView(controller)
            const transient = controller as unknown as { scheduleTaskViewPatch(): void }

            // The first patch of a burst is immediate so streaming stays live;
            // every later patch inside the window is merged into one delivery.
            transient.scheduleTaskViewPatch()
            transient.scheduleTaskViewPatch()
            transient.scheduleTaskViewPatch()
            await Promise.resolve()
            expect(sendStatePatch).toHaveBeenCalledTimes(1)

            await vi.advanceTimersByTimeAsync(200)
            expect(sendStatePatch).toHaveBeenCalledTimes(2)

            // A patch after the quiet gap is delivered immediately again.
            transient.scheduleTaskViewPatch()
            await Promise.resolve()
            expect(sendStatePatch).toHaveBeenCalledTimes(3)
        } finally {
            vi.useRealTimers()
        }
    })

    it("delivers an interactive patch at once and drops the queued transient one", async () => {
        vi.useFakeTimers()
        try {
            const { controller } = createController("task-a")
            stubTaskView(controller)
            const transient = controller as unknown as { scheduleTaskViewPatch(): void }

            transient.scheduleTaskViewPatch()
            await Promise.resolve()
            expect(sendStatePatch).toHaveBeenCalledTimes(1)

            // Inside the window a transient patch is only queued. An approval must
            // not wait behind it, and the queued text is superseded by this call.
            transient.scheduleTaskViewPatch()
            await controller.postTaskViewPatchToWebview()
            expect(sendStatePatch).toHaveBeenCalledTimes(2)

            // The superseded projection must never be delivered afterwards: that
            // would move the view back to text the approval already replaced.
            await vi.advanceTimersByTimeAsync(200)
            expect(sendStatePatch).toHaveBeenCalledTimes(2)
        } finally {
            vi.useRealTimers()
        }
    })

    it("skips a transient Task view patch while hidden and repairs it on return", async () => {
        const { controller } = createController("task-a")
        const publishPatch = vi.spyOn(controller, "postTaskViewPatchToWebview")
        const projectView = vi.spyOn(
            controller as unknown as { projectCurrentTaskViewState(): TaskViewState | undefined },
            "projectCurrentTaskViewState",
        )
        controller.setSurfaceVisible(false)

        await controller.postTaskViewPatchToWebview()

        expect(projectView).not.toHaveBeenCalled()
        expect(sendStatePatch).not.toHaveBeenCalled()
        // The deferred flag belongs to the surface, so returning to sight runs
        // the full publication that replaces the patch the panel never saw.
        publishPatch.mockRestore()
        controller.setSurfaceVisible(true)
        await settle()
        expect(sendStateUpdate).toHaveBeenCalledTimes(1)
    })
})
