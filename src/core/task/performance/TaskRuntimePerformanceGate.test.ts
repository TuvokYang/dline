import { performance } from "node:perf_hooks"
import { describe, expect, it } from "vitest"
import { createInitialTaskState, hydrate, type TaskEvent, type TaskState, transition } from "../kernel"

const WARMUPS = 5
const SAMPLES = 20
const BLOCKS = 250
const LEGACY_HYDRATE_P95_US = 794.4999999999709
const LEGACY_RETAINED_STATE_BYTES = 44_384
const EXTENSION_HOST_BLOCK_GATE_US = 10_000

function percentile(samples: readonly number[], percentileValue: number): number {
    const sorted = [...samples].sort((left, right) => left - right)
    return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0
}

function block(index: number, phase: "ready" | "executing" = "executing") {
    return {
        blockId: `block-${index}`,
        index,
        phase,
        attempt: `attempt-${index}`,
        lanes: [`lane-${index % 4}`],
        turnEnding: false,
        invocationRef: `invocation-${index}`,
    } as const
}

function transitionFixture(index: number): { state: TaskState; event: TaskEvent } {
    const base = createInitialTaskState(`candidate-transition-${index}`)
    return {
        state: {
            ...base,
            flow: { phase: "running" },
            turn: {
                turnId: `turn-${index}`,
                mode: "parallel",
                blocks: [block(index, "ready")],
                manualApprovalBlockIds: [],
                automaticApprovalBlockIds: [],
                executingBlockIds: [],
            },
        },
        event: {
            type: "tool.started",
            generation: 0,
            turnId: `turn-${index}`,
            blockId: `block-${index}`,
            attempt: `attempt-${index}`,
        },
    }
}

const TRANSITION_FIXTURES = Array.from({ length: BLOCKS }, (_, index) => transitionFixture(index))

function transitionSample(): { averageUs: number; maxUs: number } {
    let maxUs = 0
    const started = performance.now()
    for (const fixture of TRANSITION_FIXTURES) {
        const callStarted = performance.now()
        const result = transition(fixture.state, fixture.event)
        if (result.kind !== "accepted") throw new Error("candidate transition fixture was rejected")
        maxUs = Math.max(maxUs, (performance.now() - callStarted) * 1_000)
    }
    return { averageUs: ((performance.now() - started) * 1_000) / TRANSITION_FIXTURES.length, maxUs }
}

function denseSnapshot(): TaskState {
    const base = createInitialTaskState("candidate-performance")
    const blocks = Array.from({ length: BLOCKS }, (_, index) => block(index))
    return {
        ...base,
        revision: BLOCKS,
        flow: { phase: "running" },
        turn: {
            turnId: "turn-performance",
            mode: "parallel",
            blocks,
            manualApprovalBlockIds: [],
            automaticApprovalBlockIds: [],
            executingBlockIds: blocks.map((candidate) => candidate.blockId),
        },
        journalWatermark: { seq: BLOCKS },
    }
}

function hydrateSample(snapshot: TaskState): number {
    const started = performance.now()
    const result = hydrate({
        taskId: snapshot.taskId,
        snapshot,
        journalTail: { seq: BLOCKS },
        openReason: "crash_recovery",
    })
    if (result.kind !== "ready" || result.state.turn.blocks.length !== BLOCKS) {
        throw new Error("candidate hydrate did not preserve the dense block fixture")
    }
    return (performance.now() - started) * 1_000
}

function measure(sample: () => number): readonly number[] {
    for (let index = 0; index < WARMUPS; index++) sample()
    return Array.from({ length: SAMPLES }, sample)
}

describe.sequential("WS-051 task runtime performance gate", () => {
    it("keeps every synchronous transition below the extension-host blocking budget", () => {
        for (let index = 0; index < WARMUPS; index++) transitionSample()
        const batches = Array.from({ length: SAMPLES }, transitionSample)
        const averageSamples = batches.map((sample) => sample.averageUs)
        const maxSamples = batches.map((sample) => sample.maxUs)
        const report = {
            averageP50: percentile(averageSamples, 0.5),
            averageP95: percentile(averageSamples, 0.95),
            averageSamples,
            maxP50: percentile(maxSamples, 0.5),
            maxP95: percentile(maxSamples, 0.95),
            max: Math.max(...maxSamples),
            maxSamples,
            extensionHostBlockingGateUs: EXTENSION_HOST_BLOCK_GATE_US,
            measurementBatches: SAMPLES,
            transitionsPerBatch: TRANSITION_FIXTURES.length,
            unit: "microseconds",
            warmupBatches: WARMUPS,
        }
        console.info("WS-051 candidate transition performance", JSON.stringify(report))
        expect(report.max).toBeLessThanOrEqual(EXTENSION_HOST_BLOCK_GATE_US)
    })

    it("hydrates the same dense 250-block fixture within twenty percent of legacy", () => {
        const snapshot = denseSnapshot()
        const samples = measure(() => hydrateSample(snapshot))
        const p50 = percentile(samples, 0.5)
        const p95 = percentile(samples, 0.95)
        console.info(
            "WS-051 candidate hydrate performance",
            JSON.stringify({
                unit: "microseconds",
                blocks: BLOCKS,
                warmupSamples: WARMUPS,
                measurementSamples: SAMPLES,
                baselineP95: LEGACY_HYDRATE_P95_US,
                limitP95: LEGACY_HYDRATE_P95_US * 1.2,
                samples,
                p50,
                p95,
            }),
        )
        expect(p95).toBeLessThanOrEqual(LEGACY_HYDRATE_P95_US * 1.2)
        expect(p95).toBeLessThanOrEqual(EXTENSION_HOST_BLOCK_GATE_US)
    })

    it("reports the dense 250-block serialized state as a diagnostic only", () => {
        const snapshot = denseSnapshot()
        const bytes = Buffer.byteLength(JSON.stringify(snapshot))
        console.info(
            "WS-051 candidate retained state",
            JSON.stringify({
                unit: "bytes",
                bytes,
                blocks: BLOCKS,
                legacyBytes: LEGACY_RETAINED_STATE_BYTES,
                diagnosticOnly: true,
                note: "AC verdict uses the complete reachable per-task runtime retained heap probe",
            }),
        )
        expect(bytes).toBeGreaterThan(0)
    })
})
