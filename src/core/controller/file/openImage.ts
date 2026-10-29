import { getTaskArtifactDirectory } from "@core/artifacts/runtime"
import { openImage as openImageIntegration } from "@integrations/misc/open-file"
import { Empty, StringRequest } from "@shared/proto/dline/common"
import { Controller } from ".."

/**
 * Opens an image in the system viewer
 * @param controller The controller instance
 * @param request The request message containing the image path or data URI in the 'value' field
 * @returns Empty response
 */
export async function openImage(controller: Controller, request: StringRequest): Promise<Empty> {
    if (request.value) {
        const taskId = controller.task?.taskId
        if (!taskId) {
            throw new Error("An active task is required to open image viewer content.")
        }
        await openImageIntegration(request.value, getTaskArtifactDirectory(taskId))
    }
    return Empty.create()
}
