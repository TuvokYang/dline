import { normalizeRuntimeError } from "@/services/telemetry/runtime/error-normalizer"
import { exceptionAttributes } from "@/services/telemetry/runtime/exception-attributes"
import {
    emitSignal,
    isSignalRecordingEnabled,
    type ObservabilityAttributes,
    recordDurationHistogram,
    runWithSignalSpan,
    type SignalLevel,
    type SignalSpanHandle,
    startSignalSpan,
} from "@/services/telemetry/service/pipeline-port"
import { taskTraceSource } from "@/services/telemetry/service/task-trace-context"

export type McpCallStage = "lookup" | "configuration" | "transport" | "remote"

interface McpCallObservationOptions {
    readonly taskId: string
    readonly argumentCount: number
}

/** One content-free MCP SDK call span nested under the current tool execution. */
export class McpCallObservation {
    private readonly startedAt = performance.now()
    private readonly task
    private readonly span: SignalSpanHandle
    private stage: McpCallStage = "lookup"

    constructor(private readonly options: McpCallObservationOptions) {
        this.task = taskTraceSource(options.taskId)
        // The tool observer runs the handler in its active context, so omitting an
        // explicit parent makes this the real tool child rather than its sibling.
        this.span = startSignalSpan({ name: "mcp.tools.call", attributes: this.attributes("started") })
    }

    setStage(stage: McpCallStage): void {
        this.stage = stage
        this.safely(() => this.span.addEvent?.("mcp.tools.call.stage", { mcp_stage: stage }))
    }

    async run<T extends { readonly isError?: boolean }>(action: () => Promise<T>): Promise<T> {
        this.event("mcp.tools.call.started", this.attributes("started"))
        try {
            const result = await runWithSignalSpan(this.span, action)
            if (result.isError) this.finish("failed", undefined, "remote_tool_error")
            else this.finish("completed")
            return result
        } catch (error) {
            const normalized = normalizeRuntimeError(error)
            this.finish("failed", error, normalized.code ?? `${this.stage}_error`)
            throw error
        }
    }

    private finish(outcome: "completed" | "failed", error?: unknown, code?: string): void {
        const durationMs = Math.max(0, performance.now() - this.startedAt)
        const normalized = error === undefined ? undefined : normalizeRuntimeError(error)
        const attributes = {
            ...this.attributes(outcome),
            duration_ms: durationMs,
            ...(code ? { failure_code: code } : {}),
            ...(normalized ? exceptionAttributes(normalized) : {}),
        }
        this.safely(() => {
            if (error !== undefined) this.span.recordException(error)
            for (const [key, value] of Object.entries(attributes)) this.span.setAttribute(key, value)
            this.span.addEvent?.(`mcp.tools.call.${outcome}`, attributes)
            this.event(
                `mcp.tools.call.${outcome}`,
                attributes,
                error,
                outcome === "failed" && error === undefined && code === "remote_tool_error" ? "info" : undefined,
            )
            if (isSignalRecordingEnabled()) {
                recordDurationHistogram(durationMs, {
                    operation: "mcp.tools.call",
                    outcome,
                    mcp_stage: this.stage,
                    ...(code ? { failure_code: code } : {}),
                })
            }
            this.task?.event(`task.mcp.${outcome}`, attributes)
            this.span.end(outcome === "completed" ? "success" : "failure")
        })
    }

    private attributes(outcome: "started" | "completed" | "failed"): ObservabilityAttributes {
        return {
            mcp_stage: this.stage,
            mcp_argument_count: this.options.argumentCount,
            mcp_outcome: outcome,
        }
    }

    private event(name: string, attributes: ObservabilityAttributes, error?: unknown, level?: SignalLevel): void {
        if (!isSignalRecordingEnabled()) return
        this.safely(() =>
            runWithSignalSpan(this.span, () =>
                emitSignal({
                    name,
                    level: level ?? (name.endsWith(".failed") ? "error" : "info"),
                    attributes,
                    ...(error === undefined ? {} : { error }),
                    context: { taskId: this.options.taskId },
                }),
            ),
        )
    }

    private safely(action: () => void): void {
        try {
            action()
        } catch {
            /* Observability must never affect MCP execution. */
        }
    }
}
