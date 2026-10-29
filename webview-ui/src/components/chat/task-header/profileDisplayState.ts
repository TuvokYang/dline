import type { ApiProfile } from "@shared/proto/dline/profile"

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
export function resolveProfileDisplayState({
    profiles,
    loaded,
    error,
    profileId,
    profileName,
}: ResolveProfileDisplayStateInput): ProfileDisplayState {
    if (!loaded) {
        return error
            ? { kind: "load_error", text: "Profiles unavailable", detail: error.message }
            : { kind: "loading", text: "Loading profiles…" }
    }

    if (profiles.length === 0) {
        return { kind: "create", text: "Create profile" }
    }

    if (profileId) {
        const profile = profiles.find((candidate) => candidate.id === profileId)
        if (!profile) return { kind: "select", reason: "deleted", text: "Select profile", detail: profileName || profileId }
        if (profile.enabled === false) {
            return { kind: "select", reason: "invalid", text: "Select profile", detail: profile.name || profileId }
        }
        return { kind: "selected", text: profile.name || `${profile.provider}:${profile.modelId}`, profile }
    }

    if (profileName) {
        const currentNameMatches = profiles.filter((profile) => profile.name === profileName)
        if (currentNameMatches.length === 1) {
            const profile = currentNameMatches[0]
            return profile.enabled === false
                ? { kind: "select", reason: "invalid", text: "Select profile", detail: profile.name }
                : { kind: "selected", text: profile.name || `${profile.provider}:${profile.modelId}`, profile }
        }
        if (currentNameMatches.length === 0) {
            const historicalNameMatches = profiles.filter((profile) => (profile.legacyNames ?? []).includes(profileName))
            if (historicalNameMatches.length === 1) {
                const profile = historicalNameMatches[0]
                return profile.enabled === false
                    ? { kind: "select", reason: "invalid", text: "Select profile", detail: profile.name }
                    : { kind: "selected", text: profile.name || `${profile.provider}:${profile.modelId}`, profile }
            }
        }
        return { kind: "select", reason: "missing", text: "Select profile", detail: profileName }
    }

    return { kind: "select", reason: "unselected", text: "Select profile" }
}
