/**
 * Resolve the saved credentials for a provider.
 *
 * Discovery is normally driven by the settings form, which supplies its own
 * unsaved values. This fallback covers the compatibility handlers that still
 * refresh from whatever profile is already configured.
 *
 * `findEnabledProfiles` lives under the controller tree but is a plain profile
 * query with no entry-point behaviour, so reading it here keeps the credential
 * lookup in one place instead of repeating it per vendor.
 */
import { findEnabledProfiles } from "@core/controller/file/getApiProfiles"
import * as SecretsManager from "@core/storage/secrets"
import type { ProviderRemoteContext } from "./model-source"

export function resolveSavedCredentials(providerId: string): ProviderRemoteContext {
    for (const profile of findEnabledProfiles(providerId)) {
        const apiKey = SecretsManager.getApiKey(profile.id)
        if (apiKey) {
            return { apiKey, baseUrl: profile.baseUrl || undefined }
        }
    }

    const [firstProfile] = findEnabledProfiles(providerId)
    return { baseUrl: firstProfile?.baseUrl || undefined }
}
