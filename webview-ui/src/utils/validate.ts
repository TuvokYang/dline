import { ApiConfiguration } from "@shared/api"
import { Mode } from "@shared/storage/types"
import type { ApiProfile } from "@/components/settings/providers/ProviderProfile"

/**
 * Validate that a profile is configured for the given mode.
 * Profile-driven: checks profile.apiKey existence.
 */
export function validateApiConfiguration(
    currentMode: Mode,
    _apiConfiguration?: ApiConfiguration,
    profiles?: ApiProfile[],
): string | undefined {
    if (!profiles || profiles.length === 0) {
        return undefined
    }

    const matchingProfile = profiles.find((p) => p.enabled && p.usedFor.includes(currentMode))
    if (!matchingProfile) {
        return `No enabled profile found for ${currentMode} mode.`
    }

    if (!matchingProfile.apiKey) {
        return "You must provide a valid API key or choose a different provider."
    }

    return undefined
}
