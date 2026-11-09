import type {
    ProviderAttemptAdapterIdentity,
    ProviderAttemptObserver,
    ProviderTelemetryRole,
} from "@shared/provider-attempt-observer"
import type { ApiRequestRoundUsage } from "@/core/task/performance/api-request-round-types"
import type { UsageToolCall } from "@/core/task/telemetry/UsageToolCalls"
import type { ObservabilityAttributes, SignalSpanHandle } from "./pipeline-port"

export interface ProviderAttemptScopeInput {
    readonly role: ProviderTelemetryRole
    readonly logicalRequestId?: string
    readonly taskAttempt: number
    readonly adapter?: ProviderAttemptAdapterIdentity
}

export interface ProviderAttemptUsageInput extends ProviderAttemptScopeInput {
    readonly usage: ApiRequestRoundUsage
}

/** Read-only bridge to a live Task's authoritative state/usage owners, not another state store. */
export interface TaskTraceSource {
    currentSpan(): SignalSpanHandle | undefined
    attributes(): ObservabilityAttributes
    event(name: string, attributes?: ObservabilityAttributes): void
    failure(error: unknown, attributes?: ObservabilityAttributes, expectedSpan?: SignalSpanHandle): void
    /** Create the observer for one ApiHandler invocation; callers never receive Usage storage or policy dependencies. */
    providerAttemptObserver?(input: ProviderAttemptScopeInput): ProviderAttemptObserver | undefined
    /** Attach normalized exact usage to the attempt observed for this semantic request. */
    providerAttemptUsage?(input: ProviderAttemptUsageInput): void
    /** Terminal the logical request after its instrumented ApiHandler stream closes. */
    providerRequestCompleted?(input: ProviderAttemptScopeInput): void
    /**
     * Settle one subagent logical request with the tools it asked for. The
     * Provider stream only produced the calls; the caller executed them.
     *
     * This carries no usage: the send's tokens were already reported by the
     * attempt observer, and only the tool outcomes arrive this late.
     */
    providerLogicalToolsSettled?(input: ProviderAttemptScopeInput, toolCalls: readonly UsageToolCall[]): void
    /** The subagent stream asked for no tool, so deferral is over and the request ends here. */
    providerLogicalToolsExpected?(input: ProviderAttemptScopeInput): void
}

const sources = new Map<string, TaskTraceSource>()

/** Registration lifetime belongs to the Task; cleanup cannot evict a newer owner of the same identity. */
export function registerTaskTraceSource(taskId: string, source: TaskTraceSource): () => void {
    sources.set(taskId, source)
    return () => {
        if (sources.get(taskId) === source) sources.delete(taskId)
    }
}

export function taskTraceSource(taskId: string | undefined): TaskTraceSource | undefined {
    return taskId ? sources.get(taskId) : undefined
}
