import { describe, expect, it } from "vitest"
import type { UsageSettlement } from "@/core/task/telemetry/UsageSettlement"
import { USAGE_MAX_METRIC_NAMES, validateUsageAggregate } from "../../contracts/wire"
import { fitMetricNameLimit, projectUsageSettlement } from "../usageCatalog"
import { buildUsageAggregate, mergeObservations, type UsageWindow } from "../usageWindow"

const MINUTE = 60_000
const BASE = 1_900_000_020_000 - (1_900_000_020_000 % MINUTE)

function settlement(overrides: Partial<UsageSettlement> = {}): UsageSettlement {
    return {
        observationId: "o",
        purpose: "task",
        outcome: "completed",
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicroUsd: 450,
        durationMs: 1_200,
        ...overrides,
    }
}

function window(minute: number, observation = projectUsageSettlement(settlement())): UsageWindow {
    return { startedAt: BASE + minute * MINUTE, ...observation }
}

describe("usage catalog", () => {
    it("projects a request onto purpose and outcome names only, omitting zero counts", () => {
        const observation = projectUsageSettlement(
            settlement({ purpose: "compaction", outcome: "failed", costMicroUsd: undefined }),
        )

        expect(observation.counters).toEqual({
            "dline.usage.requests.compaction.failed": 1,
            "dline.usage.tokens.input.compaction": 100,
            "dline.usage.tokens.output.compaction": 10,
        })
        expect(observation.measurements).toEqual({
            "dline.usage.request_duration_ms.compaction": { count: 1, sum: 1_200, min: 1_200, max: 1_200 },
        })
    })

    it("reports a purpose this build does not know as other", () => {
        const observation = projectUsageSettlement(settlement({ purpose: "planning" as UsageSettlement["purpose"] }))

        expect(Object.keys(observation.counters)).toContain("dline.usage.requests.other.completed")
    })

    it("also counts the request under the provider and model that served it", () => {
        const observation = projectUsageSettlement(
            settlement({ outcome: "failed", servedBy: { provider: "anthropic", model: "claude-sonnet-4.5" } }),
        )

        expect(observation.counters).toMatchObject({
            "dline.usage.requests.task.failed": 1,
            "dline.usage.model.anthropic.requests.claude-sonnet-4.5": 1,
            "dline.usage.model.anthropic.tokens_input.claude-sonnet-4.5": 100,
            "dline.usage.model.anthropic.tokens_output.claude-sonnet-4.5": 10,
        })
    })

    it("turns any model ID into names the server accepts, keeping one model key across its metrics", () => {
        const model = `Qwen/Qwen3-Coder:480B@2025 ${"x".repeat(200)}`
        const observation = projectUsageSettlement(settlement({ servedBy: { provider: "OpenAI Compatible", model } }))
        const modelNames = Object.keys(observation.counters).filter((name) => name.startsWith("dline.usage.model."))

        expect(modelNames).toHaveLength(3)
        const aggregate = buildUsageAggregate([window(0, observation)], {})
        expect(validateUsageAggregate(aggregate as NonNullable<typeof aggregate>, BASE + MINUTE)).toEqual([])
        const modelKeys = new Set(modelNames.map((name) => name.split(".").slice(5).join(".")))
        expect(modelKeys.size).toBe(1)
        expect([...modelKeys][0]).toMatch(/^qwen_qwen3-coder_480b_2025_x+$/)
        expect(modelNames.every((name) => name.startsWith("dline.usage.model.openai_compatible."))).toBe(true)
    })

    it("folds the least used models into one overflow model once a batch would exceed the name limit", () => {
        let merged = projectUsageSettlement(settlement({ servedBy: { provider: "p", model: "busy" } }))
        merged = mergeObservations(merged, merged)
        for (let index = 0; index < 60; index++) {
            merged = mergeObservations(
                merged,
                projectUsageSettlement(settlement({ servedBy: { provider: "p", model: `m${index}` } })),
            )
        }

        const fitted = fitMetricNameLimit(merged)

        const names = [...Object.keys(fitted.counters), ...Object.keys(fitted.measurements)]
        expect(names.length).toBeLessThanOrEqual(USAGE_MAX_METRIC_NAMES)
        expect(fitted.counters["dline.usage.model.p.requests.busy"]).toBe(2)
        const modelRequests = Object.entries(fitted.counters)
            .filter(([name]) => name.startsWith("dline.usage.model.") && name.includes(".requests."))
            .reduce((total, [, value]) => total + value, 0)
        expect(modelRequests).toBe(62)
        expect(fitted.counters["dline.usage.model._other.requests._other"]).toBeGreaterThan(0)
        expect(fitted.counters["dline.usage.requests.task.completed"]).toBe(62)
    })
})

describe("usage windows", () => {
    it("merges shards of the same minute into one window the server accepts", () => {
        const fast = projectUsageSettlement(settlement({ durationMs: 200 }))
        const slow = projectUsageSettlement(settlement({ durationMs: 5_000 }))
        const aggregate = buildUsageAggregate([window(0, fast), window(0, slow)], { platform: "win32" })

        expect(aggregate).toMatchObject({
            window_started_at: BASE,
            window_ended_at: BASE + MINUTE,
            aggregation_count: 1,
            counters: { "dline.usage.requests.task.completed": 2, "dline.usage.tokens.input.task": 200 },
            measurements: { "dline.usage.request_duration_ms.task": { count: 2, sum: 5_200, min: 200, max: 5_000 } },
        })
        expect(validateUsageAggregate(aggregate as NonNullable<typeof aggregate>, BASE + MINUTE)).toEqual([])
    })

    it("drops the oldest minutes beyond ten and moves the start with them", () => {
        const windows = Array.from({ length: 12 }, (_, minute) => window(minute))
        const aggregate = buildUsageAggregate(windows, {}, 1)

        expect(aggregate).toMatchObject({
            window_started_at: BASE + 2 * MINUTE,
            window_ended_at: BASE + 12 * MINUTE,
            aggregation_count: 10,
            dropped_windows: 3,
        })
        expect(aggregate?.counters["dline.usage.requests.task.completed"]).toBe(10)
        expect(validateUsageAggregate(aggregate as NonNullable<typeof aggregate>, BASE + 12 * MINUTE)).toEqual([])
    })

    it("sends nothing for an empty set of windows", () => {
        expect(buildUsageAggregate([], {})).toBeUndefined()
    })

    it("saturates a counter instead of losing integer precision", () => {
        const merged = mergeObservations(
            { counters: { a: Number.MAX_SAFE_INTEGER - 1 }, measurements: {} },
            { counters: { a: 5 }, measurements: {} },
        )

        expect(merged.counters.a).toBe(Number.MAX_SAFE_INTEGER)
    })
})
