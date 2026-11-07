import type { ExtensionState } from "@shared/ExtensionMessage"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getRequestRegistry } from "../../grpc-handler"
import type { Controller } from "../../index"
import { cleanupStateSubscriptions, sendStatePatch, sendStateUpdate, subscribeToState } from "../subscribeToState"

/**
 * Behavior guard for delivering a payload that carries no change.
 *
 * A durable message boundary republishes the whole state even when nothing
 * changed, and an idle task produces a steady stream of them. Every delivery
 * costs each subscriber a full parse and re-render, so an identical payload is
 * dropped before it reaches the stream.
 *
 * The top-level `stateRevision` advances on every build and only lets the
 * Webview reject an out-of-order snapshot, so it is excluded from the
 * comparison. `taskViewState.stateRevision` is not excluded: the interaction
 * host uses it to decide what it may act on.
 */

interface StreamedPayload {
    stateJson: string
}

function createState(overrides: Partial<ExtensionState> = {}): ExtensionState {
    return {
        stateRevision: 1,
        isNewUser: false,
        welcomeViewCompleted: true,
        onboardingModels: undefined,
        ...overrides,
    } as ExtensionState
}

function createController(): Controller {
    return {
        isUiAttached: () => true,
        getAccountUsage: () => undefined,
        task: undefined,
    } as unknown as Controller
}

function createTaskView(): NonNullable<ExtensionState["taskViewState"]> {
    return {
        taskId: "task-1",
        taskInstanceId: "opening-1",
        phase: "between_turns",
        stateRevision: 10,
        input: { enabled: true, acceptsText: true, acceptsImages: true, acceptsFiles: true, enterAction: "reply" },
        footer: { actions: [] },
    }
}

/** Apply received events as the client does: revision fence, full replacement, patch merge. */
function projectDeliveredState(received: StreamedPayload[]): ExtensionState | undefined {
    let current: ExtensionState | undefined
    let revision = 0
    for (const { stateJson } of received) {
        if (!stateJson) continue
        const payload = JSON.parse(stateJson) as Partial<ExtensionState> & { __dlineStatePatch?: true }
        const isPatch = payload.__dlineStatePatch === true
        if (isPatch && !current) continue
        if (payload.stateRevision === undefined ? revision !== 0 : payload.stateRevision <= revision) continue
        revision = payload.stateRevision ?? 0
        const { __dlineStatePatch: _marker, ...fields } = payload
        current = (isPatch ? { ...current, ...fields } : fields) as ExtensionState
    }
    return current
}

function createSignal(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((complete) => {
        resolve = complete
    })
    return { promise, resolve }
}

/** Subscribe one stream, optionally hold a delivery, and return everything it receives. */
async function attachSubscriber(
    controller: Controller,
    state: ExtensionState,
    onPayload?: (payload: StreamedPayload) => Promise<void>,
    requestId?: string,
): Promise<StreamedPayload[]> {
    const received: StreamedPayload[] = []
    const target = controller as unknown as {
        getStateToPostToWebview(): Promise<ExtensionState>
        isStateCurrent(revision: number): boolean
        ensureWorkspaceManager?: () => Promise<void>
    }
    target.getStateToPostToWebview = async () => state
    target.isStateCurrent = () => true

    await subscribeToState(
        controller,
        {} as never,
        async (payload: StreamedPayload) => {
            received.push(payload)
            await onPayload?.(payload)
        },
        requestId,
    )
    return received
}

describe("state delivery equality guard", () => {
    let controller: Controller

    beforeEach(() => {
        controller = createController()
    })

    afterEach(() => {
        cleanupStateSubscriptions(controller)
    })

    it("delivers the first payload", async () => {
        const state = createState()
        const received = await attachSubscriber(controller, state)

        await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })

        expect(received).toHaveLength(2)
        expect(projectDeliveredState(received)?.stateRevision).toBe(2)
        cleanupStateSubscriptions(controller)
    })

    it("drops a payload that differs only by the top-level revision", async () => {
        const state = createState()
        const received = await attachSubscriber(controller, state)
        await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })
        const afterFirst = received.length

        await sendStateUpdate(controller, createState({ stateRevision: 3 }), undefined, { immediate: true })

        expect(received.length).toBe(afterFirst)
        cleanupStateSubscriptions(controller)
    })

    it("delivers a payload whose task view revision changed", async () => {
        const received = await attachSubscriber(controller, createState())
        await sendStateUpdate(
            controller,
            createState({ stateRevision: 2, taskViewState: { taskId: "t", stateRevision: 10 } as never }),
            undefined,
            { immediate: true },
        )
        const afterFirst = received.length

        // Only the nested revision moves: the interaction host acts on it, so
        // excluding it would strand the Webview on a superseded projection.
        await sendStateUpdate(
            controller,
            createState({ stateRevision: 3, taskViewState: { taskId: "t", stateRevision: 11 } as never }),
            undefined,
            { immediate: true },
        )

        expect(received.length).toBe(afterFirst + 1)
        cleanupStateSubscriptions(controller)
    })

    it("delivers again after a real change", async () => {
        const received = await attachSubscriber(controller, createState())
        await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })
        const afterFirst = received.length

        await sendStateUpdate(controller, createState({ stateRevision: 3, isNewUser: true }), undefined, { immediate: true })

        expect(received.length).toBe(afterFirst + 1)
        cleanupStateSubscriptions(controller)
    })

    it("replaces an intervening Task patch with the same home full and then resumes deduplication", async () => {
        const received = await attachSubscriber(controller, createState())
        await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })

        await sendStatePatch(controller, { stateRevision: 3, taskViewState: createTaskView() })
        expect(projectDeliveredState(received)?.taskViewState?.taskId).toBe("task-1")

        await sendStateUpdate(controller, createState({ stateRevision: 4 }), undefined, { immediate: true })
        expect(projectDeliveredState(received)).not.toHaveProperty("taskViewState")
        expect(projectDeliveredState(received)?.stateRevision).toBe(4)
        const afterRecovery = received.length

        await sendStateUpdate(controller, createState({ stateRevision: 5 }), undefined, { immediate: true })
        expect(received).toHaveLength(afterRecovery)
    })

    it("does not establish a full baseline from a revision rejected after a newer patch", async () => {
        const received = await attachSubscriber(controller, createState())
        await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })
        await sendStatePatch(controller, { stateRevision: 5, taskViewState: createTaskView() })

        await sendStateUpdate(controller, createState({ stateRevision: 4 }), undefined, { immediate: true })
        expect(projectDeliveredState(received)).toMatchObject({ stateRevision: 5, taskViewState: { taskId: "task-1" } })

        await sendStateUpdate(controller, createState({ stateRevision: 6 }), undefined, { immediate: true })
        expect(projectDeliveredState(received)).not.toHaveProperty("taskViewState")
        expect(projectDeliveredState(received)?.stateRevision).toBe(6)
    })

    it("lets a patch bypass a blocked full queue without letting a queued older full restore the baseline", async () => {
        const entered = createSignal()
        const release = createSignal()
        const received = await attachSubscriber(controller, createState(), async ({ stateJson }) => {
            if (JSON.parse(stateJson).stateRevision === 3) {
                entered.resolve()
                await release.promise
            }
        })
        await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })
        const blocked = sendStateUpdate(controller, createState({ stateRevision: 3, isNewUser: true }), undefined, {
            immediate: true,
        })
        await entered.promise
        const queued = sendStateUpdate(controller, createState({ stateRevision: 4 }), undefined, { immediate: true })
        try {
            await sendStatePatch(controller, { stateRevision: 5, taskViewState: createTaskView() })
            expect(projectDeliveredState(received)).toMatchObject({ stateRevision: 5, taskViewState: { taskId: "task-1" } })
        } finally {
            release.resolve()
            await Promise.all([blocked, queued])
        }
        expect(projectDeliveredState(received)?.stateRevision).toBe(5)

        await sendStateUpdate(controller, createState({ stateRevision: 6 }), undefined, { immediate: true })
        expect(projectDeliveredState(received)).not.toHaveProperty("taskViewState")
        expect(projectDeliveredState(received)?.isNewUser).toBe(false)
    })

    it("does not let an in-flight full completion undo the invalidation by a newer patch", async () => {
        const entered = createSignal()
        const release = createSignal()
        const received = await attachSubscriber(controller, createState(), async ({ stateJson }) => {
            if (JSON.parse(stateJson).stateRevision === 3) {
                entered.resolve()
                await release.promise
            }
        })
        await sendStateUpdate(controller, createState({ stateRevision: 2, taskViewState: createTaskView() }), undefined, {
            immediate: true,
        })
        const blocked = sendStateUpdate(controller, createState({ stateRevision: 3 }), undefined, { immediate: true })
        await entered.promise
        try {
            await sendStatePatch(controller, { stateRevision: 4, taskViewState: createTaskView() })
            expect(projectDeliveredState(received)?.taskViewState?.taskId).toBe("task-1")
        } finally {
            release.resolve()
            await blocked
        }

        await sendStateUpdate(controller, createState({ stateRevision: 5 }), undefined, { immediate: true })
        expect(projectDeliveredState(received)).not.toHaveProperty("taskViewState")
        expect(projectDeliveredState(received)?.stateRevision).toBe(5)
    })

    it("does not count an equality-skipped full revision as applied when a patch follows it", async () => {
        const received = await attachSubscriber(controller, createState())
        await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })
        const beforeSkipped = received.length
        await sendStateUpdate(controller, createState({ stateRevision: 4 }), undefined, { immediate: true })
        expect(received).toHaveLength(beforeSkipped)

        await sendStatePatch(controller, { stateRevision: 3, taskViewState: createTaskView() })
        expect(projectDeliveredState(received)).toMatchObject({ stateRevision: 3, taskViewState: { taskId: "task-1" } })
        await sendStateUpdate(controller, createState({ stateRevision: 5 }), undefined, { immediate: true })
        expect(projectDeliveredState(received)).not.toHaveProperty("taskViewState")
        expect(projectDeliveredState(received)?.stateRevision).toBe(5)
    })

    it("keeps deduplicating when an equal or older patch is rejected by the client revision fence", async () => {
        const received = await attachSubscriber(controller, createState())
        await sendStateUpdate(controller, createState({ stateRevision: 3 }), undefined, { immediate: true })
        await sendStatePatch(controller, { stateRevision: 3, taskViewState: createTaskView() })
        await sendStatePatch(controller, { stateRevision: 2, taskViewState: createTaskView() })
        const afterRejectedPatches = received.length

        await sendStateUpdate(controller, createState({ stateRevision: 4 }), undefined, { immediate: true })
        expect(received).toHaveLength(afterRejectedPatches)
        expect(projectDeliveredState(received)).not.toHaveProperty("taskViewState")
        expect(projectDeliveredState(received)?.stateRevision).toBe(3)
    })

    it("invalidates only the controller that delivered the patch", async () => {
        const other = createController()
        try {
            const received = await attachSubscriber(controller, createState())
            const otherReceived = await attachSubscriber(other, createState())
            await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })
            await sendStateUpdate(other, createState({ stateRevision: 2 }), undefined, { immediate: true })
            const beforeOther = otherReceived.length

            await sendStatePatch(controller, { stateRevision: 3, taskViewState: createTaskView() })
            await sendStateUpdate(other, createState({ stateRevision: 4 }), undefined, { immediate: true })
            expect(otherReceived).toHaveLength(beforeOther)
            expect(projectDeliveredState(otherReceived)).not.toHaveProperty("taskViewState")

            await sendStateUpdate(controller, createState({ stateRevision: 4 }), undefined, { immediate: true })
            expect(projectDeliveredState(received)).not.toHaveProperty("taskViewState")
            expect(projectDeliveredState(received)?.stateRevision).toBe(4)
        } finally {
            cleanupStateSubscriptions(other)
        }
    })

    it("forgets the baseline when the last subscription disconnects before reconnecting", async () => {
        const requestId = "equality-guard-reconnect"
        const received = await attachSubscriber(controller, createState(), undefined, requestId)
        await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })
        const beforeDisconnect = received.length
        expect(getRequestRegistry().cancelRequest(requestId)).toBe(true)
        const reattached = await attachSubscriber(controller, createState({ stateRevision: 10, isNewUser: true }))

        await sendStateUpdate(controller, createState({ stateRevision: 11 }), undefined, { immediate: true })
        expect(received).toHaveLength(beforeDisconnect)
        expect(projectDeliveredState(reattached)).toMatchObject({ stateRevision: 11, isNewUser: false })
        const afterRecovery = reattached.length
        await sendStateUpdate(controller, createState({ stateRevision: 12 }), undefined, { immediate: true })
        expect(reattached).toHaveLength(afterRecovery)
    })

    it("does not deliver queued fulls from a detached subscription lifetime to its replacement", async () => {
        const entered = createSignal()
        const release = createSignal()
        await attachSubscriber(controller, createState(), async ({ stateJson }) => {
            if (JSON.parse(stateJson).stateRevision === 2) {
                entered.resolve()
                await release.promise
            }
        })
        const blocked = sendStateUpdate(
            controller,
            createState({ stateRevision: 2, taskViewState: createTaskView() }),
            undefined,
            {
                immediate: true,
            },
        )
        await entered.promise
        const queued = sendStateUpdate(controller, createState({ stateRevision: 3 }), undefined, { immediate: true })
        cleanupStateSubscriptions(controller)
        let reattached: StreamedPayload[]
        try {
            reattached = await attachSubscriber(controller, createState({ stateRevision: 10, isNewUser: true }))
        } finally {
            release.resolve()
            await Promise.all([blocked, queued])
        }
        expect(reattached).toHaveLength(1)
        expect(projectDeliveredState(reattached)).toMatchObject({ stateRevision: 10, isNewUser: true })

        await sendStateUpdate(controller, createState({ stateRevision: 11 }), undefined, { immediate: true })
        expect(projectDeliveredState(reattached)).toMatchObject({ stateRevision: 11, isNewUser: false })
    })

    it("forgets the delivered payload once the controller detaches", async () => {
        const received = await attachSubscriber(controller, createState())
        await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })
        const afterFirst = received.length

        cleanupStateSubscriptions(controller)
        const reattached = await attachSubscriber(controller, createState())
        await sendStateUpdate(controller, createState({ stateRevision: 2 }), undefined, { immediate: true })

        expect(received.length).toBe(afterFirst)
        expect(reattached).toHaveLength(2)
        expect(projectDeliveredState(reattached)?.stateRevision).toBe(2)
        cleanupStateSubscriptions(controller)
    })
})
