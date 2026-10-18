import type { ModelInfo } from "@shared/api"
import { describe, expect, it } from "vitest"
import type {
    ProviderRequestRecord,
    ProviderRequestReportPort,
    ProviderRequestSettlement,
} from "../../executors/provider/service/ProviderRequestReport"
import type { UsageServedModel, UsageSettlement } from "../UsageSettlement"
import { UsageSettlementRequestReporter } from "../UsageSettlementRequestReporter"

const DOLLAR_PRICED = { pricing: { inputPrice: 3, outputPrice: 15 } } as unknown as ModelInfo
const YUAN_PRICED = { pricing: { inputPrice: 3, outputPrice: 15, currency: "CNY" } } as unknown as ModelInfo

function harness(options: { readonly failBegin?: boolean; readonly failRecord?: boolean } = {}) {
    let now = 1_000
    let model = DOLLAR_PRICED
    let served: UsageServedModel | undefined
    let nextId = 0
    const recorded: UsageSettlement[] = []
    const innerSettled: ProviderRequestSettlement[] = []
    const inner: ProviderRequestReportPort = {
        begin: async () => {
            if (options.failBegin) throw new Error("row unavailable")
            return { settle: async (settlement) => void innerSettled.push(settlement) } satisfies ProviderRequestRecord
        },
    }
    const reporter = new UsageSettlementRequestReporter(inner, {
        settlement: {
            record: (settlement) => {
                if (options.failRecord) throw new Error("spool unavailable")
                recorded.push(settlement)
            },
        },
        purpose: "task",
        modelInfo: () => model,
        servedBy: () => served,
        clock: () => now,
        newObservationId: () => `observation-${++nextId}`,
    })
    return {
        reporter,
        recorded,
        innerSettled,
        advance: (ms: number) => {
            now += ms
        },
        switchModel: (next: ModelInfo) => {
            model = next
        },
        serve: (next: UsageServedModel | undefined) => {
            served = next
        },
    }
}

describe("UsageSettlementRequestReporter", () => {
    it("settles every attempt a request consumed, priced in micro-dollars, with its duration", async () => {
        const { reporter, recorded, innerSettled, advance } = harness()
        const record = await reporter.begin({ turnId: "turn-1" })
        advance(2_500)
        const settlement: ProviderRequestSettlement = {
            usage: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 0 },
            contextUsage: { inputTokens: 600, outputTokens: 60 },
            outcome: "completed",
        }

        await record.settle(settlement)

        expect(recorded).toEqual([
            {
                observationId: "observation-1",
                purpose: "task",
                outcome: "completed",
                inputTokens: 1_000,
                outputTokens: 100,
                cacheReadTokens: 40,
                cacheWriteTokens: 0,
                costMicroUsd: 4_500,
                durationMs: 2_500,
            },
        ])
        expect(innerSettled).toEqual([settlement])
    })

    it("attributes the request to the provider and model serving it when it opened", async () => {
        const { reporter, recorded, serve } = harness()
        serve({ provider: "anthropic", model: "claude-sonnet-4.5" })
        const record = await reporter.begin({ turnId: "turn-1" })
        serve({ provider: "openai", model: "gpt-5" })

        await record.settle({ outcome: "completed", usage: { inputTokens: 10, outputTokens: 1 } })

        expect(recorded.map((settlement) => settlement.servedBy)).toEqual([{ provider: "anthropic", model: "claude-sonnet-4.5" }])
    })

    it("charges cancelled and failed requests with the usage they reported", async () => {
        const { reporter, recorded } = harness()

        await (await reporter.begin({ turnId: "turn-1" })).settle({
            usage: { inputTokens: 10, outputTokens: 1 },
            outcome: "cancelled",
        })
        await (await reporter.begin({ turnId: "turn-2" })).settle({ outcome: "failed" })

        expect(recorded.map(({ observationId, outcome, inputTokens }) => ({ observationId, outcome, inputTokens }))).toEqual([
            { observationId: "observation-1", outcome: "cancelled", inputTokens: 10 },
            { observationId: "observation-2", outcome: "failed", inputTokens: 0 },
        ])
        expect(recorded[1].costMicroUsd).toBeUndefined()
    })

    it("prices with the handler that opened the request and prefers a reported cost", async () => {
        const { reporter, recorded, switchModel } = harness()
        const opened = await reporter.begin({ turnId: "turn-1" })
        switchModel(YUAN_PRICED)
        await opened.settle({ usage: { inputTokens: 1_000, outputTokens: 0 }, outcome: "completed" })
        const reported = await reporter.begin({ turnId: "turn-2" })
        await reported.settle({ usage: { inputTokens: 1_000, totalCost: 0.25, costUsageReported: 1 }, outcome: "completed" })

        expect(recorded[0].costMicroUsd).toBe(3_000)
        expect(recorded[1].costMicroUsd).toBeUndefined()
    })

    it("still charges a request whose visible row could not open", async () => {
        const { reporter, recorded } = harness({ failBegin: true })

        const record = await reporter.begin({ turnId: "turn-1" })
        await record.settle({ usage: { inputTokens: 5, outputTokens: 1 }, outcome: "completed" })

        expect(recorded).toHaveLength(1)
        expect(recorded[0].inputTokens).toBe(5)
    })

    it("settles a request once even when its record is settled again", async () => {
        const { reporter, recorded, innerSettled } = harness()
        const record = await reporter.begin({ turnId: "turn-1" })

        await record.settle({ usage: { inputTokens: 5 }, outcome: "completed" })
        await record.settle({ usage: { inputTokens: 5 }, outcome: "completed" })

        expect(recorded).toHaveLength(1)
        expect(innerSettled).toHaveLength(2)
    })

    it("keeps the visible settlement when the usage sink fails", async () => {
        const { reporter, innerSettled } = harness({ failRecord: true })
        const record = await reporter.begin({ turnId: "turn-1" })

        await expect(record.settle({ usage: { inputTokens: 5 }, outcome: "completed" })).resolves.toBeUndefined()

        expect(innerSettled).toHaveLength(1)
    })
})
