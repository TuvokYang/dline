import type { ApiStreamUsageChunk } from "@core/api/transform/stream"
import { ApiUsageAccumulator, type NormalizedApiUsage } from "@core/api/transform/usage-accumulator"

export interface TaskRequestUsageSnapshot extends NormalizedApiUsage {
    thoughtsTokens?: number
    totalCost?: number
    cacheUsageReported: boolean
}

/** Resolve all usage events for one Provider request into one persistence and telemetry snapshot. */
export class TaskRequestUsageTracker {
    private readonly accumulator = new ApiUsageAccumulator()
    private thoughtsTokens: number | undefined
    private totalCost: number | undefined
    private cacheUsageReported = false

    apply(chunk: ApiStreamUsageChunk): TaskRequestUsageSnapshot {
        const { usage } = this.accumulator.apply(chunk)
        this.cacheUsageReported ||= chunk.cacheWriteTokens !== undefined || chunk.cacheReadTokens !== undefined
        if (typeof chunk.thoughtsTokenCount === "number" && Number.isFinite(chunk.thoughtsTokenCount)) {
            this.thoughtsTokens = Math.max(0, Math.floor(chunk.thoughtsTokenCount))
        }
        if (typeof chunk.totalCost === "number" && Number.isFinite(chunk.totalCost)) {
            this.totalCost = Math.max(0, chunk.totalCost)
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
            ...(this.totalCost === undefined ? {} : { totalCost: this.totalCost }),
            cacheUsageReported: this.cacheUsageReported,
        }
    }
}
