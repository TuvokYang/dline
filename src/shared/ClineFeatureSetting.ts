/**
 * A capability that is rolled out before it is offered to everyone.
 *
 * The two halves are different levels, not two votes on one switch:
 * - `featureFlag`: the rollout offers the capability on this device, so Settings
 *   shows its toggle or configuration;
 * - `user`: the user's own setting, which decides whether the offered capability
 *   is shown and in use. Its default is the capability's configured default; a
 *   major capability defaults to off so the user turns it on.
 */
export interface DlineFeatureSettings {
    user: boolean
    featureFlag: boolean
}

/** A gated capability is in use only while the rollout offers it and the user's setting turns it on. */
export function isFeatureSettingActive(setting: DlineFeatureSettings | undefined): boolean {
    return setting?.featureFlag === true && setting.user === true
}
