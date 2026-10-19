import { describe, expect, it } from "vitest"
import type {
    ProviderRequestRecord,
    ProviderRequestReportPort,
    ProviderRequestSettlement,
} from "../../executors/provider/service/ProviderRequestReport"
import type { UsageServedModel, UsageSettlement } from "../UsageSettlement"
import { UsageSettlementRequestReporter } from "../UsageSettlementRequestReporter"

function harness(options: { readonly failBegin?: boolean; readonly failRecord?: boolean } = {}) {
    let now = 1_000
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
        serve: (next: UsageServedModel | undefined) => {
            served = next
        },
    }
}

describe("UsageSettlementRequestReporter", () => {
    it("settles every attempt a request consumed, with its duration", async () => {
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

    it("times only the attempt that produced the reply and counts each retry with its wait", async () => {
        const { reporter, recorded, advance } = harness()
        const record = await reporter.begin({ turnId: "turn-1" })
        advance(500)
        await record.retrying?.({ attempt: 1, maxAttempts: 5, delayMs: 2_000, errorMessage: "{}" })
        advance(9_000)

        await record.settle({
            usage: { inputTokens: 5, outputTokens: 3, thoughtsTokenCount: 2, thoughtsUsageReported: 1 },
            outcome: "completed",
            attemptTiming: { durationMs: 1_200, ttftMs: 200, generationMs: 1_000 },
        })

        expect(recorded[0]).toMatchObject({
            durationMs: 1_200,
            streamTiming: { ttftMs: 200, generationMs: 1_000 },
            retries: { waitsMs: [2_000] },
            reasoningTokens: 2,
        })
        expect(recorded[0].failureClass).toBeUndefined()
    })

    it("without the provider's clock, times a failed request from when its last retry was due and classifies the failure", async () => {
        const { reporter, recorded, advance } = harness({ failBegin: true })
        const record = await reporter.begin({ turnId: "turn-1" })
        advance(500)
        await record.retrying?.({ attempt: 1, maxAttempts: 5, delayMs: 2_000, errorMessage: "{}" })
        advance(3_500)

        await record.settle({ outcome: "failed", failure: Object.assign(new Error("provider failed"), { status: 429 }) })

        expect(recorded[0]).toMatchObject({ outcome: "failed", durationMs: 1_500, failureClass: "rate_limited" })
        expect(recorded[0].streamTiming).toBeUndefined()
    })

    it("keeps the visible settlement when the usage sink fails", async () => {
        const { reporter, innerSettled } = harness({ failRecord: true })
        const record = await reporter.begin({ turnId: "turn-1" })

        await expect(record.settle({ usage: { inputTokens: 5 }, outcome: "completed" })).resolves.toBeUndefined()

        expect(innerSettled).toHaveLength(1)
    })
})
