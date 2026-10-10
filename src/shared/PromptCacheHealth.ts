export type PromptCacheHealthStatus = "disabled" | "waiting" | "warming" | "healthy" | "warning"

export type PromptCacheWarningReason = "cache_not_improving" | "near_context_low_hit_rate"

export type PromptCacheHealthResetReason = "profile_changed" | "compaction_completed"

export interface PromptCacheHealthSnapshot {
    readonly status: PromptCacheHealthStatus
    readonly sampleCount: number
    readonly warmingRound: number
    readonly warmingTarget: number
    readonly hitRate?: number
    readonly cacheReadTokens?: number
    readonly promptTokens?: number
    readonly nearContextWindow: boolean
    readonly warningReason?: PromptCacheWarningReason
}
