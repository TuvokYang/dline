import type { ApiProfile } from "@shared/proto/dline/profile"
import { translateUi, type UiTranslator } from "@/i18n/messages"

export type ProfileDisplayState =
    | { kind: "loading"; text: string }
    | { kind: "load_error"; text: string; detail: string }
    | { kind: "selected"; text: string; profile: ApiProfile }
    | { kind: "select"; reason: "deleted" | "missing" | "invalid" | "unselected"; text: string; detail?: string }
    | { kind: "create"; text: string }

export interface ResolveProfileDisplayStateInput {
    profiles: readonly ApiProfile[]
    loaded: boolean
    error?: Error
    profileId?: string
    profileName?: string
}

/** Projects Catalog and binding state into one explicit task-header display state. */
export function resolveProfileDisplayState(
    { profiles, loaded, error, profileId, profileName }: ResolveProfileDisplayStateInput,
    t: UiTranslator = (key, ...args) => translateUi("en", key, ...args),
): ProfileDisplayState {
    if (!loaded) {
        return error
            ? { kind: "load_error", text: t("chatInput.profile.unavailable"), detail: error.message }
            : { kind: "loading", text: t("chatInput.profile.loading") }
    }

    if (profiles.length === 0) {
        return { kind: "create", text: t("chatInput.profile.create") }
    }

    if (profileId) {
        const profile = profiles.find((candidate) => candidate.id === profileId)
        if (!profile)
            return { kind: "select", reason: "deleted", text: t("chatInput.profile.select"), detail: profileName || profileId }
        if (profile.enabled === false) {
            return { kind: "select", reason: "invalid", text: t("chatInput.profile.select"), detail: profile.name || profileId }
        }
        return { kind: "selected", text: profile.name || `${profile.provider}:${profile.modelId}`, profile }
    }

    if (profileName) {
        const currentNameMatches = profiles.filter((profile) => profile.name === profileName)
        if (currentNameMatches.length === 1) {
            const profile = currentNameMatches[0]
            return profile.enabled === false
                ? { kind: "select", reason: "invalid", text: t("chatInput.profile.select"), detail: profile.name }
                : { kind: "selected", text: profile.name || `${profile.provider}:${profile.modelId}`, profile }
        }
        if (currentNameMatches.length === 0) {
            const historicalNameMatches = profiles.filter((profile) => (profile.legacyNames ?? []).includes(profileName))
            if (historicalNameMatches.length === 1) {
                const profile = historicalNameMatches[0]
                return profile.enabled === false
                    ? { kind: "select", reason: "invalid", text: t("chatInput.profile.select"), detail: profile.name }
                    : { kind: "selected", text: profile.name || `${profile.provider}:${profile.modelId}`, profile }
            }
        }
        return { kind: "select", reason: "missing", text: t("chatInput.profile.select"), detail: profileName }
    }

    return { kind: "select", reason: "unselected", text: t("chatInput.profile.select") }
}
