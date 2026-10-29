import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { TelemetrySpanHandle } from "../../../providers/capabilities"
import { encodeOtlpTraces, type OtlpSpanInput } from "../../contracts/otlpProduction"
import { diagnosticOtlpResource } from "../../diagnostics/diagnosticRecord"
import { isOtlpSpanInput, ProductionSpanRecorder } from "../productionSpans"

const FIXTURE = JSON.parse(
    readFileSync(
        path.join(__dirname, "..", "..", "contracts", "__tests__", "fixtures", "otlp-production-reference.json"),
        "utf8",
    ),
)
const EXAMPLE = FIXTURE.traces.example
const [TASK, SEND, TOOL] = EXAMPLE.input
const RESOURCE_INPUT = FIXTURE.resource.input

const resource = () =>
    diagnosticOtlpResource(
        {
            clientVersion: RESOURCE_INPUT.client_version,
            platform: RESOURCE_INPUT.platform,
            arch: RESOURCE_INPUT.arch,
            releaseChannel: RESOURCE_INPUT.release_channel,
            hostEditor: RESOURCE_INPUT.host_editor,
            isDev: RESOURCE_INPUT.is_dev,
        },
        0,
    )

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

function recorder(enabled = () => true) {
    const published: OtlpSpanInput[] = []
    return { published, spans: new ProductionSpanRecorder({ enabled, publish: (span) => published.push(span), clock: () => 0 }) }
}

const context = (spanId: string) => ({ traceId: TASK.trace_id, spanId, traceFlags: 1 })

describe("ProductionSpanRecorder (TADR §5.3)", () => {
    it("exports the fixture's task, send and tool spans, linking each to its nearest cataloged ancestor", () => {
        const { published, spans } = recorder()
        const task = spans.start({ name: "task.turn", spanContext: context(TASK.span_id), startTime: TASK.start_ms })
        // A local-only span between the task and the send; the send must still name the task as parent.
        const request = spans.start({ name: "api.request", parent: task, spanContext: context("aaaaaaaaaaaaaaaa") })
        const send = spans.start({
            name: "gen_ai.client.operation",
            parent: request,
            spanContext: context(SEND.span_id),
            startTime: SEND.start_ms,
            attributes: {
                ...SEND.attributes,
                "error.type": undefined,
                "gen_ai.provider.name": "Anthropic",
                "dline.task_id": "task-must-not-leave",
            },
        })
        send.setAttribute("error.type", SEND.attributes["error.type"])
        send.end("failure", SEND.end_ms)
        request.end("failure", SEND.end_ms)
        const tool = spans.start({
            name: "tool.execution",
            parent: task,
            spanContext: context(TOOL.span_id),
            startTime: TOOL.start_ms,
            attributes: { tool_name: "read_file", tool_native: true },
        })
        tool.end("success", TOOL.end_ms)
        task.end("success", TASK.end_ms)

        const body = encodeOtlpTraces(resource(), published)

        expect(published.map((span) => span.name)).toEqual(["gen_ai.client.operation", "dline.tool.execute", "dline.task"])
        expect(published.every(isOtlpSpanInput)).toBe(true)
        expect(sortAttributes(body)).toEqual(sortAttributes(EXAMPLE.expected_body))
    })

    it("gives every span one identity and hands it to the companion destination", () => {
        const { spans } = recorder()
        const seen: string[] = []
        const companion = (identity: { spanId: string }): TelemetrySpanHandle => {
            seen.push(identity.spanId)
            return { active: true, setAttribute: () => undefined, recordException: () => undefined, end: () => undefined }
        }

        const root = spans.start({ name: "task.turn" }, companion)
        const child = spans.start({ name: "api.request", parent: root }, companion)

        expect(seen).toEqual([root.spanContext?.spanId, child.spanContext?.spanId])
        expect(child.spanContext?.traceId).toBe(root.spanContext?.traceId)
        expect(root.spanContext?.spanId).toMatch(/^[0-9a-f]{16}$/)
    })

    it("keeps only Dline's own tool names and drops the failure stage of a success", () => {
        const { published, spans } = recorder()
        spans
            .start({ name: "tool.execution", attributes: { tool_name: "my_mcp_server_tool", failure_stage: "remote" } })
            .end("success")
        const failed = spans.start({ name: "tool.execution", attributes: { tool_name: "read_file", failure_stage: "execution" } })
        failed.recordException(new TypeError("boom at C:\\work"))
        failed.end("failure")

        expect(published.map((span) => span.attributes)).toEqual([
            {},
            { "tool.name": "read_file", "failure.stage": "execution", "error.type": "TypeError" },
        ])
    })

    it("names the error type of a failed task and of no other task outcome", () => {
        const { published, spans } = recorder()
        const failed = spans.start({ name: "task.turn" })
        failed.recordException(new RangeError("context window exceeded"))
        failed.end("failure")
        const cancelled = spans.start({ name: "subagent.run" })
        cancelled.recordException(new Error("aborted"))
        cancelled.end("cancelled")

        expect(published.map(({ name, outcome, attributes }) => ({ name, outcome, attributes }))).toEqual([
            { name: "dline.task", outcome: "failure", attributes: { "dline.role": "task", "error.type": "RangeError" } },
            { name: "dline.task", outcome: "cancelled", attributes: { "dline.role": "subagent" } },
        ])
    })

    it("publishes nothing for a span outside the catalog or while reporting is not allowed", () => {
        let allowed = false
        const { published, spans } = recorder(() => allowed)
        spans.start({ name: "task.turn" }).end("success")
        allowed = true
        spans.start({ name: "checkpoint.commit" }).end("success")
        const subagent = spans.start({ name: "subagent.run" })
        subagent.end("cancelled")
        subagent.end("failure")

        expect(published).toEqual([
            expect.objectContaining({ name: "dline.task", outcome: "cancelled", attributes: { "dline.role": "subagent" } }),
        ])
    })
})
