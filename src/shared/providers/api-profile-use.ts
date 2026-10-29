export const API_PROFILE_USES = ["act", "plan", "subagents"] as const

export type ApiProfileUse = (typeof API_PROFILE_USES)[number]

const API_PROFILE_USE_SET = new Set<string>(API_PROFILE_USES)

/** Return true when a persisted profile use is supported by this Dline version. */
export function isApiProfileUse(value: string): value is ApiProfileUse {
    return API_PROFILE_USE_SET.has(value)
}

/** Normalize persisted profile uses without implicitly enabling new capabilities. */
export function normalizeApiProfileUses(values: readonly string[] | null | undefined): ApiProfileUse[] {
    const normalized: ApiProfileUse[] = []
    for (const value of values ?? []) {
        if (isApiProfileUse(value) && !normalized.includes(value)) normalized.push(value)
    }
    return normalized
}
