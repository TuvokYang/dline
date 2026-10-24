import { describe, expect, it } from "vitest"
import type { ApiRequestRoundHandle } from "@/core/task/performance/api-request-round-tracker"
import type { ApiRequestRoundRecord } from "@/core/task/performance/api-request-round-types"
import type { ApiResponseExecutionRecord } from "@/core/task/performance/api-response-execution-types"
import { validateTaskAttempts } from "../../contracts/usageExecution"
import {
    createAttemptAccumulator,
    isEmptyAttempts,
    mergeAttempts,
    observeAttempt,
    projectFinalizedAttempt,
    sealAttempts,
} from "../attemptProjection"

function handle(overrides: Partial<ApiRequestRoundHandle> = {}): ApiRequestRoundHandle {
    return {
        roundId: "task-a:request-a:provider:0",
        logicalRequestId: "request-a",
        apiIndex: 1,
        taskAttempt: 0,
        providerAttempt: 0,
        role: "reviewer",
        provider: "anthropic",
        modelId: "catalog:claude-opus-4-1",
        thinking: "level:high",
        policyGeneration: 12,
        startedAtMs: 1_000,
        startedMonotonicMs: 10,
        ...overrides,
    }
}

function execution(overrides: Partial<ApiResponseExecutionRecord> = {}): ApiResponseExecutionRecord {
    return {
        schemaVersion: 1,
        taskId: "task-a",
        executionId: "task-a:request-a:provider:0",
        revision: 0,
        roundId: "task-a:request-a:provider:0",
        logicalRequestId: "request-a",
        apiIndex: 1,
        taskAttempt: 0,
        providerAttempt: 0,
        startedAtMs: 1_000,
        providerCompletedAtMs: 2_200,
        completedAtMs: 4_000,
        providerDurationMs: 1_200,
        executionDurationMs: 3_000,
        status: "completed",
        terminalKind: "provider_only",
        toolCount: 0,
        completedToolCount: 0,
        failedToolCount: 0,
        cancelledToolCount: 0,
        ...overrides,
    }
}

function record(overrides: Partial<ApiRequestRoundRecord> = {}): ApiRequestRoundRecord {
    return {
        schemaVersion: 1,
        taskId: "task-a",
        roundId: "task-a:request-a:provider:0",
        revision: 1,
        logicalRequestId: "request-a",
        apiIndex: 1,
        taskAttempt: 0,
        providerAttempt: 0,
        startedAtMs: 1_000,
        completedAtMs: 2_200,
        providerDurationMs: 1_200,
        status: "completed",
        inputTokens: 400,
        outputTokens: 80,
        thoughtsTokens: 20,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        cacheUsageReported: true,
        usageQuality: "exact",
        ...overrides,
    }
}

describe("finalized attempt projection", () => {
    it("projects the frozen joint identity and exact token coverage from one handle revision", () => {
        expect(projectFinalizedAttempt(handle(), record())).toEqual({
            attemptObservationId: "task-a:request-a:provider:0",
            logicalRequestId: "request-a",
            identity: {
                role: "reviewer",
                provider: "anthropic",
                modelId: "catalog:claude-opus-4-1",
                thinking: "level:high",
            },
            policyGeneration: 12,
            admittedAt: 1_000,
            outcome: "completed",
            durationMs: 1_200,
            tokens: { input: 400, output: 80, cacheRead: 0, cacheWrite: 0, reasoning: 20 },
            tokenUsageReported: true,
        })
    })

    it("fails closed when a compatibility handle has no complete schema 4 identity", () => {
        expect(() => projectFinalizedAttempt(handle({ provider: undefined }), record())).toThrow(/identity/i)
    })

    it("never exposes an unclassified final wire model and accepts the frozen disabled thinking state", () => {
        const privateWireModel = "tenant/private-finetune-42"
        const observation = projectFinalizedAttempt(handle({ modelId: privateWireModel, thinking: "state:disabled" }), record())

        expect(observation.identity).toMatchObject({ modelId: "state:unknown", thinking: "state:disabled" })
        expect(JSON.stringify(observation)).not.toContain(privateWireModel)
    })

    it("keeps an unreported attempt in request and duration math without claiming real zero tokens", () => {
        expect(
            projectFinalizedAttempt(handle(), record({ revision: 0, usageQuality: "none", inputTokens: undefined })),
        ).toMatchObject({
            tokenUsageReported: false,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        })
    })

    it("projects tool settlement and task-attempt count only from the attached final logical execution", () => {
        const observation = projectFinalizedAttempt(
            handle({ taskAttempt: 2 }),
            record({ taskAttempt: 2 }),
            execution({
                taskAttempt: 2,
                terminalKind: "tools_settled",
                executionDurationMs: 3_000,
                toolCount: 3,
                completedToolCount: 1,
                failedToolCount: 1,
                cancelledToolCount: 1,
                status: "failed",
            }),
            [
                { outcome: "completed", toolName: "read_file" },
                { outcome: "failed", toolName: "execute_command" },
                { outcome: "cancelled" },
            ],
        )

        expect(observation.logicalExecution).toEqual({
            logicalRequests: { completed: 0, failed: 1, cancelled: 0, aborted: 0 },
            turnDurationMs: { count: 1, sum: 3_000, min: 3_000, max: 3_000 },
            tools: {
                completed: 1,
                failed: 1,
                cancelled: 1,
                by_name: {
                    execute_command: { completed: 0, failed: 1, cancelled: 0 },
                    read_file: { completed: 1, failed: 0, cancelled: 0 },
                },
                unlisted: { completed: 0, failed: 0, cancelled: 1 },
            },
            taskAttempts: { count: 1, sum: 3, min: 3, max: 3 },
        })
    })

    it("rejects a named-tool breakdown that disagrees with the persisted execution totals", () => {
        expect(() =>
            projectFinalizedAttempt(
                handle(),
                record(),
                execution({
                    terminalKind: "tools_settled",
                    toolCount: 1,
                    completedToolCount: 1,
                }),
                [{ outcome: "failed", toolName: "read_file" }],
            ),
        ).toThrow(/named tool outcomes/i)
    })

    it.each([
        "completed",
        "failed",
        "cancelled",
        "aborted",
    ] as const)("preserves a provider-only %s logical terminal without inventing tool rows", (status) => {
        const observation = projectFinalizedAttempt(handle(), record({ status }), execution({ status }))

        expect(observation.logicalExecution?.logicalRequests).toEqual({
            completed: status === "completed" ? 1 : 0,
            failed: status === "failed" ? 1 : 0,
            cancelled: status === "cancelled" ? 1 : 0,
            aborted: status === "aborted" ? 1 : 0,
        })
        expect(observation.logicalExecution?.tools).toBeUndefined()
    })

    it("attaches session starts only to a final result-producing attempt", () => {
        expect(projectFinalizedAttempt(handle(), record(), execution(), undefined, 2)).toMatchObject({ sessionsStarted: 2 })
        expect(() => projectFinalizedAttempt(handle(), record(), undefined, undefined, 1)).toThrow(/session starts/i)
    })

    it("rejects a logical execution belonging to another attempt handle", () => {
        expect(() => projectFinalizedAttempt(handle(), record(), execution({ roundId: "other", executionId: "other" }))).toThrow(
            /does not match/i,
        )
    })
})

describe("attempt distribution", () => {
    it("samples taskAttempt plus one so a first-try request counts one attempt", () => {
        const accumulator = createAttemptAccumulator()
        observeAttempt(accumulator, 0)
        observeAttempt(accumulator, 2)

        expect(sealAttempts(accumulator, 2)).toEqual({ count: 2, sum: 4, min: 1, max: 3 })
    })

    it("rejects an attempts sample that cannot describe a request", () => {
        const accumulator = createAttemptAccumulator()

        expect(() => observeAttempt(accumulator, -1)).toThrow()
        expect(() => observeAttempt(accumulator, 1.5)).toThrow()
    })

    it("refuses to seal a distribution that disagrees with the fact request total", () => {
        const accumulator = createAttemptAccumulator()
        observeAttempt(accumulator, 0)

        expect(() => sealAttempts(accumulator, 2)).toThrow()
    })

    it("produces a distribution the wire validator accepts", () => {
        const accumulator = createAttemptAccumulator()
        for (const attempt of [0, 0, 1, 3]) observeAttempt(accumulator, attempt)

        const sealed = sealAttempts(accumulator, 4)

        expect(sealed).toEqual({ count: 4, sum: 8, min: 1, max: 4 })
        expect(validateTaskAttempts(sealed)).toEqual([])
    })

    it("stays empty when no logical request settled", () => {
        const accumulator = createAttemptAccumulator()

        expect(isEmptyAttempts(accumulator)).toBe(true)
        expect(sealAttempts(accumulator, 0)).toEqual({ count: 0, sum: 0, min: 0, max: 0 })
    })

    it("merges two minutes without losing the extremes", () => {
        const first = createAttemptAccumulator()
        observeAttempt(first, 0)
        observeAttempt(first, 4)
        const second = createAttemptAccumulator()
        observeAttempt(second, 2)

        const merged = mergeAttempts(first, second)

        expect(merged).toEqual({ count: 3, sum: 1 + 5 + 3, min: 1, max: 5 })
        expect(validateTaskAttempts(merged)).toEqual([])
    })
})
