export interface ApiRateSnapshot {
    activeSeconds?: number
    requestsPerMinute?: number
    tokensPerMinute?: number
    rpmBasis?: "execution_duration" | "provider_duration" | "legacy_active_seconds" | "unavailable"
    executionCount?: number
    executionDurationMs?: number
    providerRoundCount?: number
    totalTokensIn?: number
    totalTokensOut?: number
    totalCacheWrites?: number
    totalCacheReads?: number
    totalCost?: number
    cacheHitRate?: number
    cacheUsageAvailable?: boolean
    currency?: string
}

interface ApiRateSample {
    estimatedTokens: number
    exactTokens?: number
}

interface ApiRateTrackerOptions {
    now?: () => number
    onChanged?: () => void
}

const MILLISECONDS_PER_SECOND = 1_000
const SECONDS_PER_MINUTE = 60

/** Tracks per-minute request and token rates extrapolated from API-active seconds for one Task. */
export class ApiRateTracker {
    private readonly now: () => number
    private readonly onChanged?: () => void
    private readonly samples: ApiRateSample[] = []
    private activeSecondCount = 0
    private lastActiveSecond: number | undefined

    constructor(options: ApiRateTrackerOptions = {}) {
        this.now = options.now ?? Date.now
        this.onChanged = options.onChanged
    }

    recordRequestStarted(): void {
        this.samples.push({ estimatedTokens: 0 })
        this.recordActiveSecond()
        this.onChanged?.()
    }

    recordEstimatedTokens(tokens: number): void {
        if (!Number.isFinite(tokens) || tokens <= 0) return
        const sample = this.samples.at(-1)
        if (!sample) return
        sample.estimatedTokens += Math.round(tokens)
        this.recordActiveSecond()
        this.onChanged?.()
    }

    recordExactTokens(tokens: number): void {
        if (!Number.isFinite(tokens) || tokens < 0) return
        const sample = this.samples.at(-1)
        if (!sample) return
        sample.exactTokens = Math.round(tokens)
        this.recordActiveSecond()
        this.onChanged?.()
    }

    getSnapshot(): ApiRateSnapshot {
        if (this.activeSecondCount === 0) return {}

        const tokenCount = this.samples.reduce((total, sample) => total + (sample.exactTokens ?? sample.estimatedTokens), 0)
        return {
            requestsPerMinute: this.extrapolatePerMinute(this.samples.length, this.activeSecondCount),
            tokensPerMinute: this.extrapolatePerMinute(tokenCount, this.activeSecondCount),
        }
    }

    dispose(): void {
        this.samples.length = 0
        this.activeSecondCount = 0
        this.lastActiveSecond = undefined
    }

    private recordActiveSecond(): void {
        const activeSecond = Math.floor(this.now() / MILLISECONDS_PER_SECOND)
        if (activeSecond === this.lastActiveSecond) return
        this.lastActiveSecond = activeSecond
        this.activeSecondCount += 1
    }

    private extrapolatePerMinute(value: number, activeSecondCount: number): number {
        return Math.round((value * SECONDS_PER_MINUTE) / activeSecondCount)
    }
}
