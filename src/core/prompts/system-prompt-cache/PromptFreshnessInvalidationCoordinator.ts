import { Logger } from "@shared/services/Logger"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"

export type PromptFreshnessInvalidationSource =
    | "prompt_input_file"
    | "task_capability_toggle"
    | "capability_mutation"
    | "remote_config"
    | "mcp_registry"
    | "profile_catalog"
    | "settings"

export interface PromptFreshnessInvalidationCoordinatorDeps {
    readonly taskId?: string
    readonly reevaluate: () => Promise<void>
    readonly publishState: () => Promise<void>
    readonly debounceMs?: number
}

/** Coalesce prompt-input changes into ordered, Task-local freshness projections. */
export class PromptFreshnessInvalidationCoordinator {
    private readonly taskId: string
    private readonly reevaluate: () => Promise<void>
    private readonly publishState: () => Promise<void>
    private readonly debounceMs: number
    private debounceTimer?: NodeJS.Timeout
    private runPromise?: Promise<void>
    private pending = false
    private disposed = false
    private pendingInvalidationCount = 0
    private readonly pendingSources = new Set<PromptFreshnessInvalidationSource>()

    constructor(deps: PromptFreshnessInvalidationCoordinatorDeps) {
        this.taskId = deps.taskId ?? "unknown"
        this.reevaluate = deps.reevaluate
        this.publishState = deps.publishState
        this.debounceMs = deps.debounceMs ?? 200
    }

    /** Schedule a debounced freshness projection for a non-durable external signal. */
    invalidate(source: PromptFreshnessInvalidationSource): void {
        if (this.disposed) return
        this.pending = true
        this.pendingInvalidationCount++
        this.pendingSources.add(source)
        if (this.debounceTimer) clearTimeout(this.debounceTimer)
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined
            void this.run().catch((error) => {
                Logger.error("[PromptFreshness] Failed to process invalidation:", error)
            })
        }, this.debounceMs)
    }

    /** Run and await all currently pending freshness projections. */
    flush(source: PromptFreshnessInvalidationSource): Promise<void> {
        if (this.disposed) return Promise.resolve()
        this.pending = true
        this.pendingInvalidationCount++
        this.pendingSources.add(source)
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer)
            this.debounceTimer = undefined
        }
        return this.run()
    }

    dispose(): void {
        this.disposed = true
        this.pending = false
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer)
            this.debounceTimer = undefined
        }
    }

    private run(): Promise<void> {
        if (this.runPromise) return this.runPromise
        const run = this.drain()
        this.runPromise = run.finally(() => {
            if (this.runPromise === run || this.runPromise === settled) this.runPromise = undefined
        })
        const settled = this.runPromise
        return settled
    }

    private async drain(): Promise<void> {
        while (this.pending && !this.disposed) {
            this.pending = false
            const invalidationCount = this.pendingInvalidationCount
            this.pendingInvalidationCount = 0
            const sources = [...this.pendingSources].sort()
            this.pendingSources.clear()
            const startedAt = performance.now()
            await this.reevaluate()
            const reevaluateMs = Math.round(performance.now() - startedAt)
            if (this.disposed) return
            const publishStartedAt = performance.now()
            await this.publishState()
            const publishMs = Math.round(performance.now() - publishStartedAt)
            recordPerfPhase(
                PerfDomain.PromptFreshness,
                "drain_complete",
                performance.now() - startedAt,
                {
                    invalidations: invalidationCount,
                    sources: sources.join(",") || "none",
                    reevaluateMs,
                    publishMs,
                    pendingAgain: this.pending,
                },
                { taskId: this.taskId },
            )
            if (Logger.isDebugEnabled()) {
                Logger.debug(
                    `[PromptFreshnessPerf] phase=drain_complete taskId=${this.taskId} invalidations=${invalidationCount} sources=${sources.join(",") || "none"} reevaluateMs=${reevaluateMs} publishMs=${publishMs} totalMs=${Math.round(performance.now() - startedAt)} pendingAgain=${this.pending}`,
                )
            }
        }
    }
}
