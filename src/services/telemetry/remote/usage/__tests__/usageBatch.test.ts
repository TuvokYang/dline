import { describe, expect, it } from "vitest"
import type { UsageSettlement } from "@/core/task/telemetry/UsageSettlement"
import {
    sanitizeUsageClient,
    USAGE_MODEL_PATTERN,
    USAGE_PROVIDER_PATTERN,
    type UsageBodyWire,
    type UsageHistogramWire,
    validateUsageBody,
} from "../../contracts/usageBody"
import { buildUsageBody, type UsageMinute } from "../usageBatch"
import {
    EMPTY_USAGE_TALLY,
    mergeUsageTallies,
    parseUsageTally,
    projectUsageSettlement,
    sessionStartedTally,
    type UsageTally,
} from "../usageTally"

const T0 = 1_899_999_960_000
const MINUTE = 60_000
const CLIENT = { version: "0.11.1", platform: "win32", host_editor: "vscode", channel: "stable", is_dev: false } as const

function settlement(overrides: Partial<UsageSettlement> = {}): UsageSettlement {
    return {
        observationId: "o",
        purpose: "task",
        outcome: "completed",
        inputTokens: 1_200,
        outputTokens: 300,
        cacheReadTokens: 54_000,
        cacheWriteTokens: 2_100,
        durationMs: 2_500,
        ...overrides,
    }
}

function minutesOf(...tallies: UsageTally[][]): UsageMinute[] {
    return tallies.map((list, index) => ({
        startedAt: T0 + index * MINUTE,
        tally: list.reduce(mergeUsageTallies, EMPTY_USAGE_TALLY),
    }))
}

function body(minutes: UsageMinute[], dropped = 0): UsageBodyWire {
    const built = buildUsageBody(minutes, CLIENT, dropped)
    if (!built) throw new Error("expected a body")
    return built
}

function bucketsSum(histogram: UsageHistogramWire | undefined): number {
    return histogram?.buckets.reduce((sum, count) => sum + count, 0) ?? 0
}

describe("usage tally projection (contract v2 §2.2)", () => {
    it("counts a request by purpose and outcome with fresh input apart from cache reads and writes", () => {
        const tally = projectUsageSettlement(settlement({ purpose: "compaction", outcome: "cancelled" }))

        expect(tally.purposes).toEqual({
            compaction: {
                requests: { completed: 0, cancelled: 1, failed: 0 },
                tokens: { input: 1_200, output: 300, cache_read: 54_000, cache_write: 2_100 },
                duration_ms: { count: 1, sum: 2_500, min: 2_500, max: 2_500 },
            },
        })
        expect(tally.models).toEqual([])
        expect(tally.providers).toEqual([])
    })

    it("reports a purpose this build does not know as other", () => {
        const tally = projectUsageSettlement(settlement({ purpose: "planning" as UsageSettlement["purpose"] }))

        expect(Object.keys(tally.purposes)).toEqual(["other"])
    })

    it("describes the serving model with its tokens, reasoning inside output, and a duration histogram", () => {
        const [model] = projectUsageSettlement(
            settlement({ servedBy: { provider: "anthropic", model: "claude-opus-5-5" }, reasoningTokens: 40, durationMs: 4_100 }),
        ).models

        expect(model).toEqual({
            provider: "anthropic",
            model: "claude-opus-5-5",
            requests: { total: 1, failed: 0, cancelled: 0 },
            tokens: { input: 1_200, output: 300, cache_read: 54_000, cache_write: 2_100, reasoning: 40 },
            duration_ms: { count: 1, sum: 4_100, min: 4_100, max: 4_100, buckets: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0] },
        })
    })

    it("omits reasoning the provider did not report and holds a reported share within output", () => {
        const servedBy = { provider: "p", model: "m" }

        expect(projectUsageSettlement(settlement({ servedBy })).models[0].tokens).not.toHaveProperty("reasoning")
        expect(projectUsageSettlement(settlement({ servedBy, reasoningTokens: 900 })).models[0].tokens.reasoning).toBe(300)
    })

    it("times first token and generation only for a streamed request, and puts a sample past every bound in the last bucket", () => {
        const servedBy = { provider: "p", model: "m" }
        const streamed = projectUsageSettlement(
            settlement({ servedBy, durationMs: 500_000, streamTiming: { ttftMs: 600, generationMs: 900 } }),
        ).models[0]
        const plain = projectUsageSettlement(settlement({ servedBy })).models[0]

        expect(streamed.duration_ms?.buckets.at(-1)).toBe(1)
        expect(streamed.ttft_ms?.buckets).toEqual([0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])
        expect(streamed.generation_ms?.buckets).toEqual([0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])
        expect(plain).not.toHaveProperty("ttft_ms")
        expect(plain).not.toHaveProperty("generation_ms")
    })

    it("counts a failure once under its provider and class, and every retry with its wait", () => {
        const tally = projectUsageSettlement(
            settlement({
                outcome: "failed",
                failureClass: "rate_limited",
                servedBy: { provider: "Anthropic", model: "claude" },
                retries: { waitsMs: [1_000, 2_000] },
            }),
        )

        expect(tally.providers).toEqual([
            {
                provider: "anthropic",
                errors: { rate_limited: 1 },
                retries: 2,
                retry_wait_ms: { count: 2, sum: 3_000, min: 1_000, max: 2_000 },
            },
        ])
        expect(tally.models[0].requests).toEqual({ total: 1, failed: 1, cancelled: 0 })
    })

    it("turns any model ID into one the service accepts", () => {
        const [model] = projectUsageSettlement(
            settlement({ servedBy: { provider: "Open Router!", model: `Qwen/Qwen3-Coder:480B@2025 ${"x".repeat(200)}` } }),
        ).models

        expect(model.provider).toMatch(USAGE_PROVIDER_PATTERN)
        expect(model.model).toMatch(USAGE_MODEL_PATTERN)
        expect(model.model.startsWith("qwen_qwen3-coder_480b_2025_x")).toBe(true)
    })

    it("names a custom model by its own ID and marks it custom", () => {
        const custom = projectUsageSettlement(
            settlement({ servedBy: { provider: "openai", model: "Acme/LLM-v7", custom: true } }),
        )
        const listed = projectUsageSettlement(settlement({ servedBy: { provider: "openai", model: "gpt-5" } }))
        const sent = body(minutesOf([custom, listed]))

        expect(validateUsageBody(sent)).toEqual([])
        expect(sent.models.map(({ model, custom }) => ({ model, custom }))).toEqual([
            { model: "acme_llm-v7", custom: true },
            { model: "gpt-5", custom: undefined },
        ])
    })
})

describe("buildUsageBody (contract v2 §2.1-§2.3)", () => {
    it("folds models beyond eight into _other without changing any total", () => {
        const tallies = Array.from({ length: 11 }, (_, index) =>
            Array.from({ length: index + 1 }, () =>
                projectUsageSettlement(
                    settlement({
                        servedBy: { provider: "p", model: `model-${index}` },
                        durationMs: 100 * (index + 1),
                        streamTiming: { ttftMs: 300, generationMs: 400 },
                    }),
                ),
            ),
        ).flat()
        const sent = body(minutesOf(tallies))
        const total = (pick: (model: UsageBodyWire["models"][number]) => number) =>
            sent.models.reduce((sum, model) => sum + pick(model), 0)

        expect(validateUsageBody(sent)).toEqual([])
        expect(sent.models).toHaveLength(8)
        expect(sent.models.map((model) => model.model).slice(0, 7)).toEqual(
            [10, 9, 8, 7, 6, 5, 4].map((index) => `model-${index}`),
        )
        expect(sent.models[7]).toMatchObject({ provider: "_other", model: "_other", requests: { total: 1 + 2 + 3 + 4 } })
        expect(sent.models[7]).not.toHaveProperty("custom")
        expect(total((model) => model.requests.total)).toBe(66)
        expect(total((model) => model.tokens.input)).toBe(66 * 1_200)
        expect(total((model) => model.duration_ms?.count ?? 0)).toBe(66)
        expect(sent.models.every((model) => bucketsSum(model.duration_ms) === model.duration_ms?.count)).toBe(true)
        expect(sent.models.every((model) => bucketsSum(model.ttft_ms) === model.ttft_ms?.count)).toBe(true)
    })

    it("keeps each model's busiest minute by requests and by output tokens, never above its totals", () => {
        const call = (outputTokens: number) =>
            projectUsageSettlement(settlement({ servedBy: { provider: "p", model: "m" }, outputTokens }))
        const sent = body(minutesOf([call(10), call(20)], [call(100)], [call(1)]))

        expect(sent.models[0].peak_minute).toEqual({ requests: 2, tokens_output: 100 })
        expect(sent.models[0].requests.total).toBe(4)
        expect(sent.models[0].tokens.output).toBe(131)
        expect(validateUsageBody(sent)).toEqual([])
    })

    it("lists only providers with failures or retries, and folds providers beyond eight into _other", () => {
        const failures = Array.from({ length: 10 }, (_, index) =>
            projectUsageSettlement(
                settlement({ outcome: "failed", failureClass: "timeout", servedBy: { provider: `p${index}`, model: "m" } }),
            ),
        )
        const quiet = projectUsageSettlement(settlement({ servedBy: { provider: "calm", model: "m" } }))
        const sent = body(minutesOf([...failures, quiet]))

        expect(sent.providers).toHaveLength(8)
        expect(sent.providers.some((provider) => provider.provider === "calm")).toBe(false)
        expect(sent.providers[7]).toEqual({ provider: "_other", errors: { timeout: 3 }, retries: 0 })
        expect(validateUsageBody(sent)).toEqual([])
    })

    it("sends a batch for activations alone, and nothing for minutes without activity", () => {
        const sent = body(minutesOf([sessionStartedTally(), sessionStartedTally()]))

        expect(sent).toMatchObject({ sessions_started: 2, purposes: {}, models: [], providers: [] })
        expect(validateUsageBody(sent)).toEqual([])
        expect(buildUsageBody([], CLIENT, 0)).toBeUndefined()
        expect(buildUsageBody(minutesOf([EMPTY_USAGE_TALLY]), CLIENT, 0)).toBeUndefined()
    })
})

describe("validateUsageBody (contract v2 §1.4, §2.2)", () => {
    const valid = body(
        minutesOf([
            projectUsageSettlement(
                settlement({ servedBy: { provider: "p", model: "m" }, streamTiming: { ttftMs: 1, generationMs: 1 } }),
            ),
        ]),
    )

    it("accepts a body built from real requests", () => {
        expect(validateUsageBody(valid)).toEqual([])
    })

    it.each([
        ["client", { ...valid, client: { ...valid.client, version: "0.11 beta" } }],
        ["client", { ...valid, client: { ...valid.client, host_editor: "zed" } }],
        ["window", { ...valid, window: { ...valid.window, ended_at: valid.window.started_at + 61 * MINUTE } }],
        ["window", { ...valid, window: { ...valid.window, active_minutes: 0 } }],
        ["window", { ...valid, window: { ...valid.window, started_at: valid.window.started_at + 1 } }],
        ["purposes", { ...valid, purposes: { planning: valid.purposes.task } }],
        ["models", { ...valid, models: Array.from({ length: 9 }, (_, index) => ({ ...valid.models[0], model: `m${index}` })) }],
        ["models", { ...valid, models: [{ ...valid.models[0], peak_minute: { requests: 5, tokens_output: 0 } }] }],
        [
            "models",
            {
                ...valid,
                models: [
                    { ...valid.models[0], ttft_ms: { ...valid.models[0].ttft_ms, buckets: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
                ],
            },
        ],
        ["models", { ...valid, models: [{ ...valid.models[0], model: "Claude/Opus" }] }],
        ["providers", { ...valid, providers: [{ provider: "p", errors: { teapot: 1 }, retries: 0 }] }],
        ["sessions_started", { ...valid, sessions_started: -1 }],
    ])("names the %s section when it breaks a service rule", (section, broken) => {
        expect(validateUsageBody(broken as UsageBodyWire)).toEqual([section])
    })

    it("leaves a client value the service would refuse out instead of sending it empty", () => {
        expect(sanitizeUsageClient({ version: "0.11.1", platform: "", architecture: "x64", host_version: "1.105/0" })).toEqual({
            version: "0.11.1",
            architecture: "x64",
        })
        expect(sanitizeUsageClient({ version: "" })).toBeUndefined()
    })

    it("keeps a client value with spaces, which the service accepts everywhere but in the version (§2.2)", () => {
        expect(sanitizeUsageClient({ version: "0.11.1", host_version: "1.105.0 Insider", architecture: "x".repeat(65) })).toEqual(
            {
                version: "0.11.1",
                host_version: "1.105.0 Insider",
            },
        )
        expect(sanitizeUsageClient({ version: "0.11.1 beta" })).toBeUndefined()
    })
})

describe("persisted tallies", () => {
    it("reads back a tally and refuses one whose histogram disagrees with its count", () => {
        const tally = projectUsageSettlement(settlement({ servedBy: { provider: "p", model: "m" } }))
        const damaged = {
            ...tally,
            models: [{ ...tally.models[0], duration_ms: { ...tally.models[0].duration_ms, count: 2 } }],
        }

        expect(parseUsageTally(JSON.parse(JSON.stringify(tally)))).toEqual(tally)
        expect(parseUsageTally(damaged)).toBeUndefined()
        expect(parseUsageTally({ counters: { "dline.usage.requests.task.completed": 1 }, measurements: {} })).toBeUndefined()
    })

    it("saturates a counter instead of losing integer precision", () => {
        const huge = { ...sessionStartedTally(), sessions_started: Number.MAX_SAFE_INTEGER }

        expect(mergeUsageTallies(huge, sessionStartedTally()).sessions_started).toBe(Number.MAX_SAFE_INTEGER)
    })
})
