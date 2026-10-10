import type { ApiProfile } from "@shared/proto/dline/profile"
import { isOpenAiServiceTier, normalizeOpenAiServiceTier, type OpenAiServiceTier } from "@shared/storage/types"

export type TaskServiceTierOverride = { readonly kind: "inherit" } | { readonly kind: "tier"; readonly tier: OpenAiServiceTier }

export interface TaskServiceTierOverrideFields {
    readonly kind?: string
    readonly tier?: string
}

export type TaskServiceTierOverrideError = "unsupported_provider" | "invalid_tier"

export type TaskServiceTierOverrideValidation =
    | { readonly valid: true; readonly override: TaskServiceTierOverride }
    | {
          readonly valid: false
          readonly error: TaskServiceTierOverrideError
          readonly message: string
      }

export function taskServiceTierOverrideFromFields(fields: TaskServiceTierOverrideFields): TaskServiceTierOverride | undefined {
    const kind = fields.kind?.trim()
    if (kind === "inherit") return { kind }
    if (kind !== "tier") return undefined

    const tier = normalizeOpenAiServiceTier(fields.tier)
    return tier ? { kind, tier } : undefined
}

export function taskServiceTierOverrideToFields(override: TaskServiceTierOverride | undefined): TaskServiceTierOverrideFields {
    if (!override || override.kind === "inherit") {
        return { kind: undefined, tier: undefined }
    }
    return { kind: "tier", tier: override.tier }
}

/** Whether one Profile exposes Service Tier configuration and Task-local overrides. */
export function profileServiceTierEnabled(profile: ApiProfile | undefined): boolean {
    if (profile?.provider === "openai") return profile.openai?.serviceTierEnabled === true
    if (profile?.provider === "openai-codex") {
        return profile.openaiCodex !== undefined && profile.openaiCodex.serviceTierEnabled !== false
    }
    return false
}

/** Read the Profile-owned OpenAI service tier for display and inheritance. */
export function resolveProfileServiceTier(profile: ApiProfile | undefined): OpenAiServiceTier | undefined {
    if (!profile || !profileServiceTierEnabled(profile)) return undefined
    const configuredTier = profile.provider === "openai" ? profile.openai?.serviceTier : profile.openaiCodex?.serviceTier
    return normalizeOpenAiServiceTier(configuredTier)
}

export function validateTaskServiceTierOverride(
    override: TaskServiceTierOverride,
    provider: string,
): TaskServiceTierOverrideValidation {
    if (override.kind === "inherit") {
        return { valid: true, override: { kind: "inherit" } }
    }

    if (provider !== "openai" && provider !== "openai-codex") {
        return {
            valid: false,
            error: "unsupported_provider",
            message: `Service tier is not supported by provider '${provider}'.`,
        }
    }

    if (!isOpenAiServiceTier(override.tier)) {
        return {
            valid: false,
            error: "invalid_tier",
            message: `Service tier '${String(override.tier)}' is not supported.`,
        }
    }

    return { valid: true, override: { kind: "tier", tier: override.tier } }
}

/** Apply a Task-local service tier to a runtime-only Profile clone. */
export function applyTaskServiceTierOverride(profile: ApiProfile, override: TaskServiceTierOverride): ApiProfile {
    const providerKey = profile.provider === "openai" ? "openai" : profile.provider === "openai-codex" ? "openaiCodex" : undefined
    if (!providerKey) {
        if (override.kind === "inherit") return { ...profile }
        throw new Error(`Provider '${profile.provider}' does not support a Task service tier override.`)
    }

    const providerConfig = profile[providerKey]
    if (!providerConfig) {
        if (override.kind === "inherit") return { ...profile }
        throw new Error(`Provider '${profile.provider}' has no configuration for a Task service tier override.`)
    }

    return {
        ...profile,
        [providerKey]: {
            ...providerConfig,
            ...(override.kind === "tier" ? { serviceTier: override.tier } : {}),
        },
    } as ApiProfile
}
