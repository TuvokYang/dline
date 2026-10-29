import { createTaskImagePreviewStore } from "@core/artifacts/runtime"
import { ImageArtifactContent, type ImagePreviewRequest } from "@shared/proto/dline/ui"
import type { Controller } from "../index"

/** Returns verified bytes for an ephemeral image preview owned by the active task. */
export async function getImagePreview(controller: Controller, request: ImagePreviewRequest): Promise<ImageArtifactContent> {
    const taskId = controller.task?.taskId
    if (!taskId) {
        throw new Error("An active task is required to read an image preview.")
    }
    const resolved = await createTaskImagePreviewStore(taskId).readPreview(request.previewId)
    return ImageArtifactContent.create({ data: resolved.bytes, mimeType: resolved.preview.mimeType })
}
