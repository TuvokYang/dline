import type { SemanticResourceRef } from "@shared/input-semantics/document"
import { InputResourceRequest } from "@shared/proto/dline/file"
import { toProtoSemanticResourceRef } from "@shared/proto-conversions/input-semantics/document"
import { useEffect, useState } from "react"
import { FileServiceClient } from "@/services/grpc-client"

/**
 * Thumbnail object URLs by content hash.
 *
 * A thumbnail depends only on the bytes, so a resource that was cut and
 * pasted, queued, or adopted by the task under a new owner reuses the image
 * its first chip loaded. URLs live for the Webview session: a chip that
 * re-renders must still find the image it showed.
 */
const thumbnails = new Map<string, Promise<string | undefined>>()
/** Thumbnails already loaded, read synchronously so a remounted chip draws its image at once. */
const resolved = new Map<string, string>()

/** Whether a reference names bytes a chip can draw as a thumbnail. */
function isImageRef(ref: SemanticResourceRef): boolean {
    return ref.mediaType.startsWith("image/")
}

/**
 * Load the thumbnail of an image resource from its verified bytes.
 *
 * Resolves undefined when the resource is not an image or cannot be read, so
 * the chip keeps its icon; a failed load is forgotten and may be retried by a
 * later chip.
 */
export function loadResourceThumbnail(ref: SemanticResourceRef): Promise<string | undefined> {
    if (!isImageRef(ref)) return Promise.resolve(undefined)
    const key = ref.expectedContentHash
    const cached = thumbnails.get(key)
    if (cached) return cached
    const draftId = ref.owner.kind === "draft" ? ref.owner.draftId : ""
    // Started inside a promise, so a client that throws synchronously still only costs the thumbnail.
    const pending = Promise.resolve()
        .then(() =>
            FileServiceClient.readInputResourceImage(
                InputResourceRequest.create({ draftId, ref: toProtoSemanticResourceRef(ref) }),
            ),
        )
        .then((image) =>
            // Copied into a plain ArrayBuffer view, which is what Blob accepts.
            image.data.length > 0
                ? URL.createObjectURL(new Blob([new Uint8Array(image.data)], { type: image.mimeType }))
                : undefined,
        )
        .catch(() => undefined)
        .then((url) => {
            if (url === undefined) thumbnails.delete(key)
            else resolved.set(key, url)
            return url
        })
    thumbnails.set(key, pending)
    return pending
}

/**
 * The thumbnail of an image resource, once loaded; undefined without one.
 *
 * Keyed by the content hash, not the reference object: a message row rebuilds
 * its references on every update, and reloading on each one flipped the chip
 * between its icon and its image. In a virtualized list that height change
 * re-measured the row and moved the scroll position on every redraw, so a long
 * conversation shook at the bottom. A thumbnail already loaded is drawn on the
 * first render for the same reason.
 */
export function useResourceThumbnail(ref: SemanticResourceRef | undefined): string | undefined {
    const key = ref && isImageRef(ref) ? ref.expectedContentHash : undefined
    const [loaded, setLoaded] = useState<{ readonly key: string; readonly url: string | undefined }>()
    // biome-ignore lint/correctness/useExhaustiveDependencies: the content hash identifies the bytes; a re-created reference to the same bytes must not reload.
    useEffect(() => {
        if (!ref || key === undefined || resolved.has(key)) return
        let current = true
        void loadResourceThumbnail(ref).then((url) => {
            if (current) setLoaded({ key, url })
        })
        return () => {
            current = false
        }
    }, [key])
    if (key === undefined) return undefined
    return resolved.get(key) ?? (loaded?.key === key ? loaded.url : undefined)
}

/** Forget every loaded thumbnail; for tests. */
export function resetResourceThumbnailsForTesting(): void {
    thumbnails.clear()
    resolved.clear()
}
