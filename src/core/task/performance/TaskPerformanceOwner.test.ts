import { openGlobalMetricsRuntime, resetGlobalMetricsRuntimeForTests } from "@core/metrics/GlobalMetricsRuntime"
import type { MetricsEvent } from "@shared/metrics/events"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TaskState } from "../kernel"
import { ApiRequestRoundLifecycle } from "./api-request-round-lifecycle"
import { API_REQUEST_ROUND_SCHEMA_VERSION, type ApiRequestRoundRecord } from "./api-request-round-types"
import { type TaskMetricsAttachment, TaskMetricsEmitter } from "./metrics-emitter"
import type { ProviderRequestRoundAdmission } from "./provider-request-round-port"
import { TaskMetricsEmission, TaskPerformanceOwner } from "./TaskPerformanceOwner"
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

    it("starts a new auxiliary admission for attempt zero instead of reviving a stale semantic request", async () => {
        stubPersistence()
        const admissions = [
            {
                createAttemptObserver: vi.fn(() => ({ beginAttempt: () => undefined, finishAttempt: () => undefined })),
                attachExactUsage: vi.fn(),
                completeProviderOnly: vi.fn(),
                completeTools: vi.fn(),
                completeTurnEndAwaitingUser: vi.fn(),
            },
            {
                createAttemptObserver: vi.fn(() => ({ beginAttempt: () => undefined, finishAttempt: () => undefined })),
                attachExactUsage: vi.fn(),
                completeProviderOnly: vi.fn(),
                completeTools: vi.fn(),
                completeTurnEndAwaitingUser: vi.fn(),
            },
        ] satisfies ProviderRequestRoundAdmission[]
        const admit = vi
            .spyOn(TaskProviderRequestRoundOwner.prototype, "admit")
            .mockReturnValueOnce(admissions[0])
            .mockReturnValueOnce(admissions[1])
        const owner = await TaskPerformanceOwner.open({
            taskId: "task-1",
            readState: () => committedIn("idle"),
            legacyMessages: () => [],
        })

        owner.providerAttemptObserver({ role: "subagent", logicalRequestId: "subagent:1", taskAttempt: 0 })
        owner.providerAttemptObserver({ role: "subagent", logicalRequestId: "subagent:1", taskAttempt: 1 })
        owner.providerAttemptObserver({ role: "subagent", logicalRequestId: "subagent:1", taskAttempt: 0 })
        await owner.release()

        expect(admit).toHaveBeenCalledTimes(2)
        expect(admissions[0].createAttemptObserver).toHaveBeenCalledTimes(2)
        expect(admissions[1].createAttemptObserver).toHaveBeenCalledTimes(1)
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

describe("TaskMetricsEmission", () => {
    function emitterInto(events: MetricsEvent[]): TaskMetricsEmitter {
        return new TaskMetricsEmitter(
            { workspaceId: "ws", taskId: "task-1", profileId: "profile-a", providerId: "openai", modelId: "gpt-5" },
            {
                offer: (event) => {
                    events.push(event)
                    return true
                },
            },
        )
    }

    function attachmentOf(emitter: TaskMetricsEmitter): TaskMetricsAttachment {
        return { emitter, start: () => undefined, release: async () => ({ released: true }) }
    }

    function round(overrides: Partial<ApiRequestRoundRecord> = {}): ApiRequestRoundRecord {
        return {
            schemaVersion: API_REQUEST_ROUND_SCHEMA_VERSION,
            taskId: "task-1",
            roundId: "task-1:turn-a:provider:0",
            revision: 1,
            logicalRequestId: "turn-a",
            apiIndex: 0,
            taskAttempt: 0,
            providerAttempt: 0,
            startedAtMs: 1_000,
            completedAtMs: 1_700,
            providerDurationMs: 700,
            status: "completed",
            inputTokens: 900,
            outputTokens: 100,
            thoughtsTokens: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            cacheUsageReported: true,
            totalCost: 0.25,
            currency: "USD",
            usageQuality: "exact",
            ...overrides,
        }
    }

    // The unified numbers must describe the send the round recorded. Emitting from a
    // second measurement would let the two disagree, so the assertion is on the exact
    // values the round already settled.
    it("re-expresses the settled round instead of measuring it again", () => {
        const events: MetricsEvent[] = []
        const emission = new TaskMetricsEmission(attachmentOf(emitterInto(events)), "task-1")
        const settled = round()

        emission.usage(settled)
        emission.provider(settled)

        expect(events.map((event) => event.kind)).toEqual(["usage", "performance"])
        expect(events[0]).toMatchObject({
            eventId: "usage:task-1:turn-a:provider:0",
            observedAtMs: 1_700,
            roundId: "task-1:turn-a:provider:0",
            inputTokens: 900,
            outputTokens: 100,
            usageReported: true,
            cost: 0.25,
            currency: "USD",
            costComplete: true,
            usageQuality: "exact",
        })
        // A provider fact carries its own duration; the execution fact owns RPM.
        expect(events[1]).toMatchObject({
            eventId: "provider:task-1:turn-a:provider:0",
            factKind: "provider",
            providerDurationMs: 700,
            status: "completed",
        })
        expect(events[1]).not.toHaveProperty("executionDurationMs")
    })

    // A retried revision of the same round is the same fact. Re-emitting would make
    // the receiver's idempotency the only thing standing between a retry and a
    // double count, which is a weaker guarantee than not emitting twice.
    it("emits one fact per round even when the round is reported again", () => {
        const events: MetricsEvent[] = []
        const emission = new TaskMetricsEmission(attachmentOf(emitterInto(events)), "task-1")

        emission.usage(round())
        emission.usage(round({ revision: 2 }))
        emission.provider(round())
        emission.provider(round({ revision: 2 }))

        expect(events).toHaveLength(2)
    })

    // A send that reported no usage has no usage fact at all. Emitting zero tokens
    // would turn "the Provider told us nothing" into "it told us zero".
    it("emits no usage fact for a round that reported no usage", () => {
        const events: MetricsEvent[] = []
        const emission = new TaskMetricsEmission(attachmentOf(emitterInto(events)), "task-1")

        emission.usage(round({ usageQuality: "none", inputTokens: undefined, outputTokens: undefined }))

        expect(events).toHaveLength(0)
    })

    // One settlement feeds both levels. The global row must be the *same* fact, so a
    // retry is deduplicated by the same receipt identity instead of counting twice, and
    // the Task's own row must still be offered even when no global runtime is open.
    it("offers each settled fact to the global level with the same identity", () => {
        const taskEvents: MetricsEvent[] = []
        const globalEvents: MetricsEvent[] = []
        const runtime = openGlobalMetricsRuntime({ workerPath: "unused-worker.js" })
        const collect = vi.spyOn(runtime.sink, "offer").mockImplementation((event) => {
            globalEvents.push(event)
            return true
        })
        try {
            const emission = new TaskMetricsEmission(attachmentOf(emitterInto(taskEvents)), "task-1")
            const settled = round()

            emission.usage(settled)
            emission.provider(settled)

            expect(taskEvents.map((event) => event.eventId)).toEqual([
                "usage:task-1:turn-a:provider:0",
                "provider:task-1:turn-a:provider:0",
            ])
            expect(globalEvents).toEqual(taskEvents)
        } finally {
            collect.mockRestore()
            resetGlobalMetricsRuntimeForTests()
        }
    })

    // A caller that redirects one observation to another sink keeps that fact local on
    // purpose: the redirect is the whole point, so the global level must not also see it.
    // The redirect belongs to the emitter, which owns event construction.
    it("does not offer a redirected observation to the global level", () => {
        const redirected: MetricsEvent[] = []
        const globalSeen: MetricsEvent[] = []
        const runtime = openGlobalMetricsRuntime({ workerPath: "unused-worker.js" })
        const collect = vi.spyOn(runtime.sink, "offer").mockImplementation((event) => {
            globalSeen.push(event)
            return true
        })
        try {
            const emitter = new TaskMetricsEmitter(
                { workspaceId: "ws", taskId: "task-1", profileId: "p", providerId: "openai", modelId: "gpt-5" },
                undefined,
            )

            emitter.emitUsage(
                {
                    eventId: "usage:redirected",
                    observedAtMs: 1_700,
                    roundId: "round",
                    logicalRequestId: "turn-a",
                    sequence: 1,
                    inputTokens: 10,
                    outputTokens: 2,
                    usageReported: true,
                    costComplete: false,
                    currencyMixed: false,
                    usageQuality: "exact",
                },
                {
                    sink: {
                        offer: (event) => {
                            redirected.push(event)
                            return true
                        },
                    },
                },
            )

            expect(redirected).toHaveLength(1)
            expect(globalSeen).toHaveLength(0)
        } finally {
            collect.mockRestore()
            resetGlobalMetricsRuntimeForTests()
        }
    })
})
