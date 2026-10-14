import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node"
import { afterEach, describe, expect, it } from "vitest"
import { McpCallObservation } from "@/services/mcp/mcp-call-observation"
import { OpenTelemetryTraceProvider } from "@/services/telemetry/providers/opentelemetry/OpenTelemetryTraceProvider"
import {
    configureSignalRecording,
    installObservabilityPipeline,
    resetSignalRecording,
} from "@/services/telemetry/service/pipeline-port"
import { createRunningTaskState } from "../kernel/__fixtures__/task-state"
import { TaskTurnTelemetry } from "./task-turn-telemetry"
import { ToolExecutionObservation } from "./tool-execution-observation"

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
    for (const action of cleanup.splice(0).reverse()) await action()
    installObservabilityPipeline(undefined)
    resetSignalRecording()
})

function setupTraceExporter(): { exporter: InMemorySpanExporter; provider: OpenTelemetryTraceProvider } {
    const exporter = new InMemorySpanExporter()
    const provider = new OpenTelemetryTraceProvider("http://127.0.0.1:4318", {
        processor: new SimpleSpanProcessor(exporter),
    })
    configureSignalRecording({ enabled: () => true })
    installObservabilityPipeline({
        startSpan: (options) => provider.startSpan(options),
        recordGauge: () => {},
        recordHistogram: () => {},
    })
    cleanup.push(() => provider.dispose())
    return { exporter, provider }
}

describe("ToolExecutionObservation", () => {
    it("nests tool and MCP spans under the production task turn and records bounded resources", async () => {
        const { exporter, provider } = setupTraceExporter()
        const state = createRunningTaskState({ taskId: "task-1", turnId: "turn-1", revision: 1 })
        const task = new TaskTurnTelemetry(
            "task-1",
            () => state,
            () => ({ cacheUsageAvailable: false }),
        )
        cleanup.push(() => task.dispose())
        task.committed("runtime.state.committed", state)

        const tool = new ToolExecutionObservation({
            taskId: "task-1",
            toolName: "use_mcp_tool",
            turnId: "turn-1",
            native: true,
        })
        await tool.run(async () => {
            const mcp = new McpCallObservation({ taskId: "task-1", argumentCount: 1 })
            mcp.setStage("transport")
            return mcp
                .run(async () => ({ content: [], isError: true }))
                .then(() => ({
                    failed: true,
                    failure: { stage: "remote" as const, code: "remote_tool_error" },
                }))
        })

        task.dispose()
        await provider.forceFlush()
        const spans = exporter.getFinishedSpans()
        const taskSpan = spans.find((span) => span.name === "task.turn")
        const toolSpan = spans.find((span) => span.name === "tool.execution")
        const mcpSpan = spans.find((span) => span.name === "mcp.tools.call")

        expect(toolSpan?.parentSpanId).toBe(taskSpan?.spanContext().spanId)
        expect(mcpSpan?.parentSpanId).toBe(toolSpan?.spanContext().spanId)
        expect(toolSpan?.attributes).toMatchObject({
            outcome: "failure",
            tool_outcome: "failed",
            failure_stage: "remote",
            failure_code: "remote_tool_error",
            tool_name: "use_mcp_tool",
            tool_native: true,
        })
        expect(typeof toolSpan?.attributes.process_cpu_user_ms).toBe("number")
        expect(typeof toolSpan?.attributes.process_rss_end_bytes).toBe("number")
        expect(mcpSpan?.attributes).toMatchObject({
            outcome: "failure",
            mcp_outcome: "failed",
            mcp_stage: "transport",
            failure_code: "remote_tool_error",
        })
    })

    it("records an aborted tool as cancelled exactly once", async () => {
        const { exporter, provider } = setupTraceExporter()
        const tool = new ToolExecutionObservation({
            taskId: "task-cancelled",
            toolName: "execute_command",
            turnId: "turn-cancelled",
            native: false,
        })
        const error = Object.assign(new Error("private"), { name: "AbortError" })

        await expect(
            tool.run(async () => {
                throw error
            }),
        ).rejects.toBe(error)
        await provider.forceFlush()

        const [span] = exporter.getFinishedSpans().filter((candidate) => candidate.name === "tool.execution")
        expect(span?.attributes).toMatchObject({
            outcome: "cancelled",
            tool_outcome: "cancelled",
            cancellation_reason: "abort_error",
        })
        expect(span?.events.filter((event) => event.name === "tool.execution.cancelled")).toHaveLength(1)
    })
})
