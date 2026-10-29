import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node"
import { afterEach, describe, expect, it } from "vitest"
import { OpenTelemetryTraceProvider } from "@/services/telemetry/providers/opentelemetry/OpenTelemetryTraceProvider"
import {
    configureSignalRecording,
    installObservabilityPipeline,
    resetSignalRecording,
    runWithSignalSpan,
} from "@/services/telemetry/service/pipeline-port"
import { createRunningTaskState } from "../kernel/__fixtures__/task-state"
import type { SubagentExecResult } from "../tools/subagent/SubagentExecutor"
import { SubagentRunObservation } from "./subagent-run-observation"
import { TaskTurnTelemetry } from "./task-turn-telemetry"
import { ToolExecutionObservation } from "./tool-execution-observation"

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
    for (const action of cleanup.splice(0).reverse()) await action()
    installObservabilityPipeline(undefined)
    resetSignalRecording()
})

function setup(): InMemorySpanExporter {
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
    return exporter
}

function result(status: SubagentExecResult["status"]): SubagentExecResult {
    return {
        status,
        retryable: status !== "completed",
        stats: {
            toolCalls: 3,
            inputTokens: 10,
            outputTokens: 5,
            cacheWriteTokens: 2,
            cacheReadTokens: 1,
            totalCost: 0,
            currency: "USD",
            contextTokens: 18,
            contextWindow: 1_000,
            contextUsagePercentage: 1.8,
        },
    }
}

describe("SubagentRunObservation", () => {
    it("records the real subagent run under the active task turn", async () => {
        const exporter = setup()
        const state = createRunningTaskState({ taskId: "task-subagent", turnId: "turn-1", revision: 1 })
        const task = new TaskTurnTelemetry(
            "task-subagent",
            () => state,
            () => ({ cacheUsageAvailable: false }),
        )
        cleanup.push(() => task.dispose())
        task.committed("runtime.state.committed", state)

        await runWithSignalSpan(task.currentSpan()!, async () => {
            const observation = new SubagentRunObservation(30)
            await expect(
                observation.run(async () => {
                    const tool = new ToolExecutionObservation({
                        taskId: "task-subagent",
                        toolName: "read_file",
                        turnId: "",
                        native: false,
                        scope: "subagent",
                        parent: "ambient",
                    })
                    await tool.run(async () => ({ failed: false }))
                    return result("cancelled")
                }),
            ).resolves.toMatchObject({ status: "cancelled" })
        })
        task.dispose()

        const spans = exporter.getFinishedSpans()
        const taskSpan = spans.find((span) => span.name === "task.turn")
        const subagentSpan = spans.find((span) => span.name === "subagent.run")
        const toolSpan = spans.find((span) => span.name === "tool.execution")
        expect(subagentSpan?.parentSpanId).toBe(taskSpan?.spanContext().spanId)
        expect(toolSpan?.parentSpanId).toBe(subagentSpan?.spanContext().spanId)
        expect(toolSpan?.attributes.tool_execution_scope).toBe("subagent")
        expect(subagentSpan?.attributes).toMatchObject({
            outcome: "cancelled",
            subagent_outcome: "cancelled",
            subagent_retryable: true,
            subagent_tool_calls: 3,
            subagent_timeout_seconds: 30,
        })
        expect(subagentSpan?.events.map((event) => event.name)).toContain("subagent.run.cancelled")
    })
})
