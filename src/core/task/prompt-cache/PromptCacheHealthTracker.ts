import type { PromptCacheHealthResetReason, PromptCacheHealthSnapshot } from "@shared/PromptCacheHealth"
import { PromptCacheHealthMonitor, type PromptCacheObservation } from "./PromptCacheHealthMonitor"

export interface PromptCacheHealthLogger {
    debug(message: string): void
    warn(message: string): void
}

export interface PromptCacheRequestResult extends PromptCacheObservation {
    readonly completed: boolean
    readonly isCompactionRequest: boolean
}

/** Adapt completed Task requests to the pure prompt cache health monitor. */
export class PromptCacheHealthTracker {
    private readonly monitor = new PromptCacheHealthMonitor()

    constructor(
        private readonly taskId: string,
        private readonly logger: PromptCacheHealthLogger,
    ) {}

    /** Record one completed request when it is eligible for Task cache diagnostics. */
    recordRequest(request: PromptCacheRequestResult): boolean {
        if (!request.completed || request.isCompactionRequest) {
            return false
        }

        const result = this.monitor.observe(request)
        if (!result.isEligibleSample) {
            return false
        }

        const snapshot = result.snapshot
        this.logger.debug(
            `[Task ${this.taskId}] Prompt cache health: status=${snapshot.status} sample=${snapshot.sampleCount} hitRate=${snapshot.hitRate ?? 0} cacheRead=${snapshot.cacheReadTokens ?? 0} promptTokens=${snapshot.promptTokens ?? 0} nearContext=${snapshot.nearContextWindow}`,
        )
        if (result.enteredWarning) {
            this.logger.warn(
                `[Task ${this.taskId}] Prompt cache warning: reason=${result.enteredWarning} hitRate=${snapshot.hitRate ?? 0} cacheRead=${snapshot.cacheReadTokens ?? 0} promptTokens=${snapshot.promptTokens ?? 0} nearContext=${snapshot.nearContextWindow}`,
            )
        }
        return true
    }

    /** Reset after a confirmed profile or compaction boundary. */
    reset(reason: PromptCacheHealthResetReason): boolean {
        this.monitor.reset(reason)
        this.logger.debug(`[Task ${this.taskId}] Prompt cache health reset: reason=${reason}`)
        return true
    }

    /** Reset only when compaction was durably applied. */
    recordCompactionResult(completed: boolean): boolean {
        return completed ? this.reset("compaction_completed") : false
    }

    /** Return the current immutable state projection. */
    getSnapshot(): PromptCacheHealthSnapshot {
        return this.monitor.getSnapshot()
    }
}
