import type { CompactionAttemptDiagnostics } from "@core/context/context-management/compaction-attempt-diagnostics"
import { describe, expect, it } from "vitest"
import type { ApiRequestRoundUsage } from "../../performance/api-request-round-types"
import type { ProviderRequestRoundAdmission, ProviderRequestRoundPort } from "../../performance/provider-request-round-port"
import { compactionAttemptSettlement, settleSubagentRoundUsage } from "../NestedUsageSettlement"
import type { UsageSettlement } from "../UsageSettlement"

function diagnostics(overrides: Partial<CompactionAttemptDiagnostics>): CompactionAttemptDiagnostics {
    return {
        attemptIndex: 0,
        authorizationAttemptId: "attempt-1",
        outcome: "accepted",
        textChunks: 0,
        textChars: 0,
        reasoningChunks: 0,
        reasoningChars: 0,
        toolCallChunks: 0,
        toolNames: [],
        providerTtfbMs: 400,
        streamMs: 1_600,
        ...overrides,
    }
}

async function drain(stream: AsyncIterable<number>): Promise<void> {
    for await (const _ of stream) {
        // Consume like the runner does.
    }
}

async function* chunks(failure?: Error): AsyncIterable<number> {
    yield 1
    if (failure) throw failure
}

function roundPort() {
    const attached: Array<{ source: string; usage: ApiRequestRoundUsage }> = []
    const port: ProviderRequestRoundPort = {
        admit: (input) =>
            ({
                bindAttempt: (stream) => stream,
                attachExactUsage: (usage) => void attached.push({ source: input.source, usage }),
                completeProviderOnly: () => undefined,
                completeTools: () => undefined,
                completeTurnEndAwaitingUser: () => undefined,
            }) satisfies ProviderRequestRoundAdmission,
    }
    return { port, attached }
}

const ROUND_USAGE: ApiRequestRoundUsage = {
    inputTokens: 200,
    outputTokens: 20,
    cacheReadTokens: 50,
    cacheUsageReported: true,
    totalCost: 0.0123,
    currency: "USD",
}

describe("compactionAttemptSettlement", () => {
    it("charges an accepted Pass attempt to the handler that served it", () => {
        const settlement = compactionAttemptSettlement(
            diagnostics({
                usage: { inputTokens: 1_000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 1_100 },
            }),
            { provider: "anthropic", model: "claude-haiku-4.5" },
        )

        expect(settlement).toEqual({
            observationId: "attempt-1",
            purpose: "compaction",
            outcome: "completed",
            inputTokens: 1_000,
            outputTokens: 100,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            durationMs: 2_000,
            streamTiming: { ttftMs: 400, generationMs: 1_600 },
            servedBy: { provider: "anthropic", model: "claude-haiku-4.5" },
        })
    })

    it("counts a failed attempt that reported nothing without inventing a serving model", () => {
        const settlement = compactionAttemptSettlement(
            diagnostics({ outcome: "failed", authorizationAttemptId: "" }),
            undefined,
            () => "fresh",
        )

        expect(settlement).toMatchObject({ observationId: "fresh", outcome: "failed", inputTokens: 0, outputTokens: 0 })
        expect(settlement.servedBy).toBeUndefined()
    })
})

describe("settleSubagentRoundUsage", () => {
    it("settles each subagent round with the outcome its stream reached and keeps the round record", async () => {
        const { port, attached } = roundPort()
        const recorded: UsageSettlement[] = []
        let now = 0
        let id = 0
        const rounds = settleSubagentRoundUsage(
            port,
            { record: (settlement) => void recorded.push(settlement) },
            {
                clock: () => now,
                newObservationId: () => `round-${++id}`,
            },
        )
        const servedBy = { provider: "openrouter", model: "deepseek/deepseek-chat" }
        const admission = rounds?.admit({ source: "subagent", servedBy })
        if (!admission) throw new Error("expected an admission")

        const completed = admission.bindAttempt(chunks(), 0)
        now = 750
        await drain(completed)
        admission.attachExactUsage(ROUND_USAGE)
        const failing = admission.bindAttempt(chunks(new Error("stream broke")), 1)
        await expect(drain(failing)).rejects.toThrow("stream broke")
        admission.attachExactUsage({ ...ROUND_USAGE, currency: "CNY" })

        expect(recorded).toEqual([
            {
                observationId: "round-1",
                purpose: "subagent",
                outcome: "completed",
                inputTokens: 200,
                outputTokens: 20,
                cacheReadTokens: 50,
                cacheWriteTokens: 0,
                durationMs: 750,
                streamTiming: { ttftMs: 750, generationMs: 0 },
                servedBy,
            },
            {
                observationId: "round-2",
                purpose: "subagent",
                outcome: "failed",
                inputTokens: 200,
                outputTokens: 20,
                cacheReadTokens: 50,
                cacheWriteTokens: 0,
                durationMs: 0,
                failureClass: "other",
                servedBy,
            },
        ])
        expect(attached.map(({ source }) => source)).toEqual(["subagent", "subagent"])
    })

    it("counts a resent attempt as a retry of the round and times only the attempt that answered", async () => {
        const { port } = roundPort()
        const recorded: UsageSettlement[] = []
        let now = 0
        const rounds = settleSubagentRoundUsage(
            port,
            { record: (settlement) => void recorded.push(settlement) },
            { clock: () => now },
        )
        const admission = rounds?.admit({ source: "subagent" })
        if (!admission) throw new Error("expected an admission")

        const limited = Object.assign(new Error("Too Many Requests"), { status: 429 })
        await expect(drain(admission.bindAttempt(chunks(limited), 0))).rejects.toThrow("Too Many Requests")
        now = 1_000
        const answered = admission.bindAttempt(chunks(), 1)
        now = 1_500
        await drain(answered)
        admission.attachExactUsage({ ...ROUND_USAGE, thoughtsTokens: 8 })

        expect(recorded).toHaveLength(1)
        expect(recorded[0]).toMatchObject({
            outcome: "completed",
            reasoningTokens: 8,
            durationMs: 500,
            retries: { waitsMs: [1_000] },
        })
        expect(recorded[0].failureClass).toBeUndefined()
    })

    it("leaves ordinary and compaction rounds to their own settlement", () => {
        const { port, attached } = roundPort()
        const recorded: UsageSettlement[] = []
        const rounds = settleSubagentRoundUsage(port, { record: (settlement) => void recorded.push(settlement) })

        rounds?.admit({ source: "compaction" }).attachExactUsage(ROUND_USAGE)
        rounds?.admit({ source: "ordinary", apiIndex: 1 }).attachExactUsage(ROUND_USAGE)

        expect(recorded).toEqual([])
        expect(attached).toHaveLength(2)
    })

    it("still records the round when the usage sink fails", () => {
        const { port, attached } = roundPort()
        const rounds = settleSubagentRoundUsage(port, {
            record: () => {
                throw new Error("spool unavailable")
            },
        })

        expect(() => rounds?.admit({ source: "subagent" }).attachExactUsage(ROUND_USAGE)).not.toThrow()
        expect(attached).toHaveLength(1)
    })
})
