export interface ClineFeatureSetting {
    // Setting is enabled or disabled by user
    user: boolean
    // Setting is enabled or disabled by feature flag
    featureFlag: boolean
}

/** A gated feature is on only while its flag offers it and the user has opted in. */
export function isFeatureSettingActive(setting: ClineFeatureSetting | undefined): boolean {
    return setting?.featureFlag === true && setting.user === true
}
