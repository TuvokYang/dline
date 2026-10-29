import { createTaskArtifactResolver } from "@core/artifacts/runtime"
import { ImageArtifactContent, type ImageArtifactRequest } from "@shared/proto/dline/ui"
import type { Controller } from "../index"

/** Returns verified bytes for an image artifact owned by the active task. */
export async function getImageArtifact(controller: Controller, request: ImageArtifactRequest): Promise<ImageArtifactContent> {
    const taskId = controller.task?.taskId
    if (!taskId) {
        throw new Error("An active task is required to read an image artifact.")
    }
    const resolved = await createTaskArtifactResolver(taskId).resolveImage(request.artifactId)
    return ImageArtifactContent.create({ data: resolved.bytes, mimeType: resolved.artifact.mimeType })
}
