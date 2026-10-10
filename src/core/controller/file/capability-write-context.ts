import type { Controller } from "../index"

/**
 * The editor context that selects which scope owns a new toggle preference.
 *
 * This is independent from where a capability was discovered: a global rule
 * toggled inside a task is recorded as a task override, and the same rule
 * toggled with no task open is recorded at the workspace or global level.
 */
export interface CapabilityWriteContext {
    readonly hasWorkspace: boolean
    readonly hasTask: boolean
}

export function capabilityWriteContext(controller: Controller): CapabilityWriteContext {
    return {
        hasWorkspace: controller.stateManager.hasWorkspaceScope,
        hasTask: controller.task !== undefined,
    }
}
