import { machineId } from "node-machine-id"
import { v4 as uuidv4 } from "uuid"
import { HostRegistryInfo } from "@/registry"
import { Logger } from "@/shared/services/Logger"
import { StorageContext } from "@/shared/storage"

/*
 * Unique identifier for the current installation.
 */
let _distinctId = ""

/**
 * Some environments don't return a value for the machine ID. For these situations we generated
 * a unique ID and store it locally.
 */
export const _GENERATED_MACHINE_ID_KEY = "cline.generatedMachineId"

export async function initializeDistinctId(storage: StorageContext, uuid: () => string = uuidv4) {
    // Try to read the ID from storage.
    let distinctId = storage.globalState.get<string>(_GENERATED_MACHINE_ID_KEY)

    if (!distinctId) {
        // Get the ID from the host environment.
        distinctId = await getMachineId()
    }
    if (!distinctId) {
        // Fallback to generating a unique ID and keeping in global storage.
        Logger.warn("No machine ID found for telemetry, generating UUID")
        // Add a prefix to the UUID so we can see in the telemetry how many clients are don't have a machine ID.
        distinctId = `cl-${uuid()}`
        storage.globalState.update(_GENERATED_MACHINE_ID_KEY, distinctId)
    }

    setDeviceDistinctId(distinctId)

    await HostRegistryInfo.init(distinctId)

    Logger.log("[DistinctId] initialized:", distinctId)
}

/*
 * Get machine ID using node-machine-id package
 * This works across all platforms (VS Code, JetBrains, CLI)
 */
async function getMachineId(): Promise<string | undefined> {
    try {
        // Get the machine ID using node-machine-id package
        // This provides a deterministic ID across different operating systems
        const id = await machineId()
        return id
    } catch (error) {
        Logger.log("[DistinctId] Failed to get machine ID from node-machine-id", error)
        return undefined
    }
}

/** Set the device-scoped identifier during initialization. */
function setDeviceDistinctId(newId: string): void {
    if (_distinctId && _distinctId !== newId) {
        Logger.log("[DistinctId] Updating device identity", `From ${_distinctId} to ${newId}`)
    }
    _distinctId = newId
}

/** Test seam. Production account flows must never mutate the device identity. */
export function setDistinctIdForTesting(newId: string): void {
    setDeviceDistinctId(newId)
}

/**
 * Stable identifier for this local device or installation.
 *
 * Account identity is recorded through the telemetry account channel and never
 * replaces this value.
 */
export function getDistinctId() {
    if (!_distinctId) {
        Logger.debug("[DistinctId] Not initialized. Call initializeDistinctId() first.")
    }
    return _distinctId
}
