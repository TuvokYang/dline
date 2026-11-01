import type { BillableTokens, UsageProfile } from "./types"

/** Token counts as reported by a provider response, before slot mapping. */
export interface RawUsage {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheWriteTokens?: number
    readonly cacheReadTokens?: number
    readonly thinkingTokens?: number
}

/**
 * Map raw token counts onto price slots.
 *
 * The three profiles differ only in whether `inputTokens` already includes the
 * cached counts. Anthropic reports uncached input separately, while OpenAI and
 * Qwen report it inclusive, so the inclusive profiles subtract the cached counts
 * to avoid billing cache reads twice.
 *
 * @param profile Token-counting convention of the provider response.
 * @param usage Raw counts from the response.
 * @returns Counts ready for `costOf`.
 */
export function billableTokens(profile: UsageProfile, usage: RawUsage): BillableTokens {
    const cacheWrite = usage.cacheWriteTokens ?? 0
    const cacheRead = usage.cacheReadTokens ?? 0
    const regularInput = profile === "anthropic" ? usage.inputTokens : Math.max(0, usage.inputTokens - cacheWrite - cacheRead)

    const thinking = usage.thinkingTokens ?? 0

    return {
        regularInput,
        // Reasoning tokens are reported as part of output by every provider this
        // project reads, so output is split rather than duplicated: the share
        // reported as thinking bills at the thinking price, the rest at the
        // output price. Adding thinking on top of a full output count would
        // charge the same tokens twice.
        output: Math.max(0, usage.outputTokens - thinking),
        cacheWrite,
        cacheRead,
        thinking,
    }
}
