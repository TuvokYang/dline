import { describe, expect, it } from "vitest"
import type { UsageSettlement } from "@/core/task/telemetry/UsageSettlement"
import {
    mergeUsageTallies,
    projectUsageSettlement,
    type UsageFactTally,
    type UsageTally,
    UsageTallyReductionError,
} from "../usageTally"

function settlement(overrides: Partial<UsageSettlement> = {}): UsageSettlement {
    return {
        observationId: "obs-1",
        purpose: "task",
        outcome: "completed",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 100,
        servedBy: { provider: "anthropic", model: "claude" },
        ...overrides,
    }
}

function fact(overrides: Partial<UsageFactTally> = {}): UsageFactTally {
    return {
        role: "task",
        provider: "anthropic",
        model: "claude",
        custom: false,
        requests: { completed: 1, cancelled: 0, failed: 0 },
        tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
        duration_ms: { count: 1, sum: 1, min: 1, max: 1, buckets: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
        errors: {},
        retries: 0,
        ...overrides,
    }
}

function tally(...facts: UsageFactTally[]): UsageTally {
    return { sessions_started: 0, facts }
}

describe("checked Usage tally reduction", () => {
    it("rejects an unsafe source count instead of projecting it as zero", () => {
        expect(() => projectUsageSettlement(settlement({ inputTokens: Number.MAX_SAFE_INTEGER + 1 }))).toThrowError(
            expect.objectContaining<Partial<UsageTallyReductionError>>({ code: "invalid_integer", path: "tokens.input" }),
        )
    })

    it("rejects aggregate overflow instead of saturating", () => {
        expect(() =>
            mergeUsageTallies({ sessions_started: Number.MAX_SAFE_INTEGER, facts: [] }, { sessions_started: 1, facts: [] }),
        ).toThrowError(expect.objectContaining<Partial<UsageTallyReductionError>>({ code: "integer_overflow" }))
    })

    it("adds distinct TODO declaration deltas without invalidating their completions", () => {
        const merged = mergeUsageTallies(
            tally(fact({ todos: { declared: 1, completed: 1, reopened: 0, abandoned: 0 } })),
            tally(fact({ todos: { declared: 1, completed: 1, reopened: 0, abandoned: 0 } })),
        )

        expect(merged.facts[0]?.todos).toEqual({ declared: 2, completed: 2, reopened: 0, abandoned: 0 })
    })
})
