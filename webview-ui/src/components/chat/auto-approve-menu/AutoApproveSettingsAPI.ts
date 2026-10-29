import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"

export interface AutoApprovalSettingsUpdate {
    version: number
    actions?: Partial<AutoApprovalSettings["actions"]>
    enableNotifications?: boolean
}

import { StateServiceClient } from "@/services/grpc-client"

/**
 * Updates auto approval settings using the gRPC/Protobus client
 * @param settings The auto approval settings to update
 * @throws Error if the update fails
 */
export async function updateAutoApproveSettings(settings: AutoApprovalSettingsUpdate) {
    try {
        await StateServiceClient.updateAutoApprovalSettings({
            metadata: {},
            version: settings.version,
            actions: settings.actions,
            enableNotifications: settings.enableNotifications,
        })
    } catch (error) {
        console.error("Failed to update auto approval settings:", error)
        throw error
    }
}
