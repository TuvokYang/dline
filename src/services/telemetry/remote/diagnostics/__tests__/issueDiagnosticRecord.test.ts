import { describe, expect, it } from "vitest"
import { encodeIssueDiagnosticBatch, type IssueDiagnosticItem } from "../issueDiagnosticRecord"

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"

function span(spanId: string, outcome: "success" | "failure" | "cancelled", parentSpanId?: string): IssueDiagnosticItem {
    return {
        stream: "traces",
        name: "tool.execution",
        traceId: TRACE_ID,
        spanId,
        ...(parentSpanId ? { parentSpanId } : {}),
        startAt: 1_792_800_000_000,
        endAt: 1_792_800_001_000,
        outcome,
        attributes: { tool_name: "read_file" },
        events: [],
    }
}

describe("encodeIssueDiagnosticBatch", () => {
    it("encodes ids as OTLP/JSON hex and maps outcomes to the production status codes", () => {
        const body = JSON.parse(
            encodeIssueDiagnosticBatch(
                [
                    span("00f067aa0ba902b7", "success"),
                    span("53995c3f42cd8ad8", "failure", "00f067aa0ba902b7"),
                    span("1b5e0a1c2d3e4f50", "cancelled"),
                ],
                { clientVersion: "0.12.0", platform: "win32", arch: "x64" },
            ),
        )
        const [resourceSpans] = body.resourceSpans
        const [scopeSpans] = resourceSpans.scopeSpans

        expect(
            scopeSpans.spans.map((entry: Record<string, unknown>) => [
                entry.traceId,
                entry.spanId,
                entry.parentSpanId,
                entry.status,
            ]),
        ).toEqual([
            [TRACE_ID, "00f067aa0ba902b7", undefined, { code: 0 }],
            [TRACE_ID, "53995c3f42cd8ad8", "00f067aa0ba902b7", { code: 2 }],
            [TRACE_ID, "1b5e0a1c2d3e4f50", undefined, { code: 0 }],
        ])
        expect(scopeSpans.scope).toEqual({ name: "dline.issue-overlay", version: "1" })
        const resource = Object.fromEntries(
            resourceSpans.resource.attributes.map((attribute: { key: string; value: { stringValue?: string } }) => [
                attribute.key,
                attribute.value.stringValue,
            ]),
        )
        expect(resource).toMatchObject({ "os.type": "windows", "host.arch": "amd64", "dline.capture_scope": "issue" })
        expect(resource).not.toHaveProperty("dline.dropped_records")
    })
})
