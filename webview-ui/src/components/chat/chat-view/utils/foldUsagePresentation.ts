import { type FoldUsage, formatDuration, formatTokens } from "@shared/chat/foldUsage"
import type { UiTranslator } from "@/i18n/messages"

/** Localized display of shared usage facts; retain their existing precision and unit formatting. */
export function describeLocalizedFoldUsage(usage: FoldUsage, t: UiTranslator): string {
    const approximate = usage.usageQuality === "exact" ? "" : "~"
    const parts: string[] = []
    if (usage.durationMs > 0) parts.push(`${approximate}${formatDuration(usage.durationMs)}`)
    if (usage.inputTokens + usage.outputTokens > 0) {
        parts.push(
            `${approximate}${t("chatInput.fold.usageTokens", {
                input: formatTokens(usage.inputTokens),
                output: formatTokens(usage.outputTokens),
            })}`,
        )
    }
    if (usage.averageTokensPerSecond !== undefined && Number.isFinite(usage.averageTokensPerSecond)) {
        parts.push(`${approximate}${Math.round(usage.averageTokensPerSecond)} tok/s`)
    }
    return parts.join(" · ")
}
