import { afterEach, describe, expect, it, vi } from "vitest"
import type { TaskState } from "../kernel"
import { ApiRequestRoundLifecycle } from "./api-request-round-lifecycle"
import type { ProviderRequestRoundAdmission } from "./provider-request-round-port"
import { TaskPerformanceOwner } from "./TaskPerformanceOwner"
import { TaskProviderRequestRoundOwner } from "./TaskProviderRequestRoundOwner"
import { TaskApiRateMetricsService } from "./task-api-rate-metrics-service"

function committedIn(phase: TaskState["flow"]["phase"], turnId = "turn-1"): TaskState {
    return {
        flow: { phase },
        turn: { turnId, blocks: [] },
        dialog: { approvalsByBlock: {} },
        halt: { status: "idle" },
    } as unknown as TaskState
}

function stubPersistence(): void {
    vi.spyOn(TaskApiRateMetricsService.prototype, "initialize").mockResolvedValue(undefined)
    vi.spyOn(TaskApiRateMetricsService.prototype, "dispose").mockResolvedValue(undefined)
    vi.spyOn(ApiRequestRoundLifecycle.prototype, "initialize").mockResolvedValue(undefined)
    vi.spyOn(ApiRequestRoundLifecycle.prototype, "close").mockResolvedValue(undefined)
}

describe("TaskPerformanceOwner", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    // Dev only accrued active seconds while its task loop ran, so a task that
    // waits on the user or comes to rest stops adding to its rates.
    it("follows the committed task loop for active-time accrual", async () => {
        stubPersistence()
        const loop = vi.spyOn(TaskApiRateMetricsService.prototype, "setTaskLoopActive")
        const owner = await TaskPerformanceOwner.open({
            taskId: "task-1",
            readState: () => committedIn("idle"),
            legacyMessages: () => [],
        })

        for (const phase of ["initializing", "running", "waiting", "running", "completed", "paused"] as const) {
            owner.committed(committedIn(phase))
        }
        await owner.release()

        expect(loop.mock.calls.map(([active]) => active)).toEqual([true, true, false, true, false, false])
    })

    // The header's RPM is the rate of logical requests: a turn's retries are one
    // request, and the request counts once the turn stops running.
    it("samples the current Usage policy generation for every real Provider send", async () => {
        stubPersistence()
        const observedGenerations: Array<number | undefined> = []
        vi.spyOn(ApiRequestRoundLifecycle.prototype, "createObserver").mockImplementation((input) => {
            observedGenerations.push(input.policyGeneration)
            return {
                beginAttempt: () => {
                    throw new Error("test stream is not consumed")
                },
                finishAttempt: () => undefined,
            }
        })
        let generation: number | undefined = 7
        const owner = await TaskPerformanceOwner.open({
            taskId: "task-1",
            readState: () => committedIn("idle"),
            legacyMessages: () => [],
            readUsagePolicyGeneration: () => generation,
        })

        owner.providerAttemptObserver({ role: "task", logicalRequestId: "turn-a", taskAttempt: 0 })
        generation = 8
        owner.providerAttemptObserver({ role: "task", logicalRequestId: "turn-a", taskAttempt: 1 })
        generation = undefined
        owner.providerAttemptObserver({ role: "task", logicalRequestId: "turn-b", taskAttempt: 0 })
        await owner.release()

        expect(observedGenerations).toEqual([7, 8, undefined])
    })

    it("derives logical execution and awaiting-user tool terminals from committed kernel state", async () => {
        stubPersistence()
        const admission: ProviderRequestRoundAdmission = {
            createAttemptObserver: () => ({ beginAttempt: () => undefined, finishAttempt: () => undefined }),
            attachExactUsage: () => undefined,
            completeProviderOnly: () => undefined,
            completeTools: () => undefined,
            completeTurnEndAwaitingUser: () => undefined,
        }
        vi.spyOn(TaskProviderRequestRoundOwner.prototype, "admitOrdinary").mockReturnValue(admission)
        vi.spyOn(TaskProviderRequestRoundOwner.prototype, "getOrdinary").mockReturnValue(admission)
        const register = vi.spyOn(TaskProviderRequestRoundOwner.prototype, "registerExecution").mockReturnValue(undefined)
        const awaiting = vi.spyOn(TaskProviderRequestRoundOwner.prototype, "completeAtAwaitingUser").mockReturnValue(undefined)
        const complete = vi.spyOn(TaskProviderRequestRoundOwner.prototype, "completeTurn").mockReturnValue(undefined)
        const owner = await TaskPerformanceOwner.open({
            taskId: "task-1",
            readState: () => committedIn("idle"),
            legacyMessages: () => [],
        })
        owner.providerAttemptObserver({ role: "task", logicalRequestId: "turn-tools", taskAttempt: 0 })
        const state = {
            flow: { phase: "waiting" },
            turn: {
                turnId: "turn-tools",
                blocks: [
                    { blockId: "read", phase: "completed", turnEnding: false, invocationRef: "invocation:read" },
                    { blockId: "ask", phase: "executing", turnEnding: true, invocationRef: "invocation:ask" },
                ],
            },
            dialog: {
                primary: { interactionId: "ask", turnId: "turn-tools", status: "awaiting" },
                approvalsByBlock: {},
            },
            halt: { status: "idle" },
        } as unknown as TaskState

        owner.committed(state)
        owner.committed(state)
        await owner.release()

        expect(register).toHaveBeenCalledOnce()
        expect(register).toHaveBeenCalledWith(admission, {
            turnId: "turn-tools",
            toolCount: 2,
            turnEndInteractions: [{ interactionId: "ask", blockId: "ask" }],
        })
        expect(awaiting).toHaveBeenCalledOnce()
        expect(awaiting).toHaveBeenCalledWith("turn-tools", "ask")
        expect(complete).toHaveBeenCalledOnce()
    })

    it("admits one logical round per turn and completes it when the turn stops running", async () => {
        stubPersistence()
        const observedAttempts: Array<[number, { provider: string } | undefined]> = []
        const admission: ProviderRequestRoundAdmission = {
            createAttemptObserver: (attempt: number, adapter?: { provider: string }) => {
                observedAttempts.push([attempt, adapter])
                return { beginAttempt: () => undefined, finishAttempt: () => undefined }
            },
            attachExactUsage: () => undefined,
            completeProviderOnly: () => undefined,
            completeTools: () => undefined,
            completeTurnEndAwaitingUser: () => undefined,
        }
        const admit = vi.spyOn(TaskProviderRequestRoundOwner.prototype, "admitOrdinary").mockReturnValue(admission)
        vi.spyOn(TaskProviderRequestRoundOwner.prototype, "getOrdinary").mockReturnValue(admission)
        const complete = vi.spyOn(TaskProviderRequestRoundOwner.prototype, "completeTurn").mockReturnValue(undefined)
        const usage = vi.spyOn(TaskProviderRequestRoundOwner.prototype, "attachOrdinaryExactUsage").mockReturnValue(undefined)
        const rateUsage = vi.spyOn(TaskApiRateMetricsService.prototype, "recordExactUsage").mockReturnValue(undefined)
        const owner = await TaskPerformanceOwner.open({
            taskId: "task-1",
            readState: () => committedIn("idle"),
            legacyMessages: () => [],
        })

        owner.providerAttemptObserver({
            role: "task",
            logicalRequestId: "turn-a",
            taskAttempt: 0,
            adapter: { provider: "openai" },
        })
        owner.providerAttemptObserver({
            role: "task",
            logicalRequestId: "turn-a",
            taskAttempt: 1,
            adapter: { provider: "anthropic" },
        })
        owner.requestSettled({ inputTokens: 10, outputTokens: 2 })
        owner.committed(committedIn("running", "turn-a"))
        expect(complete).not.toHaveBeenCalled()

        owner.committed(committedIn("waiting", "turn-a"))
        owner.committed(committedIn("waiting", "turn-a"))
        // A later request streams before the state names its turn, and stays open.
        owner.providerAttemptObserver({ role: "task", logicalRequestId: "turn-b", taskAttempt: 0 })
        owner.committed(committedIn("running", "turn-a"))
        expect(complete).toHaveBeenCalledTimes(1)
        // A completion offered to the user ends the run while the flow stays open.
        owner.committed(committedIn("running", "turn-b"), true)
        await owner.release()

        expect(admit.mock.calls).toEqual([
            [0, 0],
            [0, 1],
            [1, 0],
        ])
        expect(observedAttempts).toEqual([
            [0, { provider: "openai" }],
            [1, { provider: "anthropic" }],
            [0, undefined],
        ])
        expect(complete).toHaveBeenCalledTimes(2)
        expect(usage).not.toHaveBeenCalled()
        // TPM is a generation rate: the prompt read before streaming must not count toward it.
        expect(rateUsage.mock.calls).toEqual([[{ outputTokens: 2 }]])
    })
})
