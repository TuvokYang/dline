import type { ApiHandler } from "@core/api"
import type { ApiStreamChunk } from "@core/api/transform/stream"
import { describe, expect, it } from "vitest"
import { ProductionProviderAdapter } from "../executors/provider/ProductionProviderAdapter"
import { ProviderCommandExecutor, type ProviderExecutionPort } from "../executors/provider/ProviderCommandExecutor"
import { DefaultProductionProviderService } from "../executors/provider/service/DefaultProductionProviderService"
import type { PreparedProviderRequest } from "../executors/provider/service/ProviderRequest"
import type { ProviderStartCommand, TaskEvent } from "../kernel"
import type { TaskPayloadStore } from "../stores/contracts"
import { InMemoryConversationJournal, InMemoryTaskPayloadStore, InMemoryTaskViewPort } from "../stores/InMemoryRuntimeStores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { ProviderDraftEnvelope } from "../stores/payload/TaskPayloadEnvelopes"

const FINAL_TEXT_BYTES = 64 * 1024
const WARMUP_SAMPLES = 5
const MEASUREMENT_SAMPLES = 20
// Detached legacy commit 9b1df49e, measured across the production path:
// Task.attemptApiRequest -> stream normalization -> StreamChunkCoordinator ->
// parser/canonical state update -> presentation sink (5 warmups, 20 samples).
const LEGACY_FIRST_PRESENTATION_P95_US = 101.9
const FIRST_PRESENTATION_P95_GATE_US = LEGACY_FIRST_PRESENTATION_P95_US * 1.1
/**
 * The first-presentation gate compares wall-clock microseconds on whatever
 * machine runs it with a constant measured on another one, so on shared CI
 * runners it fails on noise. It runs only in the explicit perf tier
 * (`npm run test:perf`), never in the required unit suites.
 */
const RUN_TIMING_GATES = process.env.DLINE_PERF_GATES === "1"

const command: ProviderStartCommand = {
    commandId: "provider:performance",
    originRevision: 1,
    generation: 0,
    type: "provider.start",
    draftRef: "assigned-by-fixture",
    turnId: "turn-performance",
}

class CountingPayloadStore implements TaskPayloadStore {
    private readonly delegate = new InMemoryTaskPayloadStore()
    readonly writes: number[] = []

    async put(payload: Uint8Array): Promise<string> {
        this.writes.push(payload.byteLength)
        return this.delegate.put(payload)
    }

    read(payloadRef: string): Promise<Uint8Array> {
        return this.delegate.read(payloadRef)
    }

    resetWrites(): void {
        this.writes.length = 0
    }
}

function textChunks(text: string, count: number): string[] {
    if (text.length % count !== 0) throw new Error("The fixed fixture must divide evenly")
    const size = text.length / count
    return Array.from({ length: count }, (_, index) => text.slice(index * size, (index + 1) * size))
}

function preparedRequest(parts: readonly string[], onFirstChunk: () => void): PreparedProviderRequest {
    const api = {
        createMessage: async function* () {
            for (let index = 0; index < parts.length; index++) {
                if (index === 0) onFirstChunk()
                yield { type: "text", text: parts[index] } as ApiStreamChunk
            }
        },
        getModel: () => ({ id: "performance-stub", info: {} }),
        getProviderId: () => "performance-stub",
    } as unknown as ApiHandler

    return {
        api,
        systemPrompt: "fixed-system-prompt",
        nativeTools: false,
        mode: "serial",
        profile: "standard",
        messages: [],
        turnId: command.turnId,
        planTool: () => ({ attempt: "attempt-1", lanes: [], turnEnding: false, approval: { kind: "none" } }),
    } as unknown as PreparedProviderRequest
}

interface StreamingRun {
    readonly firstPresentationOverheadUs: number
    readonly firstTokenOverheadUs: number
    readonly journalEntries: number
    readonly partialPresentations: number
    readonly payloadBytes: number
    readonly payloadWrites: number
    readonly publishedEvents: number
}

async function runStreamingTurn(chunkCount: number, finalTextBytes = FINAL_TEXT_BYTES): Promise<StreamingRun> {
    const finalText = "x".repeat(finalTextBytes)
    const parts = textChunks(finalText, chunkCount)
    const payloads = new CountingPayloadStore()
    const draft: ProviderDraftEnvelope = {
        kind: "provider_draft",
        admittedEntryIds: ["entry-performance"],
        inputPayloadRefs: ["input-performance"],
    }
    const draftRef = await payloads.put(encodeTaskPayload(draft))
    payloads.resetWrites()

    let emittedAt: bigint | undefined
    let runtimeYieldedAt: bigint | undefined
    let presentedAt: bigint | undefined
    const request = preparedRequest(parts, () => {
        emittedAt ??= process.hrtime.bigint()
    })
    const service = new DefaultProductionProviderService({
        requests: { prepare: async () => request },
        nextPresentationId: (() => {
            let id = 0
            return () => ++id
        })(),
    })
    const adapter = new ProductionProviderAdapter({ payloads, service })
    const measuredPort: ProviderExecutionPort = {
        recoverFinal: (payloadRef) => adapter.recoverFinal(payloadRef),
        start: async function* (input) {
            for await (const chunk of adapter.start(input)) {
                if (runtimeYieldedAt === undefined && chunk.kind === "partial") runtimeYieldedAt = process.hrtime.bigint()
                yield chunk
            }
        },
        recordUsage: (usage) => adapter.recordUsage(usage),
    }
    const journal = new InMemoryConversationJournal()
    const events: TaskEvent[] = []
    let partialPresentations = 0
    const executor = new ProviderCommandExecutor(
        "task-performance",
        measuredPort,
        journal,
        new InMemoryTaskViewPort(),
        {
            submit: async (event) => {
                events.push(event)
                return { kind: "accepted" as const }
            },
        },
        {
            showPartial: () => {
                partialPresentations++
                presentedAt ??= process.hrtime.bigint()
            },
            commit: async () => undefined,
        },
    )

    await executor.execute({ ...command, draftRef })
    if (emittedAt === undefined || runtimeYieldedAt === undefined || presentedAt === undefined) {
        throw new Error("The deterministic stub did not deliver and present a first token")
    }

    return {
        firstPresentationOverheadUs: Number(presentedAt - emittedAt) / 1_000,
        firstTokenOverheadUs: Number(runtimeYieldedAt - emittedAt) / 1_000,
        journalEntries: (await journal.read()).length,
        partialPresentations,
        payloadBytes: payloads.writes.reduce((total, bytes) => total + bytes, 0),
        payloadWrites: payloads.writes.length,
        publishedEvents: events.length,
    }
}

function percentile(samples: readonly number[], percentileValue: number): number {
    const sorted = [...samples].sort((left, right) => left - right)
    return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0
}

describe.sequential("WS-051 provider write amplification gate", () => {
    it("keeps persistent writes and logical bytes independent of stream chunk count", async () => {
        const single = await runStreamingTurn(1)
        const chunked = await runStreamingTurn(128)
        const report = {
            fixture: { finalTextBytes: FINAL_TEXT_BYTES, singleChunks: 1, chunkedChunks: 128 },
            single,
            chunked,
            passed:
                single.payloadWrites === 1 &&
                chunked.payloadWrites === single.payloadWrites &&
                chunked.payloadBytes === single.payloadBytes &&
                single.journalEntries === 1 &&
                chunked.journalEntries === 1 &&
                single.publishedEvents === 1 &&
                chunked.publishedEvents === 1,
        }
        console.log(`WS-051 write amplification gate ${JSON.stringify(report)}`)

        expect(single.partialPresentations).toBe(1)
        expect(chunked.partialPresentations).toBe(128)
        expect(single.journalEntries).toBe(1)
        expect(chunked.journalEntries).toBe(1)
        expect(single.publishedEvents).toBe(1)
        expect(chunked.publishedEvents).toBe(1)
        // A prose-only turn persists one final payload. Partial text remains in the
        // transient plane, so chunking cannot add payload transactions or bytes.
        expect(single.payloadWrites).toBe(1)
        expect(chunked.payloadWrites).toBe(single.payloadWrites)
        expect(chunked.payloadBytes).toBe(single.payloadBytes)
        expect(single.firstTokenOverheadUs).toBeGreaterThanOrEqual(0)
        expect(chunked.firstTokenOverheadUs).toBeGreaterThanOrEqual(0)
    })

    it.runIf(RUN_TIMING_GATES)(
        "keeps deterministic stub first-presentation runtime overhead within ten percent of legacy",
        async () => {
            for (let index = 0; index < WARMUP_SAMPLES; index++) await runStreamingTurn(1, 1)
            const runtimePortSamples: number[] = []
            const presentationSamples: number[] = []
            for (let index = 0; index < MEASUREMENT_SAMPLES; index++) {
                const sample = await runStreamingTurn(1, 1)
                runtimePortSamples.push(sample.firstTokenOverheadUs)
                presentationSamples.push(sample.firstPresentationOverheadUs)
            }
            const report = {
                baselineP95: LEGACY_FIRST_PRESENTATION_P95_US,
                limitP95: FIRST_PRESENTATION_P95_GATE_US,
                boundary: "provider-yield-to-presentation-sink",
                measurementSamples: MEASUREMENT_SAMPLES,
                presentationP50: percentile(presentationSamples, 0.5),
                presentationP95: percentile(presentationSamples, 0.95),
                presentationSamples,
                runtimePortP50: percentile(runtimePortSamples, 0.5),
                runtimePortP95: percentile(runtimePortSamples, 0.95),
                runtimePortSamples,
                unit: "microseconds",
                warmupSamples: WARMUP_SAMPLES,
            }
            console.log(`WS-051 deterministic first-presentation gate ${JSON.stringify(report)}`)
            expect(presentationSamples).toHaveLength(MEASUREMENT_SAMPLES)
            expect(presentationSamples.every((sample) => Number.isFinite(sample) && sample >= 0)).toBe(true)
            expect(runtimePortSamples.every((sample) => Number.isFinite(sample) && sample >= 0)).toBe(true)
            expect(report.presentationP95).toBeLessThanOrEqual(FIRST_PRESENTATION_P95_GATE_US)
        },
    )
})
