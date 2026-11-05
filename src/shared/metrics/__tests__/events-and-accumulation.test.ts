import { describe, expect, it } from "vitest"
import { bucketStartOf, coarserResolution, isClosedBucket, RESOLUTION_MS } from "../bucket"
import type { PerformanceEvent, UsageEvent } from "../events"
import {
    executionPerformanceEventId,
    idempotencyKey,
    providerPerformanceEventId,
    usageEventId,
    usageKeyFingerprint,
} from "../identity"
import { accumulatePerformance, accumulateUsage, emptyPerformanceRowBody, emptyUsageRow } from "../merge"

const identity = {
    observedAtMs: Date.UTC(2026, 10, 4, 10, 23, 45),
    sequence: 1,
    workspaceId: "workspace-a",
    taskId: "task-a",
    profileId: "profile-a",
    providerId: "anthropic",
    modelId: "model-a",
    keyFingerprint: "fingerprint-a",
    logicalRequestId: "logical-a",
    roundId: "round-a",
}

function usage(overrides: Partial<UsageEvent> = {}): UsageEvent {
    return {
        ...identity,
        eventId: usageEventId("round-a"),
        kind: "usage",
        inputTokens: 1000,
        outputTokens: 100,
        thoughtsTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 900,
        usageReported: true,
        costComplete: true,
        currencyMixed: false,
        usageQuality: "exact",
        ...overrides,
    }
}

function performance(overrides: Partial<PerformanceEvent> = {}): PerformanceEvent {
    return {
        ...identity,
        eventId: providerPerformanceEventId("round-a"),
        kind: "performance",
        factKind: "provider",
        providerDurationMs: 2000,
        status: "completed",
        perfQuality: "exact",
        ...overrides,
    }
}

describe("usage accumulation", () => {
    it("keeps fresh input separate from cache segments and builds the cache denominator from all three", () => {
        const row = accumulateUsage(emptyUsageRow(), usage({ inputTokens: 1000, cacheWriteTokens: 200, cacheReadTokens: 800 }))

        expect(row.inputTokens).toBe(1000)
        expect(row.cacheNumerator).toBe(800)
        expect(row.cacheDenominator).toBe(2000)
    })

    it("does not count a missing cache segment as reported cache usage", () => {
        const row = accumulateUsage(
            emptyUsageRow(),
            usage({ cacheWriteTokens: undefined, cacheReadTokens: undefined, usageReported: true }),
        )

        expect(row.cacheUsageAvailable).toBe(false)
        expect(row.cacheDenominator).toBe(0)
    })

    it("does not treat a request with no reported usage as a zero-token request", () => {
        const row = accumulateUsage(emptyUsageRow(), usage({ usageReported: false, inputTokens: 0, outputTokens: 0 }))

        expect(row.usageAvailable).toBe(false)
        expect(row.respondingRequests).toBe(0)
        expect(row.usageQuality).toBe("none")
    })

    it("keeps an explicit zero cost as a complete zero", () => {
        const row = accumulateUsage(emptyUsageRow(), usage({ cost: 0, currency: "USD", costComplete: true }))

        expect(row.cost).toBe(0)
        expect(row.currency).toBe("USD")
        expect(row.costAvailable).toBe(true)
    })

    it("never sums different currencies into the last one", () => {
        const first = accumulateUsage(emptyUsageRow(), usage({ cost: 1, currency: "USD" }))
        const second = accumulateUsage(first, usage({ roundId: "round-b", cost: 2, currency: "CNY" }))

        expect(second.cost).toBeUndefined()
        expect(second.currency).toBeUndefined()
        expect(second.currencyMixed).toBe(true)
        expect(second.costAvailable).toBe(false)
    })

    it("preserves a source-confirmed mixed event instead of degrading it to unknown", () => {
        const row = accumulateUsage(emptyUsageRow(), usage({ cost: undefined, currencyMixed: true }))

        expect(row.currencyMixed).toBe(true)
        expect(row.costAvailable).toBe(false)
    })

    it("refuses to present a known subtotal as the complete total", () => {
        const complete = accumulateUsage(emptyUsageRow(), usage({ cost: 1, currency: "USD", costComplete: true }))
        const partial = accumulateUsage(complete, usage({ roundId: "round-b", cost: 2, currency: "USD", costComplete: false }))

        expect(partial.cost).toBe(3)
        expect(partial.costAvailable).toBe(false)
    })

    it("keeps the bucket total unknown once an event contributes no cost", () => {
        const complete = accumulateUsage(emptyUsageRow(), usage({ cost: 1, currency: "USD" }))
        const unknown = accumulateUsage(complete, usage({ roundId: "round-b", cost: undefined }))

        expect(unknown.cost).toBeUndefined()
        expect(unknown.costAvailable).toBe(false)
    })
})

describe("performance accumulation", () => {
    it("counts provider rounds and executions in separate counters", () => {
        const afterProvider = accumulatePerformance(emptyPerformanceRowBody(), performance())
        const afterExecution = accumulatePerformance(
            afterProvider,
            performance({
                factKind: "execution",
                executionId: "exec-a",
                eventId: executionPerformanceEventId("exec-a"),
                executionDurationMs: 3000,
            }),
        )

        expect(afterExecution.providerRoundCount).toBe(1)
        expect(afterExecution.executionCount).toBe(1)
        expect(afterExecution.requestCount).toBe(2)
        expect(afterExecution.executionDurationMs).toBe(3000)
    })

    it("counts a duration only when the fact recorded one", () => {
        const row = accumulatePerformance(emptyPerformanceRowBody(), performance({ providerDurationMs: undefined }))

        expect(row.durationCoverage).toBe(0)
        expect(row.requestCount).toBe(1)
    })
})

describe("bucketing", () => {
    it("floors an observation into the bucket that owns it", () => {
        const observedAt = Date.UTC(2026, 10, 4, 10, 23, 45)
        const minute = bucketStartOf(observedAt, "minute")

        expect(minute).toBe(Date.UTC(2026, 10, 4, 10, 23, 0))
        expect(bucketStartOf(minute + RESOLUTION_MS.minute - 1, "minute")).toBe(minute)
        expect(bucketStartOf(minute + RESOLUTION_MS.minute, "minute")).not.toBe(minute)
    })

    it("distinguishes resolutions so a minute start is not an hour start", () => {
        const observedAt = Date.UTC(2026, 10, 4, 10, 23, 45)

        expect(bucketStartOf(observedAt, "hour")).toBe(Date.UTC(2026, 10, 4, 10, 0, 0))
        expect(bucketStartOf(observedAt, "day")).toBe(Date.UTC(2026, 10, 4, 0, 0, 0))
    })

    it("treats only fully elapsed buckets as closed", () => {
        const start = Date.UTC(2026, 10, 4, 10, 23, 0)

        expect(isClosedBucket(start, "minute", start + RESOLUTION_MS.minute - 1)).toBe(false)
        expect(isClosedBucket(start, "minute", start + RESOLUTION_MS.minute)).toBe(true)
    })

    it("walks minute to hour to day and stops at the coarsest", () => {
        expect(coarserResolution("minute")).toBe("hour")
        expect(coarserResolution("hour")).toBe("day")
        expect(coarserResolution("day")).toBeUndefined()
    })
})

describe("identities", () => {
    it("derives distinct ids for the same round's usage, provider and execution facts", () => {
        const ids = [usageEventId("round-a"), providerPerformanceEventId("round-a"), executionPerformanceEventId("exec-a")]

        expect(new Set(ids).size).toBe(3)
        expect(ids[0]).toBe("usage:round-a")
        expect(ids[1]).toBe("provider:round-a")
        expect(ids[2]).toBe("execution:exec-a")
    })

    it("is stable across repeated construction, so a retried batch deduplicates", () => {
        expect(usageEventId("round-a")).toBe(usageEventId("round-a"))
        expect(idempotencyKey("task-a", "usage:round-a")).toBe(idempotencyKey("task-a", "usage:round-a"))
    })

    it("keeps the task in the idempotency key so two tasks cannot collide", () => {
        expect(idempotencyKey("task-a", "usage:round-a")).not.toBe(idempotencyKey("task-b", "usage:round-a"))
    })

    it("rejects an empty identity instead of minting an ambiguous id", () => {
        expect(() => usageEventId("")).toThrow()
    })

    it("separates 'no key' from a fingerprint of an empty string", () => {
        expect(usageKeyFingerprint(undefined)).toBe("")
        expect(usageKeyFingerprint(null)).toBe("")
        expect(usageKeyFingerprint("")).toBe("")
        expect(usageKeyFingerprint("key-a")).not.toBe("")
    })

    it("gives different keys different fingerprints", () => {
        expect(usageKeyFingerprint("key-a")).not.toBe(usageKeyFingerprint("key-b"))
    })

    it("never returns the key itself", () => {
        const fingerprint = usageKeyFingerprint("secret-key-material")

        expect(fingerprint.length).toBe(16)
        expect(fingerprint).not.toContain("secret")
    })
})
