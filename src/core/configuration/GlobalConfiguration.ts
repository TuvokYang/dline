import type { StateManager } from "@core/storage/StateManager"
import type { TerminalManagerConfiguration } from "@integrations/terminal"

export interface GlobalConfigurationSnapshot {
    readonly terminal: TerminalManagerConfiguration
}

/** Capture one immutable global configuration snapshot from the in-memory settings cache. */
export function createGlobalConfigurationSnapshot(stateManager: StateManager): GlobalConfigurationSnapshot {
    return Object.freeze({
        terminal: Object.freeze({
            shellIntegrationTimeout: stateManager.getGlobalSettingsKey("shellIntegrationTimeout") ?? 4000,
            terminalReuseEnabled: stateManager.getGlobalStateKey("terminalReuseEnabled") ?? true,
            terminalOutputLineLimit: stateManager.getGlobalSettingsKey("terminalOutputLineLimit") ?? 500,
            defaultTerminalProfile: stateManager.getGlobalSettingsKey("defaultTerminalProfile") ?? "default",
        }),
    })
}
