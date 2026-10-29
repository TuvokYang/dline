import type { ApiStreamUsageChunk } from "./stream"

export interface NormalizedApiUsage {
    inputTokens: number
    outputTokens: number
    cacheWriteTokens: number
    cacheReadTokens: number
}

export interface AppliedApiUsage {
    usage: NormalizedApiUsage
    delta: NormalizedApiUsage
}

const EMPTY_USAGE: NormalizedApiUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
}

/** Resolve mixed Provider usage snapshots and explicit deltas into one request total. */
export class ApiUsageAccumulator {
    private usage: NormalizedApiUsage = { ...EMPTY_USAGE }
    private receivedExplicitDelta = false

    apply(chunk: ApiStreamUsageChunk): AppliedApiUsage {
        const before = this.getUsage()
        const next = normalizeUsage(chunk)
        if (chunk.usageMode === "delta") {
            this.receivedExplicitDelta = true
            this.usage = addUsage(this.usage, next)
        } else if (this.receivedExplicitDelta && next.inputTokens > 0) {
            this.receivedExplicitDelta = false
            this.usage = {
                inputTokens: next.inputTokens,
                outputTokens: next.outputTokens,
                cacheWriteTokens: chunk.cacheWriteTokens === undefined ? before.cacheWriteTokens : next.cacheWriteTokens,
                cacheReadTokens: chunk.cacheReadTokens === undefined ? before.cacheReadTokens : next.cacheReadTokens,
            }
        } else {
            this.usage = {
                inputTokens: Math.max(before.inputTokens, next.inputTokens),
                outputTokens: Math.max(before.outputTokens, next.outputTokens),
                cacheWriteTokens: Math.max(before.cacheWriteTokens, next.cacheWriteTokens),
                cacheReadTokens: Math.max(before.cacheReadTokens, next.cacheReadTokens),
            }
        }
        return { usage: this.getUsage(), delta: subtractUsage(this.usage, before) }
    }

    getUsage(): NormalizedApiUsage {
        return { ...this.usage }
    }
}

function normalizeUsage(chunk: ApiStreamUsageChunk): NormalizedApiUsage {
    return {
        inputTokens: normalizeTokens(chunk.inputTokens),
        outputTokens: normalizeTokens(chunk.outputTokens),
        cacheWriteTokens: normalizeTokens(chunk.cacheWriteTokens),
        cacheReadTokens: normalizeTokens(chunk.cacheReadTokens),
    }
}

function addUsage(left: NormalizedApiUsage, right: NormalizedApiUsage): NormalizedApiUsage {
    return {
        inputTokens: left.inputTokens + right.inputTokens,
        outputTokens: left.outputTokens + right.outputTokens,
        cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
        cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    }
}

function subtractUsage(next: NormalizedApiUsage, previous: NormalizedApiUsage): NormalizedApiUsage {
    return {
        inputTokens: Math.max(0, next.inputTokens - previous.inputTokens),
        outputTokens: Math.max(0, next.outputTokens - previous.outputTokens),
        cacheWriteTokens: Math.max(0, next.cacheWriteTokens - previous.cacheWriteTokens),
        cacheReadTokens: Math.max(0, next.cacheReadTokens - previous.cacheReadTokens),
    }
}

function normalizeTokens(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
