import type { ClineFileStorage } from "@shared/storage/ClineFileStorage"
import {
    applyTransform,
    GlobalStateAndSettingKeys,
    GlobalStateAndSettings,
    getDefaultValue,
    isAsyncProperty,
    isComputedProperty,
    LocalState,
    LocalStateKeys,
    SecretKeys,
    Secrets,
} from "@shared/storage/state-keys"
import { Logger } from "@/shared/services/Logger"
import { ClineMemento } from "@/shared/storage"
import { StateManager } from "../StateManager"

// ─── File-backed storage readers (used by StateManager) ────────────────────

/**
 * Read secrets from a ClineFileStorage instance.
 */
export function readSecretsFromStorage(store: ClineFileStorage<string>): Secrets {
    return SecretKeys.reduce((acc, key) => {
        acc[key] = store.get(key)
        return acc
    }, {} as Secrets)
}

/**
 * Read workspace state from a ClineFileStorage instance.
 */
export function readWorkspaceStateFromStorage(store: ClineFileStorage): LocalState {
    return LocalStateKeys.reduce((acc, key) => {
        acc[key] = store.get(key) || {}
        return acc
    }, {} as LocalState)
}

/**
 * Read global state from a ClineFileStorage instance.
 */
export async function readGlobalStateFromStorage(store: ClineMemento): Promise<GlobalStateAndSettings> {
    try {
        // Batch read all state values in a single optimized pass
        const stateValues = new Map<string, any>()
        for (const key of GlobalStateAndSettingKeys) {
            const value = store.get(key as string)
            stateValues.set(key, value)
        }

        const result = {} as any

        for (const key of GlobalStateAndSettingKeys) {
            const stateKey = key as keyof GlobalStateAndSettings
            let value = stateValues.get(stateKey)

            if (isAsyncProperty(stateKey)) {
                continue
            }
            if (isComputedProperty(stateKey)) {
                continue
            }
            if (value === undefined) {
                const defaultValue = getDefaultValue(stateKey)
                if (defaultValue !== undefined) {
                    value = defaultValue
                }
            }
            if (value !== undefined) {
                value = applyTransform(stateKey, value)
            }
            result[stateKey] = value
        }

        await handleComputedProperties(result, stateValues)
        await handleAsyncProperties(result)

        return result as GlobalStateAndSettings
    } catch (error) {
        Logger.error("[StateHelpers] Failed to read global state from storage:", error)
        throw error
    }
}

// ─── Legacy readers (for VSCode migration — reads from ExtensionContext) ────

/**
 * Handle properties that require computed logic
 */
async function handleComputedProperties(result: any, stateValues: Map<string, any>): Promise<void> {
    // 1. API Provider logic - set defaults based on existing values
    // Profile-driven: API provider is resolved from planModeProfile / actModeProfile at runtime.
    // Legacy defaults are no longer set — profiles are managed via api_profiles.json.

    // 2. Plan/Act separate models setting with special logic
    const planActSeparateModelsSettingRaw = stateValues.get("planActSeparateModelsSetting")
    if (planActSeparateModelsSettingRaw === true || planActSeparateModelsSettingRaw === false) {
        result.planActSeparateModelsSetting = planActSeparateModelsSettingRaw
    } else {
        // Default to false when not explicitly set
        result.planActSeparateModelsSetting = false
    }
}

/**
 * Handle properties that require async operations
 */
async function handleAsyncProperties(result: any): Promise<void> {
    // taskHistory is loaded via TaskHistory instance in StateManager.initialize()
    // and later refreshed by loadFullTaskHistoryAsync(). Set empty array as placeholder.
    result.taskHistory = []
}

export async function resetWorkspaceState() {
    const stateManager = StateManager.get()
    LocalStateKeys.map((key) => stateManager.setWorkspaceState(key, {}))
    await stateManager.reInitialize()
}

export async function resetGlobalState() {
    // TODO: Reset all workspace states?
    const stateManager = StateManager.get()
    GlobalStateAndSettingKeys.map((key) => stateManager.setGlobalState(key, undefined))
    SecretKeys.map((key) => stateManager.setSecret(key, undefined))
    await stateManager.reInitialize()
}
