import { StateManager } from "@/core/storage/StateManager"
import { featureFlagsService } from "@/services/feature-flags"
import { type DlineFeatureSettings, isFeatureSettingActive } from "@/shared/DlineFeatureSettings"

type AccountSettingsReader = Pick<StateManager, "getGlobalSettingsKey">

/**
 * Whether the rollout offers the account feature, and whether the user opted in.
 * A caller that owns a state manager passes it; host code reads the process one.
 */
export function readAccountFeatureSetting(settings: AccountSettingsReader = StateManager.get()): DlineFeatureSettings {
    return {
        user: settings.getGlobalSettingsKey("accountEnabled") === true,
        featureFlag: featureFlagsService.getAccountEnabled(),
    }
}

/** The account entry points are shown only while this holds. */
export function isAccountFeatureActive(): boolean {
    return isFeatureSettingActive(readAccountFeatureSetting())
}

/**
 * Tells host surfaces outside the Webview, such as the sidebar title button,
 * when the account feature turns on or off.
 *
 * The two inputs change through different owners, the rollout service and the
 * settings update, so both call {@link reevaluate}; listeners hear only real
 * transitions.
 */
class AccountFeatureGate {
    private readonly listeners = new Set<(active: boolean) => void>()
    private active: boolean | undefined
    private unsubscribeFlags: (() => void) | undefined

    onDidChange(listener: (active: boolean) => void): () => void {
        this.unsubscribeFlags ??= featureFlagsService.onDidChange(() => this.reevaluate())
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    reevaluate(): void {
        const active = isAccountFeatureActive()
        if (active === this.active) return
        this.active = active
        for (const listener of this.listeners) listener(active)
    }
}

export const accountFeatureGate = new AccountFeatureGate()
