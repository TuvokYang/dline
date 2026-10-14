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
import type { SubagentExecResult } from "../tools/subagent/SubagentExecutor"

/** Observes the real subagent run, including background and retry continuations. */
export class SubagentRunObservation {
    private readonly startedAt = performance.now()
    private readonly span: SignalSpanHandle
    private terminal = false
    private readonly runtimeOperation: RuntimeOperationHandle

    constructor(timeoutSeconds: number) {
        this.runtimeOperation = runtimeOperationRegistry.begin({
            kind: "subagent",
            name: "subagent.run",
        })
        this.span = startSignalSpan({
            name: "subagent.run",
            attributes: {
                subagent_timeout_enabled: timeoutSeconds > 0,
                ...(timeoutSeconds > 0 ? { subagent_timeout_seconds: timeoutSeconds } : {}),
            },
        })
    }

    async run(action: () => Promise<SubagentExecResult>): Promise<SubagentExecResult> {
        this.event("subagent.run.started", { subagent_outcome: "started" })
        try {
            const result = await runWithSignalSpan(this.span, action)
            this.finish(result)
            return result
        } catch (error) {
            this.finishException(error)
            throw error
        }
    }

    private finish(result: SubagentExecResult): void {
        if (this.terminal) return
        this.terminal = true
        this.runtimeOperation.complete()
        const durationMs = Math.max(0, performance.now() - this.startedAt)
        const attributes: ObservabilityAttributes = {
            subagent_outcome: result.status,
            subagent_retryable: result.retryable === true,
            subagent_tool_calls: result.stats.toolCalls,
            subagent_input_tokens: result.stats.inputTokens,
            subagent_output_tokens: result.stats.outputTokens,
            subagent_cache_write_tokens: result.stats.cacheWriteTokens,
            subagent_cache_read_tokens: result.stats.cacheReadTokens,
            subagent_context_tokens: result.stats.contextTokens,
            subagent_context_window: result.stats.contextWindow,
            duration_ms: durationMs,
        }
        this.complete(result.status, attributes)
    }

    private finishException(error: unknown): void {
        if (this.terminal) return
        this.terminal = true
        this.runtimeOperation.complete()
        const durationMs = Math.max(0, performance.now() - this.startedAt)
        const attributes: ObservabilityAttributes = { subagent_outcome: "failed", duration_ms: durationMs }
        this.safely(() => this.span.recordException(error))
        this.complete("failed", attributes, error)
    }

    private complete(outcome: SubagentExecResult["status"], attributes: ObservabilityAttributes, error?: unknown): void {
        this.safely(() => {
            for (const [key, value] of Object.entries(attributes)) this.span.setAttribute(key, value)
            this.span.addEvent?.(`subagent.run.${outcome}`, attributes)
            this.event(`subagent.run.${outcome}`, attributes, error)
            if (isSignalRecordingEnabled()) {
                recordDurationHistogram(Number(attributes.duration_ms ?? 0), {
                    operation: "subagent.run",
                    outcome,
                })
            }
            this.span.end(outcome === "completed" ? "success" : outcome === "cancelled" ? "cancelled" : "failure")
        })
    }

    private event(name: string, attributes: ObservabilityAttributes, error?: unknown): void {
        if (!isSignalRecordingEnabled()) return
        this.safely(() =>
            runWithSignalSpan(this.span, () =>
                emitSignal({
                    name,
                    level: name.endsWith(".failed") || name.endsWith(".timeout") ? "error" : "info",
                    attributes,
                    ...(error === undefined ? {} : { error }),
                    ...(this.span.taskId ? { context: { taskId: this.span.taskId } } : {}),
                }),
            ),
        )
    }

    private safely(action: () => void): void {
        try {
            action()
        } catch {
            // Observability must never alter subagent execution.
        }
    }
}
