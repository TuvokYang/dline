import { Empty } from "@shared/proto/dline/common"
import { AutoApprovalSettingsRequest } from "@shared/proto/dline/state"
import { Controller } from ".."

/**
 * Updates the auto approval settings
 * @param controller The controller instance
 * @param request The auto approval settings request
 * @returns Empty response
 */
export async function updateAutoApprovalSettings(controller: Controller, request: AutoApprovalSettingsRequest): Promise<Empty> {
    await controller.stateManager.updateAutoApprovalSettings({
        version: request.version,
        enableNotifications: request.enableNotifications,
        actions: request.actions
            ? Object.fromEntries(Object.entries(request.actions).filter(([_, value]) => value !== undefined))
            : undefined,
    })
    return Empty.create()
}
