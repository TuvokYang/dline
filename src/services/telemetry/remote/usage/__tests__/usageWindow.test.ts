import { describe, expect, it } from "vitest"
import type { UsageSettlement } from "@/core/task/telemetry/UsageSettlement"
import { USAGE_MAX_METRIC_NAMES, type UsageAggregateWire, validateUsageAggregate } from "../../contracts/wire"
import { fitMetricNameLimit, parseUsageObservation, projectUsageSettlement, type UsageObservation } from "../usageCatalog"
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
        durationMs: 1_200,
        ...overrides,
    }
}

/** The bucket bounds §6 of the otel usage contract fixes; the server rejects any other set. */
const CONTRACT_BOUNDS_MS = [250, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000]

function nameCount(observation: UsageObservation): number {
    return (
        Object.keys(observation.counters).length +
        Object.keys(observation.measurements).length +
        Object.keys(observation.histograms ?? {}).length
    )
}

function modelNames(observation: UsageObservation): string[] {
    return [
        ...Object.keys(observation.counters),
        ...Object.keys(observation.measurements),
        ...Object.keys(observation.histograms ?? {}),
    ].filter((name) => name.startsWith("dline.usage.model."))
}

function sumOf(counters: Readonly<Record<string, number>>, matches: (name: string) => boolean): number {
    return Object.entries(counters)
        .filter(([name]) => matches(name))
        .reduce((total, [, value]) => total + value, 0)
}

function aggregateOf(observation: UsageObservation): UsageAggregateWire {
    const aggregate = buildUsageAggregate([window(0, observation)], {})
    if (!aggregate) throw new Error("expected an aggregate")
    expect(validateUsageAggregate(aggregate, BASE + MINUTE)).toEqual([])
    return aggregate
}

function window(minute: number, observation = projectUsageSettlement(settlement())): UsageWindow {
    return { startedAt: BASE + minute * MINUTE, ...observation }
}

describe("usage catalog", () => {
    it("projects a request without a serving model onto purpose, outcome and unattributed error names, omitting zero counts", () => {
        const observation = projectUsageSettlement(settlement({ purpose: "compaction", outcome: "failed" }))

        expect(observation.counters).toEqual({
            "dline.usage.requests.compaction.failed": 1,
            "dline.usage.tokens.input.compaction": 100,
            "dline.usage.tokens.output.compaction": 10,
            "dline.usage.errors.unknown.other": 1,
        })
        expect(observation.measurements).toEqual({
            "dline.usage.request_duration_ms.compaction": { count: 1, sum: 1_200, min: 1_200, max: 1_200 },
        })
    })

    it("produces no per-model name for a request without a serving model", () => {
        const observation = projectUsageSettlement(
            settlement({ cacheReadTokens: 40, reasoningTokens: 5, streamTiming: { ttftMs: 300, generationMs: 900 } }),
        )

        expect(modelNames(observation)).toEqual([])
    })

    it("reports cache reads and writes under the serving model with the same values as the purpose family", () => {
        const servedBy = { provider: "anthropic", model: "claude-sonnet-4.5" }
        let merged = projectUsageSettlement(settlement({ servedBy, cacheReadTokens: 800, cacheWriteTokens: 120 }))
        merged = mergeObservations(merged, projectUsageSettlement(settlement({ servedBy, cacheReadTokens: 200 })))

        expect(merged.counters["dline.usage.model.anthropic.tokens_cache_read.claude-sonnet-4.5"]).toBe(1_000)
        expect(merged.counters["dline.usage.model.anthropic.tokens_cache_read.claude-sonnet-4.5"]).toBe(
            merged.counters["dline.usage.tokens.cache_read.task"],
        )
        expect(merged.counters["dline.usage.model.anthropic.tokens_cache_write.claude-sonnet-4.5"]).toBe(
            merged.counters["dline.usage.tokens.cache_write.task"],
        )
    })

    it("reports reasoning tokens separately while keeping them inside output", () => {
        const observation = projectUsageSettlement(
            settlement({ outputTokens: 50, reasoningTokens: 30, servedBy: { provider: "openai", model: "o3" } }),
        )

        expect(observation.counters).toMatchObject({
            "dline.usage.model.openai.tokens_output.o3": 50,
            "dline.usage.model.openai.tokens_reasoning.o3": 30,
            "dline.usage.tokens.output.task": 50,
        })
    })

    it("times the serving model with a summary and a histogram per timing, and only streams carry first-token timing", () => {
        const servedBy = { provider: "anthropic", model: "claude-sonnet-4.5" }
        const streamed = projectUsageSettlement(
            settlement({ servedBy, durationMs: 1_200, streamTiming: { ttftMs: 400, generationMs: 800 } }),
        )
        const unstreamed = projectUsageSettlement(settlement({ servedBy, durationMs: 1_200 }))

        expect(streamed.measurements).toMatchObject({
            "dline.usage.model.anthropic.request_duration_ms.claude-sonnet-4.5": { count: 1, sum: 1_200 },
            "dline.usage.model.anthropic.ttft_ms.claude-sonnet-4.5": { count: 1, sum: 400 },
            "dline.usage.model.anthropic.generation_ms.claude-sonnet-4.5": { count: 1, sum: 800 },
        })
        // 400 ms falls in the (250, 500] bucket, the second one.
        expect(streamed.histograms?.["dline.usage.model.anthropic.ttft_ms.claude-sonnet-4.5"]?.counts).toEqual([
            0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ])
        expect(Object.keys(unstreamed.histograms ?? {})).toEqual([
            "dline.usage.model.anthropic.request_duration_ms.claude-sonnet-4.5",
        ])
    })

    it("counts a sample beyond every bound in the overflow bucket", () => {
        const observation = projectUsageSettlement(settlement({ servedBy: { provider: "p", model: "m" }, durationMs: 500_000 }))

        expect(observation.histograms?.["dline.usage.model.p.request_duration_ms.m"]?.counts.at(-1)).toBe(1)
    })

    it("sends histograms with the contract bounds whose counts add up to their summary's count", () => {
        const servedBy = { provider: "anthropic", model: "claude-sonnet-4.5" }
        let merged = projectUsageSettlement(settlement({ servedBy, durationMs: 100 }))
        for (const durationMs of [700, 3_000, 45_000, 200_000]) {
            merged = mergeObservations(
                merged,
                projectUsageSettlement(settlement({ servedBy, durationMs, streamTiming: { ttftMs: 90, generationMs: 9_000 } })),
            )
        }

        const aggregate = aggregateOf(merged)

        const histograms = Object.entries(aggregate.histograms ?? {})
        expect(histograms.map(([name]) => name).sort()).toEqual([
            "dline.usage.model.anthropic.generation_ms.claude-sonnet-4.5",
            "dline.usage.model.anthropic.request_duration_ms.claude-sonnet-4.5",
            "dline.usage.model.anthropic.ttft_ms.claude-sonnet-4.5",
        ])
        for (const [name, histogram] of histograms) {
            expect(histogram.bounds).toEqual(CONTRACT_BOUNDS_MS)
            expect(histogram.counts.reduce((total, count) => total + count, 0)).toBe(aggregate.measurements?.[name]?.count)
        }
        expect(aggregate.histograms?.["dline.usage.model.anthropic.request_duration_ms.claude-sonnet-4.5"]?.counts).toEqual([
            1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1,
        ])
    })

    it("replaces a custom model's ID with _custom so the ID appears nowhere in the batch", () => {
        const model = "acme-internal-llm-v7"
        const observation = projectUsageSettlement(
            settlement({
                cacheReadTokens: 10,
                streamTiming: { ttftMs: 100, generationMs: 200 },
                servedBy: { provider: "openai", model, custom: true },
            }),
        )

        const aggregate = aggregateOf(observation)

        expect(JSON.stringify(aggregate)).not.toContain(model)
        expect(modelNames(observation).length).toBeGreaterThan(0)
        expect(modelNames(observation).every((name) => name.endsWith("._custom"))).toBe(true)
    })

    it("counts a failed request once under its provider and error class", () => {
        const servedBy = { provider: "anthropic", model: "claude-sonnet-4.5" }
        const limited = projectUsageSettlement(settlement({ outcome: "failed", failureClass: "rate_limited", servedBy }))
        const unknown = projectUsageSettlement(
            settlement({ outcome: "failed", failureClass: "teapot" as UsageSettlement["failureClass"], servedBy }),
        )
        const completed = projectUsageSettlement(settlement({ failureClass: "timeout", servedBy }))

        expect(sumOf(limited.counters, (name) => name.startsWith("dline.usage.errors."))).toBe(1)
        expect(limited.counters["dline.usage.errors.anthropic.rate_limited"]).toBe(1)
        expect(limited.counters["dline.usage.model.anthropic.requests_failed.claude-sonnet-4.5"]).toBe(1)
        expect(unknown.counters["dline.usage.errors.anthropic.other"]).toBe(1)
        expect(sumOf(completed.counters, (name) => name.startsWith("dline.usage.errors."))).toBe(0)
    })

    it("counts every retried attempt and its backoff wait under the provider", () => {
        const observation = projectUsageSettlement(
            settlement({ servedBy: { provider: "anthropic", model: "claude-sonnet-4.5" }, retries: { waitsMs: [1_000, 2_000] } }),
        )

        expect(observation.counters["dline.usage.retries.anthropic"]).toBe(2)
        expect(observation.measurements["dline.usage.retry_wait_ms.anthropic"]).toEqual({
            count: 2,
            sum: 3_000,
            min: 1_000,
            max: 2_000,
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

        expect(nameCount(fitted)).toBeLessThanOrEqual(USAGE_MAX_METRIC_NAMES)
        expect(fitted.counters["dline.usage.model.p.requests.busy"]).toBe(2)
        expect(sumOf(fitted.counters, (name) => name.startsWith("dline.usage.model.") && name.includes(".requests."))).toBe(62)
        expect(fitted.counters["dline.usage.model._other.requests._other"]).toBeGreaterThan(0)
        expect(fitted.counters["dline.usage.requests.task.completed"]).toBe(62)
    })

    it("keeps every count and sample when folding models into _other, with each histogram still matching its summary", () => {
        let merged: UsageObservation = { counters: {}, measurements: {} }
        for (let index = 0; index < 40; index++) {
            merged = mergeObservations(
                merged,
                projectUsageSettlement(
                    settlement({
                        cacheReadTokens: 7,
                        cacheWriteTokens: 3,
                        reasoningTokens: 2,
                        outcome: index % 5 === 0 ? "failed" : "completed",
                        streamTiming: { ttftMs: 100 * index, generationMs: 1_000 },
                        servedBy: { provider: index % 2 === 0 ? "anthropic" : "openai", model: `model-${index}` },
                    }),
                ),
            )
        }

        const fitted = fitMetricNameLimit(merged)
        const aggregate = aggregateOf(fitted)

        expect(nameCount(fitted)).toBeLessThanOrEqual(USAGE_MAX_METRIC_NAMES)
        expect(nameCount(merged)).toBeGreaterThan(USAGE_MAX_METRIC_NAMES)
        for (const metric of [
            "requests",
            "tokens_input",
            "tokens_cache_read",
            "tokens_cache_write",
            "tokens_reasoning",
            "requests_failed",
        ]) {
            const isMetric = (name: string) => name.startsWith("dline.usage.model.") && name.split(".")[4] === metric
            expect(sumOf(fitted.counters, isMetric)).toBe(sumOf(merged.counters, isMetric))
        }
        const ttftSamples = Object.entries(aggregate.measurements ?? {})
            .filter(([name]) => name.split(".")[4] === "ttft_ms")
            .reduce((total, [, value]) => total + value.count, 0)
        expect(ttftSamples).toBe(40)
        expect(aggregate.histograms?.["dline.usage.model._other.ttft_ms._other"]).toBeDefined()
        expect(aggregate.measurements?.["dline.usage.model._other.ttft_ms._other"]?.count).toBeGreaterThan(1)
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

    it("merges histograms of the same minute so the window still validates", () => {
        const servedBy = { provider: "p", model: "m" }
        const aggregate = buildUsageAggregate(
            [
                window(0, projectUsageSettlement(settlement({ servedBy, durationMs: 100 }))),
                window(0, projectUsageSettlement(settlement({ servedBy, durationMs: 9_000 }))),
            ],
            {},
        )

        expect(aggregate?.histograms?.["dline.usage.model.p.request_duration_ms.m"]?.counts).toEqual([
            1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0,
        ])
        expect(validateUsageAggregate(aggregate as UsageAggregateWire, BASE + MINUTE)).toEqual([])
    })

    it("reads a persisted window written before histograms existed, and refuses a histogram that disagrees with its summary", () => {
        const legacy = { counters: { "dline.usage.requests.task.completed": 1 }, measurements: {} }
        const current = projectUsageSettlement(settlement({ servedBy: { provider: "p", model: "m" } }))
        const name = "dline.usage.model.p.request_duration_ms.m"
        const disagreeing = {
            ...current,
            histograms: { [name]: { bounds: CONTRACT_BOUNDS_MS, counts: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
        }

        expect(parseUsageObservation(legacy)).toEqual(legacy)
        expect(parseUsageObservation(JSON.parse(JSON.stringify(current)))).toEqual(current)
        expect(parseUsageObservation(disagreeing)).toBeUndefined()
    })

    it("saturates a counter instead of losing integer precision", () => {
        const merged = mergeObservations(
            { counters: { a: Number.MAX_SAFE_INTEGER - 1 }, measurements: {} },
            { counters: { a: 5 }, measurements: {} },
        )

        expect(merged.counters.a).toBe(Number.MAX_SAFE_INTEGER)
    })
})
