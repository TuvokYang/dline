import type { ApiConfiguration } from "@shared/api"
import type { ApiProfile } from "@shared/proto/dline/profile"
import type { Mode } from "@shared/storage/types"
import { normalizeCurrencyCode } from "@/utils/currency"

/**
 * Resolve the active API profile for the current chat mode.
 *
 * @param profiles Available API profiles loaded from storage.
 * @param apiConfiguration Current API configuration containing mode profile names.
 * @param mode Current chat mode.
 * @returns The profile currently selected for the mode, or undefined.
 */
export function resolveActiveProfile(
    profiles: ApiProfile[],
    apiConfiguration: ApiConfiguration | undefined,
    mode: Mode,
): ApiProfile | undefined {
    const profileName = mode === "plan" ? apiConfiguration?.planModeProfile : apiConfiguration?.actModeProfile
    const namedProfile = profileName ? profiles.find((profile) => profile.name === profileName) : undefined

    return namedProfile ?? profiles.find((profile) => profile.enabled && profile.usedFor?.includes(mode)) ?? profiles[0]
}

/**
 * Resolve the billing currency of the current task.
 *
 * Both inputs originate from `ModelInfo.pricing.currency`: API metrics record the
 * model that produced the cost, and the active profile's model covers a task
 * that has not reported metrics yet.
 */
export function resolveTaskCurrency(apiCurrency: string | undefined, profileCurrency: string | undefined): string {
    return normalizeCurrencyCode(apiCurrency?.trim() || profileCurrency)
}
