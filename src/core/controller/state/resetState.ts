import { Empty } from "@shared/proto/dline/common"
import { ResetStateRequest } from "@shared/proto/dline/state"
import { resetGlobalState, resetWorkspaceState } from "@/core/storage/utils/state-helpers"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/dline/host/window"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { sendChatButtonClickedEvent } from "../ui/subscribeToChatButtonClicked"

/**
 * Resets the extension state to its defaults
 * @param controller The controller instance
 * @param request The reset state request containing the global flag
 * @returns An empty response
 */
export async function resetState(controller: Controller, request: ResetStateRequest): Promise<Empty> {
    try {
        // Closed through the controller's lifecycle lane, which also stops the lock
        // heartbeat, releases the task lock and clears the task's settings; disposing
        // the session directly left the lock held until this window closed.
        await controller.clearTask({ suppressPostState: true, closeReason: "state_reset" })
        if (request.global) {
            HostProvider.window.showMessage({
                type: ShowMessageType.INFORMATION,
                message: "Resetting global state...",
            })
            await resetGlobalState()
        } else {
            HostProvider.window.showMessage({
                type: ShowMessageType.INFORMATION,
                message: "Resetting workspace state...",
            })
            await resetWorkspaceState()
        }

        HostProvider.window.showMessage({
            type: ShowMessageType.INFORMATION,
            message: "State reset",
        })
        await controller.postStateToWebview()

        await sendChatButtonClickedEvent(controller)

        return Empty.create()
    } catch (error) {
        Logger.error("Error resetting state:", error)
        HostProvider.window.showMessage({
            type: ShowMessageType.ERROR,
            message: `Failed to reset state: ${error instanceof Error ? error.message : String(error)}`,
        })
        throw error
    }
}
