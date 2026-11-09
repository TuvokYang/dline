import type { ApiStreamUsageChunk } from "@core/api/transform/stream"
import { ApiUsageAccumulator, type NormalizedApiUsage } from "@core/api/transform/usage-accumulator"

export interface TaskRequestUsageSnapshot extends NormalizedApiUsage {
    thoughtsTokens?: number
    totalCost?: number
    currency?: string
    cacheUsageReported: boolean
}

/** Resolve all usage events for one Provider request into one persistence and telemetry snapshot. */
export class TaskRequestUsageTracker {
    private readonly accumulator = new ApiUsageAccumulator()
    private thoughtsTokens: number | undefined
    private totalCost: number | undefined
    private currency: string | undefined
    private cacheUsageReported = false

    apply(chunk: ApiStreamUsageChunk): TaskRequestUsageSnapshot {
        const { usage } = this.accumulator.apply(chunk)
        this.cacheUsageReported ||= chunk.cacheWriteTokens !== undefined || chunk.cacheReadTokens !== undefined
        if (typeof chunk.thoughtsTokenCount === "number" && Number.isFinite(chunk.thoughtsTokenCount)) {
            this.thoughtsTokens = Math.max(0, Math.floor(chunk.thoughtsTokenCount))
        }
        if (typeof chunk.totalCost === "number" && Number.isFinite(chunk.totalCost) && chunk.totalCost >= 0) {
            this.totalCost = chunk.usageMode === "delta" ? (this.totalCost ?? 0) + chunk.totalCost : chunk.totalCost
            this.currency = chunk.currency
        }
        return this.toSnapshot(usage)
    }

    getSnapshot(): TaskRequestUsageSnapshot {
        return this.toSnapshot(this.accumulator.getUsage())
    }

    private toSnapshot(usage: NormalizedApiUsage): TaskRequestUsageSnapshot {
        return {
            ...usage,
            ...(this.thoughtsTokens === undefined ? {} : { thoughtsTokens: this.thoughtsTokens }),
            ...(this.totalCost === undefined
                ? {}
                : { totalCost: this.totalCost, ...(this.currency ? { currency: this.currency } : {}) }),
            cacheUsageReported: this.cacheUsageReported,
        }
    }
}
