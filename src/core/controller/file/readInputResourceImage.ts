import { InputResourceImage, InputResourceRequest } from "@shared/proto/dline/file"
import { Controller } from ".."
import { referencedStoreFor, toOperationResult } from "./input-resources"

/**
 * Largest image whose bytes cross to the Webview for a chip thumbnail.
 *
 * A thumbnail is drawn at chip height, so a larger image is not worth copying
 * over the message channel; its chip shows the format icon instead.
 */
export const MAX_THUMBNAIL_SOURCE_BYTES = 8 * 1024 * 1024

/**
 * Reads the verified bytes of an image input resource for its chip thumbnail.
 *
 * The Webview names the resource, never a path, and receives bytes only when
 * every claim of the reference still matches its record and content. A
 * resource that is not an image, or is too large to preview, yields no data
 * rather than an error: the chip then falls back to its icon.
 */
export async function readInputResourceImage(controller: Controller, request: InputResourceRequest): Promise<InputResourceImage> {
    const target = referencedStoreFor(controller, request.draftId, request.ref)
    if (!target.ok) return InputResourceImage.create({ error: toOperationResult(target).error })

    const loaded = await target.value.store.readBytes(target.value.ref)
    if (!loaded.ok) return InputResourceImage.create({ error: toOperationResult(loaded).error })

    const { record, bytes } = loaded.value
    if (!record.mediaType.startsWith("image/") || bytes.byteLength > MAX_THUMBNAIL_SOURCE_BYTES) {
        return InputResourceImage.create({})
    }
    return InputResourceImage.create({ data: bytes, mimeType: record.mediaType })
}
