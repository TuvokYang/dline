import type { TelemetryProperties } from "../providers/ITelemetryProvider"
import { MAX_ERROR_MESSAGE_LENGTH, TELEMETRY_EVENTS, TELEMETRY_METRICS } from "./catalog"
import { DomainRecorder } from "./domain-recorder"

/** Execution states a hook passes through. */
export type HookExecutionStatus = "started" | "completed" | "failed" | "cancelled"

/** Optional detail describing one hook execution. */
export interface HookExecutionMetadata {
    source?: "global" | "workspace"
    toolName?: string
    durationMs?: number
    exitCode?: number
    errorType?: "timeout" | "execution" | "validation"
    errorMessage?: string
    cancelRequested?: boolean
    contextModified?: boolean
    contextSize?: number
}

/**
 * Hook discovery and execution telemetry.
 *
 * One event covers every status so a hook's life can be reconstructed by
 * filtering on `status` rather than joining differently named events. The
 * metrics differ by status because "how many started" and "how long they took"
 * are not the same question.
 */
export class HookEventRecorder extends DomainRecorder {
    /**
     * Records hook discovery cache access (hit or miss)
     * @param hookName The type of hook being accessed
     * @param cacheHit Whether the cache had the result (true) or miss (false)
     */
    captureHookCacheAccess(hookName: string, cacheHit: boolean): void {
        if (!this.sink.isCategoryEnabled("hooks")) {
            return
        }

        // Recorded as an attribute rather than two metrics so the hit rate is
        // hits / (hits + misses) on a single series.
        this.sink.recordCounter(TELEMETRY_METRICS.HOOKS.CACHE_ACCESSES_TOTAL, 1, {
            hookName,
            cacheHit: cacheHit.toString(),
        })
    }

    /**
     * Records hook execution events with a unified status-based approach.
     *
     * @param ulid Task identifier
     * @param hookName Type of hook (PreToolUse, PostToolUse, etc.)
     * @param status Current execution status
     * @param metadata Optional execution metadata
     */
    captureHookExecution(ulid: string, hookName: string, status: HookExecutionStatus, metadata?: HookExecutionMetadata): void {
        if (!this.sink.isCategoryEnabled("hooks")) {
            return
        }

        const properties: TelemetryProperties = {
            ulid,
            hookName,
            status,
            timestamp: new Date().toISOString(),
            ...(metadata?.source && { source: metadata.source }),
            ...(metadata?.toolName && { toolName: metadata.toolName }),
            ...(metadata?.durationMs !== undefined && { durationMs: metadata.durationMs }),
            ...(metadata?.exitCode !== undefined && { exitCode: metadata.exitCode }),
            ...(metadata?.errorType && { errorType: metadata.errorType }),
            ...(metadata?.errorMessage && {
                errorMessage: metadata.errorMessage.substring(0, MAX_ERROR_MESSAGE_LENGTH),
            }),
            ...(metadata?.cancelRequested !== undefined && { cancelRequested: metadata.cancelRequested }),
            ...(metadata?.contextModified !== undefined && { contextModified: metadata.contextModified }),
            ...(metadata?.contextSize !== undefined && { contextSize: metadata.contextSize }),
        }

        this.sink.captureEvent(TELEMETRY_EVENTS.HOOKS.EXECUTION, properties)

        const hookAttributes = {
            ulid,
            hookName,
            status,
            ...(metadata?.source && { source: metadata.source }),
            ...(metadata?.toolName && { toolName: metadata.toolName }),
        }

        if (status === "started") {
            this.sink.recordCounter(TELEMETRY_METRICS.HOOKS.EXECUTIONS_TOTAL, 1, hookAttributes)
            return
        }

        if (status === "completed") {
            if (metadata?.durationMs !== undefined) {
                this.sink.recordHistogram(TELEMETRY_METRICS.HOOKS.DURATION_SECONDS, metadata.durationMs / 1000, hookAttributes)
            }
            if (metadata?.cancelRequested) {
                this.sink.recordCounter(TELEMETRY_METRICS.HOOKS.CANCELLATIONS_TOTAL, 1, hookAttributes)
            }
            if (metadata?.contextModified) {
                this.sink.recordCounter(TELEMETRY_METRICS.HOOKS.CONTEXT_MODIFICATIONS_TOTAL, 1, hookAttributes)
            }
            return
        }

        if (status === "failed") {
            this.sink.recordCounter(TELEMETRY_METRICS.HOOKS.FAILURES_TOTAL, 1, {
                ...hookAttributes,
                errorType: metadata?.errorType || "unknown",
            })
            return
        }

        this.sink.recordCounter(TELEMETRY_METRICS.HOOKS.CANCELLATIONS_TOTAL, 1, hookAttributes)
    }

    /**
     * Records hook discovery results.
     *
     * @param hookName The type of hook being discovered
     * @param globalCount Number of global hooks found
     * @param workspaceCount Number of workspace-specific hooks found
     */
    captureHookDiscovery(hookName: string, globalCount: number, workspaceCount: number): void {
        if (!this.sink.isCategoryEnabled("hooks")) {
            return
        }

        this.sink.captureEvent(TELEMETRY_EVENTS.HOOKS.DISCOVERY_COMPLETED, {
            hookName,
            globalCount,
            workspaceCount,
            totalCount: globalCount + workspaceCount,
            timestamp: new Date().toISOString(),
        })
    }
}
