import { type RuntimeOperationHandle, runtimeOperationRegistry } from "@/services/telemetry/runtime/operation-registry"
import {
    emitSignal,
    isSignalRecordingEnabled,
    type ObservabilityAttributes,
    recordDurationHistogram,
    runWithSignalSpan,
    type SignalSpanHandle,
    startSignalSpan,
} from "@/services/telemetry/service/pipeline-port"
import { type TaskTraceSource, taskTraceSource } from "@/services/telemetry/service/task-trace-context"

export type ToolFailureStage = "validation" | "authorization" | "routing" | "execution" | "remote"

export interface ToolFailureObservation {
    readonly stage: ToolFailureStage
    readonly code: string
}

export interface ObservedToolResult {
    readonly failed?: boolean
    readonly failure?: ToolFailureObservation
}

export type ToolExecutionOutcome = "completed" | "failed" | "cancelled"
export type ToolCancellationReason = "abort_error" | "task_interrupted" | "unknown"

export interface ToolExecutionObservationOptions {
    readonly taskId: string
    readonly toolName: string
    readonly turnId: string
    readonly native: boolean
    readonly scope?: "task" | "subagent"
    readonly parent?: "task" | "ambient"
}

interface ProcessSnapshot {
    readonly cpu: NodeJS.CpuUsage
    readonly rssBytes: number
    readonly heapUsedBytes: number
}

/** One authoritative tool execution span, including bounded process-resource correlation. */
export class ToolExecutionObservation {
    private readonly startedAt = performance.now()
    private readonly resources = processSnapshot()
    private readonly task: TaskTraceSource | undefined
    private readonly parent: SignalSpanHandle | undefined
    private readonly span: SignalSpanHandle
    private terminal = false
    private readonly runtimeOperation: RuntimeOperationHandle

    constructor(private readonly options: ToolExecutionObservationOptions) {
        this.runtimeOperation = runtimeOperationRegistry.begin({
            kind: "tool",
            name: options.toolName,
            taskId: options.taskId,
        })
        this.task = taskTraceSource(options.taskId)
        this.parent = options.parent === "ambient" ? undefined : this.task?.currentSpan()
        this.span = startSignalSpan({
            name: "tool.execution",
            ...(options.parent === "ambient" ? {} : this.parent ? { parent: this.parent } : { root: true }),
            attributes: this.baseAttributes(),
        })
    }

    async run<T>(action: () => Promise<T>): Promise<T> {
        this.event("tool.execution.started", this.baseAttributes())
        try {
            const result = await runWithSignalSpan(this.span, action)
            const observed = observedToolResult(result)
            this.finish(observed.failed === true ? "failed" : "completed", observed.failure)
            return result
        } catch (error) {
            const cancellationReason = cancellationReasonFor(error)
            if (cancellationReason) this.finish("cancelled", undefined, undefined, cancellationReason)
            else this.finish("failed", { stage: "execution", code: "handler_exception" }, error)
            throw error
        }
    }

    private finish(
        outcome: ToolExecutionOutcome,
        failure?: ToolFailureObservation,
        error?: unknown,
        cancellationReason?: ToolCancellationReason,
    ): void {
        if (this.terminal) return
        this.terminal = true
        this.runtimeOperation.complete()
        let attributes: ObservabilityAttributes & { duration_ms: number }
        try {
            attributes = {
                ...this.baseAttributes(),
                ...resourceAttributes(this.startedAt, this.resources),
                tool_outcome: outcome,
                ...(failure ? { failure_stage: failure.stage, failure_code: failure.code } : {}),
                ...(outcome === "cancelled" ? { cancellation_reason: cancellationReason ?? "unknown" } : {}),
            }
        } catch {
            attributes = {
                tool_name: this.options.toolName,
                tool_native: this.options.native,
                tool_turn_available: this.options.turnId.length > 0,
                task_state_available: false,
                task_usage_available: false,
                duration_ms: Math.max(0, performance.now() - this.startedAt),
                tool_outcome: outcome,
                ...(outcome === "cancelled" ? { cancellation_reason: cancellationReason ?? "unknown" } : {}),
            }
        }
        this.safely(() => {
            if (error !== undefined) this.span.recordException(error)
            for (const [key, value] of Object.entries(attributes)) this.span.setAttribute(key, value)
            this.span.addEvent?.(`tool.execution.${outcome}`, attributes)
            this.event(`tool.execution.${outcome}`, attributes, error)
            if (isSignalRecordingEnabled())
                recordDurationHistogram(attributes.duration_ms, {
                    operation: "tool.execution",
                    tool: this.options.toolName,
                    outcome,
                    ...(failure ? { failure_stage: failure.stage, failure_code: failure.code } : {}),
                })
            this.task?.event(`task.tool.${outcome}`, attributes)
            this.span.end(outcome === "completed" ? "success" : outcome === "failed" ? "failure" : "cancelled")
        })
    }

    private event(name: string, attributes: ObservabilityAttributes, error?: unknown): void {
        this.safely(() => {
            if (!isSignalRecordingEnabled()) return
            runWithSignalSpan(this.span, () =>
                emitSignal({
                    name,
                    level: name.endsWith(".failed") ? "error" : "info",
                    attributes,
                    ...(error === undefined ? {} : { error }),
                    context: { taskId: this.options.taskId },
                }),
            )
        })
    }

    private baseAttributes(): ObservabilityAttributes {
        return {
            tool_name: this.options.toolName,
            tool_native: this.options.native,
            tool_turn_available: this.options.turnId.length > 0,
            tool_execution_scope: this.options.scope ?? "task",
            ...readTaskAttributes(this.task),
        }
    }

    private safely(action: () => void): void {
        try {
            action()
        } catch {
            /* Observability must never affect tool execution. */
        }
    }
}

function observedToolResult(value: unknown): ObservedToolResult {
    if (!value || typeof value !== "object") return {}
    const candidate = value as ObservedToolResult
    return {
        ...(candidate.failed === true ? { failed: true } : {}),
        ...(candidate.failure ? { failure: candidate.failure } : {}),
    }
}

function cancellationReasonFor(error: unknown): ToolCancellationReason | undefined {
    if (typeof error === "string" && /(?:abort|cancel|terminate)/i.test(error)) return "task_interrupted"
    if (!(error instanceof Error)) return undefined
    if (error.name === "AbortError" || error.name === "APIUserAbortError" || error.name === "CanceledError") return "abort_error"
    return /(?:aborted|cancelled|terminated)/i.test(error.message) ? "task_interrupted" : undefined
}

function processSnapshot(): ProcessSnapshot {
    const memory = process.memoryUsage()
    return { cpu: process.cpuUsage(), rssBytes: memory.rss, heapUsedBytes: memory.heapUsed }
}

function resourceAttributes(startedAt: number, started: ProcessSnapshot): ObservabilityAttributes & { duration_ms: number } {
    const ended = processSnapshot()
    const cpu = process.cpuUsage(started.cpu)
    return {
        duration_ms: Math.max(0, performance.now() - startedAt),
        process_cpu_user_ms: cpu.user / 1_000,
        process_cpu_system_ms: cpu.system / 1_000,
        process_rss_start_bytes: started.rssBytes,
        process_rss_end_bytes: ended.rssBytes,
        process_rss_delta_bytes: ended.rssBytes - started.rssBytes,
        process_heap_start_bytes: started.heapUsedBytes,
        process_heap_end_bytes: ended.heapUsedBytes,
        process_heap_delta_bytes: ended.heapUsedBytes - started.heapUsedBytes,
    }
}

function readTaskAttributes(task: TaskTraceSource | undefined): ObservabilityAttributes {
    try {
        return task?.attributes() ?? { task_state_available: false, task_usage_available: false }
    } catch {
        return { task_state_available: false, task_usage_available: false }
    }
}
