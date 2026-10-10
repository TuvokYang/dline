import { createTaskArtifactResolver } from "@core/artifacts/runtime"
import { HostProvider } from "@hosts/host-provider"
import { Empty } from "@shared/proto/dline/common"
import type { ImageArtifactRequest } from "@shared/proto/dline/ui"
import type { Controller } from "../index"

/** Opens a verified image artifact through the active host without creating a temporary copy. */
export async function openImageArtifact(controller: Controller, request: ImageArtifactRequest): Promise<Empty> {
    const taskId = controller.task?.taskId
    if (!taskId) {
        throw new Error("An active task is required to open an image artifact.")
    }
    const resolved = await createTaskArtifactResolver(taskId).resolveImage(request.artifactId)
    await HostProvider.window.openFile({ filePath: resolved.absolutePath })
    return Empty.create({})
}
