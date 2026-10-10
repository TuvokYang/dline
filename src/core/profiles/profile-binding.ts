import type { ApiProfile } from "@shared/proto/dline/profile"

export interface ResolvedProfileBinding {
    profile: ApiProfile
    profileId: string
    profileName: string
    migratedFromLegacyName: boolean
}

export interface InvalidProfileReference {
    status: "invalid"
    reason: "missing" | "ambiguous"
    error: string
}

export type ProfileReferenceResolution = ({ status: "resolved" } & ResolvedProfileBinding) | InvalidProfileReference

/** Resolve a stable Profile ID first, with unique legacy-name migration only. */
export function resolveProfileReference(
    profiles: readonly ApiProfile[],
    reference: string | undefined,
): ProfileReferenceResolution {
    if (!reference) {
        return {
            status: "invalid",
            reason: "missing",
            error: "Profile not valid: no Profile reference was provided.",
        }
    }

    const idMatches = profiles.filter((profile) => profile.id === reference)
    if (idMatches.length === 1) {
        const profile = idMatches[0]
        return {
            status: "resolved",
            profile,
            profileId: profile.id,
            profileName: profile.name,
            migratedFromLegacyName: false,
        }
    }
    if (idMatches.length > 1) {
        return {
            status: "invalid",
            reason: "ambiguous",
            error: `Profile not valid: stable ID "${reference}" is duplicated.`,
        }
    }

    const nameMatches = profiles.filter((profile) => profile.name === reference)
    if (nameMatches.length === 1) {
        const profile = nameMatches[0]
        return {
            status: "resolved",
            profile,
            profileId: profile.id,
            profileName: profile.name,
            migratedFromLegacyName: true,
        }
    }
    if (nameMatches.length > 1) {
        return {
            status: "invalid",
            reason: "ambiguous",
            error: `Profile not valid: current name "${reference}" matches multiple Profiles.`,
        }
    }

    const historicalNameMatches = profiles.filter((profile) => (profile.legacyNames ?? []).includes(reference))
    if (historicalNameMatches.length === 1) {
        const profile = historicalNameMatches[0]
        return {
            status: "resolved",
            profile,
            profileId: profile.id,
            profileName: profile.name,
            migratedFromLegacyName: true,
        }
    }
    if (historicalNameMatches.length > 1) {
        return {
            status: "invalid",
            reason: "ambiguous",
            error: `Profile not valid: historical name "${reference}" matches multiple Profiles.`,
        }
    }

    return {
        status: "invalid",
        reason: "missing",
        error: `Profile not valid: "${reference}" no longer exists.`,
    }
}
