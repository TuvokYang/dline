import type { ApiProfile } from "@shared/proto/dline/profile"
import { PROFILE_PROVIDER_KEYS } from "@shared/providers/profile-model-info"

/**
 * Whether a Profile serves a custom model: exactly when the user switched its
 * provider config to a free-form model ID. That switch is "Use custom model ID",
 * or for Bedrock the "Custom" model entry, which takes an inference profile ARN.
 *
 * Telemetry names the model by its ID either way and marks it custom only when the
 * switch is on, whatever endpoint serves it, whichever provider hosts it, and
 * whether or not the built-in catalog lists it. A switch stored under another
 * provider's config does not count, because that config is not the one this
 * Profile sends with.
 */
export function isCustomModel(profile: ApiProfile): boolean {
    if (profile.provider === "bedrock") return profile.bedrock?.awsBedrockCustomSelected === true
    const providerKey = PROFILE_PROVIDER_KEYS[profile.provider]
    const config: unknown = providerKey ? profile[providerKey] : undefined
    if (typeof config !== "object" || config === null) return false
    return (config as { customModelEnabled?: unknown }).customModelEnabled === true
}
