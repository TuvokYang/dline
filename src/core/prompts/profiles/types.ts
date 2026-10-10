/** Supported prompt architecture profiles. */
export enum PromptProfile {
    Standard = "standard",
    Lite = "lite",
}

/** Validate one exact profile at an untrusted runtime boundary. */
export function requirePromptProfile(profile: PromptProfile): PromptProfile {
    if (profile !== PromptProfile.Standard && profile !== PromptProfile.Lite) {
        throw new Error("PromptProfile must be supplied explicitly")
    }
    return profile
}
