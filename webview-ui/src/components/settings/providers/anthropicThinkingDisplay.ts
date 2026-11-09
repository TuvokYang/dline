import type { UiTranslator } from "@/i18n/messages"

/**
 * Selector options for the Anthropic `thinking.display` request field.
 *
 * "None" is a UI-only choice that stores no value, so the field is omitted from the
 * request and the API default applies. The remaining entries mirror the values the
 * Messages API accepts.
 */
export const anthropicThinkingDisplayOptions = (t: UiTranslator) =>
    [
        { value: "none", label: t("settings.ui.none") },
        { value: "summarized", label: t("settings.ui.anthropic.summarized") },
        { value: "omitted", label: t("settings.ui.anthropic.omitted") },
    ] as const
