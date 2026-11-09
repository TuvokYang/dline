import { ApiConfiguration } from "@shared/api"
import { Mode } from "@shared/storage/types"
import type { ApiProfile } from "@/components/settings/providers/ProviderProfile"
import { englishUiTranslator, type UiTranslator } from "@/i18n/messages"

/**
 * Validate that a profile is configured for the given mode.
 * Profile-driven: checks profile.apiKey existence.
 */
export function validateApiConfiguration(
    currentMode: Mode,
    _apiConfiguration?: ApiConfiguration,
    profiles?: ApiProfile[],
    t: UiTranslator = englishUiTranslator,
): string | undefined {
    if (!profiles || profiles.length === 0) {
        return undefined
    }

    const matchingProfile = profiles.find((p) => p.enabled && p.usedFor.includes(currentMode))
    if (!matchingProfile) {
        return t("runtime.validation.noProfile", { mode: currentMode })
    }

    if (!matchingProfile.apiKey) {
        return t("runtime.validation.apiKey")
    }

    return undefined
}
