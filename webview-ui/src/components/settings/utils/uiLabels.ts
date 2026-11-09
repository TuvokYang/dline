import type { UiTranslator } from "@/i18n/messages"

/** Keep original effort labels in every UI language without changing protocol identifiers. */
export function formatReasoningEffort(t: UiTranslator, effort: string): string {
    switch (effort) {
        case "none":
            return t("settings.ui.effort.none")
        case "minimal":
            return t("settings.ui.effort.minimal")
        case "low":
            return t("settings.ui.effort.low")
        case "medium":
            return t("settings.ui.effort.medium")
        case "high":
            return t("settings.ui.effort.high")
        case "max":
            return t("settings.ui.effort.max")
        case "xhigh":
            return t("settings.ui.effort.xhigh")
        case "auto":
            return t("settings.ui.effort.auto")
        case "off":
            return t("settings.ui.effort.off")
        default:
            return effort.charAt(0).toUpperCase() + effort.slice(1)
    }
}
