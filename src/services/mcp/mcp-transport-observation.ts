import { normalizeRuntimeError } from "@/services/telemetry/runtime/error-normalizer"
import { exceptionAttributes } from "@/services/telemetry/runtime/exception-attributes"
import { emitSignal, isSignalRecordingEnabled } from "@/services/telemetry/service/pipeline-port"

export type McpTransportClassification = "expected" | "transient" | "exhausted"
export type McpTransportOutcome =
    | "stale"
    | "skipped_disabled"
    | "skipped_connecting"
    | "superseded"
    | "scheduled"
    | "retry_failed"
    | "recovered"
    | "exhausted"

export interface McpTransportLifecycleEvent {
    readonly transport: "stdio" | "sse" | "streamableHttp"
    readonly classification: McpTransportClassification
    readonly outcome: McpTransportOutcome
    readonly attempt?: number
    readonly maxAttempts?: number
    readonly delayMs?: number
    readonly error?: unknown
}

export interface McpTransportObserver {
    record(event: McpTransportLifecycleEvent): void
}

function eventName(outcome: McpTransportOutcome): string {
    if (outcome === "recovered") return "mcp.transport.reconnected"
    if (outcome === "retry_failed") return "mcp.transport.reconnect_failed"
    if (outcome === "exhausted") return "mcp.transport.reconnect_exhausted"
    if (outcome.startsWith("skipped") || outcome === "stale" || outcome === "superseded") return "mcp.transport.ignored"
    return "mcp.transport.interrupted"
}

/** Records content-free persistent MCP transport lifecycle, separate from one tool call. */
export const mcpTransportObserver: McpTransportObserver = {
    record(event): void {
        if (!isSignalRecordingEnabled()) return
        const normalized = event.error === undefined ? undefined : normalizeRuntimeError(event.error)
        emitSignal({
            name: eventName(event.outcome),
            level: event.classification === "exhausted" ? "error" : event.classification === "expected" ? "debug" : "info",
            attributes: {
                component: "mcp",
                operation: "connect",
                mcp_transport: event.transport,
                mcp_transport_class: event.classification,
                reconnect_outcome: event.outcome,
                ...(event.attempt === undefined ? {} : { reconnect_attempt: event.attempt }),
                ...(event.maxAttempts === undefined ? {} : { reconnect_max_attempts: event.maxAttempts }),
                ...(event.delayMs === undefined ? {} : { delay_ms: event.delayMs }),
                ...(normalized ? exceptionAttributes(normalized) : {}),
            },
            ...(event.classification === "exhausted" && event.error !== undefined ? { error: event.error } : {}),
        })
    },
}
