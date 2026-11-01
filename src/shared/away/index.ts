/** Host/Webview boundary values. Kernel owns its separate persistence domain. */
/** Trusted admission fact, not a client-supplied mode switch. */
export type UserInputControl = { readonly kind: "enter_away" } | { readonly kind: "user_returned" }

export interface AwayRevocations {
    readonly mode: number
    readonly automatic: number
}

export interface AwayConfiguration {
    readonly available: boolean
    readonly gateEnabled: boolean
    readonly awayModeEnabled: boolean
    readonly autoAwayModeEnabled: boolean
    readonly revocations: AwayRevocations
}

export type AwayPreferencePatch = Partial<Pick<AwayConfiguration, "awayModeEnabled" | "autoAwayModeEnabled">>

export function awayConfigurationEnabled(configuration: AwayConfiguration): boolean {
    return configuration.available && configuration.gateEnabled && configuration.awayModeEnabled
}

export function automaticAwayEnabled(configuration: AwayConfiguration): boolean {
    return awayConfigurationEnabled(configuration) && configuration.autoAwayModeEnabled
}

export function isAwayPreference(key: string): key is keyof AwayPreferencePatch {
    return key === "awayModeEnabled" || key === "autoAwayModeEnabled"
}
