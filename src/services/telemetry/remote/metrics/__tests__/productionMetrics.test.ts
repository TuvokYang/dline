import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { JournalTelemetrySignal } from "../../../providers/capabilities"
import { encodeOtlpMetrics, type OtlpSpanInput } from "../../contracts/otlpProduction"
import { diagnosticOtlpResource } from "../../diagnostics/diagnosticRecord"
import { isMetricsWindow, ProductionMetricsWindow } from "../productionMetrics"

const FIXTURE = JSON.parse(
    readFileSync(
        path.join(__dirname, "..", "..", "contracts", "__tests__", "fixtures", "otlp-production-reference.json"),
        "utf8",
    ),
)
const EXAMPLE = FIXTURE.metrics.example
const RESOURCE_INPUT = FIXTURE.resource.input

const resource = (dropped = 0) =>
    diagnosticOtlpResource(
        {
            clientVersion: RESOURCE_INPUT.client_version,
            platform: RESOURCE_INPUT.platform,
            arch: RESOURCE_INPUT.arch,
            releaseChannel: RESOURCE_INPUT.release_channel,
            hostEditor: RESOURCE_INPUT.host_editor,
            isDev: RESOURCE_INPUT.is_dev,
        },
        dropped,
    )

function gauge(name: string, value: number): JournalTelemetrySignal {
    return { kind: "metric", channel: "runtime", severity: "info", instrument: "gauge", name, value }
}

function operation(input: {
    provider: string
    model: string
    role: string
    outcome: OtlpSpanInput["outcome"]
    duration_ms: number
    error_type?: string
}): OtlpSpanInput {
    return {
        name: "gen_ai.client.operation",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "53995c3f42cd8ad8",
        startMs: EXAMPLE.window_start_ms,
        endMs: EXAMPLE.window_start_ms + input.duration_ms,
        outcome: input.outcome,
        attributes: {
            "gen_ai.provider.name": input.provider,
            "gen_ai.request.model": input.model,
            "dline.role": input.role,
            ...(input.error_type ? { "error.type": input.error_type } : {}),
        },
    }
}

/** The fixture compares attribute lists as sets; every other array keeps its order. */
function sortAttributes(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortAttributes)
    if (typeof value !== "object" || value === null) return value
    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
            const sorted = sortAttributes(entry)
            return [
                key,
                key === "attributes" && Array.isArray(sorted)
                    ? [...sorted].sort((left, right) => String(left.key).localeCompare(String(right.key)))
                    : sorted,
            ]
        }),
    )
}

describe("ProductionMetricsWindow (TADR §7.2)", () => {
    it("freezes the fixture's window into the production metrics request", () => {
        const window = new ProductionMetricsWindow(EXAMPLE.window_start_ms)
        for (let index = 0; index < EXAMPLE.input.sessions_started; index++) window.recordSessionStarted()
        for (const delay of EXAMPLE.input.event_loop_delay_ms) window.observe(gauge("runtime.event_loop_delay_ms", delay))
        for (const input of EXAMPLE.input.operations) window.recordOperation(operation(input))

        const frozen = window.freeze(EXAMPLE.window_end_ms)

        expect(frozen && isMetricsWindow(frozen)).toBe(true)
        const body = encodeOtlpMetrics(resource(), frozen!, frozen!.points)
        expect(sortAttributes(body)).toEqual(sortAttributes(EXAMPLE.expected_body))
    })

    it("sends no instrument without data, and a window without any data freezes to nothing", () => {
        const window = new ProductionMetricsWindow(1_000)
        window.observe(gauge("runtime.rss_bytes", 5))
        window.observe({
            kind: "metric",
            channel: "runtime",
            severity: "info",
            instrument: "counter",
            name: "runtime.event_loop_delay_ms",
            value: 3,
        })
        window.recordDropped("traces", 0)

        expect(window.freeze(61_000)).toBeUndefined()
    })

    it("starts each window where the previous one ended, so deltas never overlap or repeat", () => {
        const window = new ProductionMetricsWindow(1_000)
        window.recordSessionStarted()
        const first = window.freeze(61_000)
        window.observe(gauge("runtime.heap_growth_bytes", 10))
        window.observe(gauge("runtime.heap_growth_bytes", 4))
        const second = window.freeze(121_000)

        expect(first).toMatchObject({ startMs: 1_000, endMs: 61_000, points: [{ name: "dline.session.started", value: 1 }] })
        expect(second).toEqual({
            startMs: 61_000,
            endMs: 121_000,
            points: [{ name: "dline.runtime.heap.growth", attributes: {}, value: 4 }],
        })
    })

    it("keeps outcomes apart and names the failure class only on a failure", () => {
        const window = new ProductionMetricsWindow(0)
        const base = { provider: "anthropic", model: "catalog:claude-sonnet-4-5", role: "task", duration_ms: 100 }
        window.recordOperation(operation({ ...base, outcome: "failure", error_type: "rate_limit" }))
        window.recordOperation(operation({ ...base, outcome: "cancelled", error_type: "rate_limit" }))
        window.recordOperation({ ...operation({ ...base, outcome: "success" }), name: "dline.task" })

        const points = window.freeze(60_000)?.points ?? []

        expect(points.map((point) => point.attributes)).toEqual([
            expect.objectContaining({ "dline.outcome": "failure", "error.type": "rate_limit" }),
            expect.not.objectContaining({ "error.type": expect.anything() }),
        ])
    })

    it("counts local drops per signal", () => {
        const window = new ProductionMetricsWindow(0)
        window.recordDropped("logs", 2)
        window.recordDropped("logs", 3)
        window.recordDropped("traces", 1)

        expect(window.freeze(60_000)?.points).toEqual([
            { name: "dline.telemetry.dropped.records", attributes: { "dline.signal": "logs" }, value: 5 },
            { name: "dline.telemetry.dropped.records", attributes: { "dline.signal": "traces" }, value: 1 },
        ])
    })
})
