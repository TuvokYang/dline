import type { StateManager } from "@core/storage/StateManager"
import { getAwaySettings } from "./awaySettings"

/** User values stay intact while rollout or storage safety hides the feature. */
export function awaySettingsProjection(stateManager: StateManager) {
    const configuration = getAwaySettings(stateManager).read()
    return {
        awayModeEnabled: configuration.awayModeEnabled,
        autoAwayModeEnabled: configuration.autoAwayModeEnabled,
        awayModeGateEnabled: configuration.available && configuration.gateEnabled,
    }
}
