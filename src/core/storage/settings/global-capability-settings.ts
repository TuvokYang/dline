import type { StateManager } from "@core/storage/StateManager"
import type { Settings } from "@shared/storage/state-keys"

/**
 * Global capability preference keys.
 *
 * These maps hold explicit user preferences only. Capability discovery never
 * writes to them: it scans the filesystem and resolves the effective state in
 * memory through `capability-toggle-scopes`, so an absent path means "inherit
 * the discovered default", not "disabled".
 */
export type GlobalCapabilitySettingsKey =
    | "globalClineRulesToggles"
    | "globalWorkflowToggles"
    | "globalSkillsToggles"
    | "globalSubagentsToggles"

type ToggleMap = Record<string, boolean>

export async function setGlobalCapabilityEnabled(
    stateManager: StateManager,
    key: GlobalCapabilitySettingsKey,
    resourcePath: string,
    enabled: boolean,
): Promise<ToggleMap> {
    return stateManager.mutateGlobalSettingsKey(key, (current) => ({ ...current, [resourcePath]: enabled })) as Promise<
        Settings[GlobalCapabilitySettingsKey]
    >
}

export async function removeGlobalCapability(
    stateManager: StateManager,
    key: GlobalCapabilitySettingsKey,
    resourcePath: string,
): Promise<ToggleMap> {
    return stateManager.mutateGlobalSettingsKey(key, (current) => {
        const { [resourcePath]: _removed, ...remaining } = current
        return remaining
    }) as Promise<Settings[GlobalCapabilitySettingsKey]>
}
