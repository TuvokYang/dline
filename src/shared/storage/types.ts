export const GENERIC_REASONING_EFFORT_OPTIONS = ["none", "low", "medium", "high", "xhigh"] as const

/** Efforts currently typed by the official OpenAI SDK. */
export const OPENAI_REASONING_EFFORT_OPTIONS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

/** OpenAI-compatible endpoints may expose an additional ultra tier. */
export const OPENAI_COMPATIBLE_REASONING_EFFORT_OPTIONS = [...OPENAI_REASONING_EFFORT_OPTIONS, "ultra"] as const

export type OpenaiReasoningEffort = (typeof OPENAI_COMPATIBLE_REASONING_EFFORT_OPTIONS)[number]

export function isOpenaiReasoningEffort(value: unknown): value is OpenaiReasoningEffort {
    return typeof value === "string" && OPENAI_COMPATIBLE_REASONING_EFFORT_OPTIONS.includes(value as OpenaiReasoningEffort)
}

export function normalizeOpenaiReasoningEffort(effort?: string): OpenaiReasoningEffort {
    const value = (effort || "medium").toLowerCase()
    return isOpenaiReasoningEffort(value) ? value : "medium"
}

export const OPENAI_SERVICE_TIER_OPTIONS = ["auto", "default", "flex", "scale", "priority", "ultrafast"] as const

export type OpenAiServiceTier = (typeof OPENAI_SERVICE_TIER_OPTIONS)[number]

export function isOpenAiServiceTier(value: unknown): value is OpenAiServiceTier {
    return typeof value === "string" && OPENAI_SERVICE_TIER_OPTIONS.includes(value as OpenAiServiceTier)
}

export function normalizeOpenAiServiceTier(value?: string): OpenAiServiceTier | undefined {
    return isOpenAiServiceTier(value) ? value : undefined
}

export type Mode = "plan" | "act"

export interface BlobStoreSettings {
    bucket: string
    adapterType: "s3" | "r2" | "azure" | string
    accessKeyId: string
    secretAccessKey: string
    region?: string
    endpoint?: string
    accountId?: string

    /** Interval between sync attempts in milliseconds (default: 30000 = 30s) */
    intervalMs?: number
    /** Maximum number of retries before giving up on an item (default: 5) */
    maxRetries?: number
    /** Batch size - how many items to process per interval (default: 10) */
    batchSize?: number
    /** Maximum queue size before eviction (default: 1000) */
    maxQueueSize?: number
    /** Maximum age for failed items in milliseconds (default: 7 days) */
    maxFailedAgeMs?: number
    /** Whether to backfill existing unsynced items on startup (default: false) */
    backfillEnabled?: boolean
}
