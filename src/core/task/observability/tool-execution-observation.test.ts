import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node"
import { afterEach, describe, expect, it } from "vitest"
import { McpCallObservation } from "@/services/mcp/mcp-call-observation"
import { OpenTelemetryTraceProvider } from "@/services/telemetry/providers/opentelemetry/OpenTelemetryTraceProvider"
import {
    configureSignalRecording,
    installObservabilityPipeline,
    installSignalPipeline,
    resetSignalRecording,
    type TelemetrySignal,
} from "@/services/telemetry/service/pipeline-port"
import { InteractionCancellationError } from "../interaction/InteractionCancellationError"
import { createRunningTaskState } from "../kernel/__fixtures__/task-state"
import { normalizeObservedToolExecutionResult } from "../tools/ToolExecutionResult"
import { TaskTurnTelemetry } from "./task-turn-telemetry"
import { ToolExecutionObservation } from "./tool-execution-observation"

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
    for (const action of cleanup.splice(0).reverse()) await action()
    installObservabilityPipeline(undefined)
    installSignalPipeline(undefined)
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
    it("marks structured handler failures before an observer reads the result", () => {
        expect(
            normalizeObservedToolExecutionResult({
                response: "invalid patch",
                failure: { stage: "validation", code: "invalid_patch" },
            }),
        ).toEqual({
            response: "invalid patch",
            failure: { stage: "validation", code: "invalid_patch" },
            failed: true,
        })
    })

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

    it("keeps expected validation and remote-result failures below the remote error floor", async () => {
        setupTraceExporter()
        const signals: TelemetrySignal[] = []
        installSignalPipeline({ accept: (signal) => signals.push(signal) })

        const validation = new ToolExecutionObservation({
            taskId: "task-validation",
            toolName: "apply_patch",
            turnId: "turn-validation",
            native: true,
        })
        await validation.run(async () => ({
            failed: true,
            failure: { stage: "validation" as const, code: "invalid_patch" },
        }))
        const mcp = new McpCallObservation({ taskId: "task-validation", argumentCount: 1 })
        mcp.setStage("remote")
        await mcp.run(async () => ({ content: [], isError: true }))

        expect(
            signals
                .filter((signal) => signal.name === "tool.execution.failed" || signal.name === "mcp.tools.call.failed")
                .map((signal) => [signal.name, signal.level]),
        ).toEqual([
            ["tool.execution.failed", "info"],
            ["mcp.tools.call.failed", "info"],
        ])
    })

    it("records a withdrawn interaction as cancelled without a failed event", async () => {
        const { exporter, provider } = setupTraceExporter()
        const tool = new ToolExecutionObservation({
            taskId: "task-interrupted",
            toolName: "attempt_completion",
            turnId: "turn-interrupted",
            native: true,
        })
        const error = new InteractionCancellationError("task_terminated")

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
            cancellation_reason: "task_interrupted",
        })
        expect(span?.events.some((event) => event.name === "tool.execution.failed")).toBe(false)
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
