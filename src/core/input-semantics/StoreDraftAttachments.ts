import {
    type DraftAttachmentPort,
    type DraftAttachments,
    unavailableAttachmentNotice,
} from "@core/task/interaction/DraftAttachments"
import type { AdmittedInputPart } from "@shared/input-semantics/admitted-parts"
import { Logger } from "@shared/services/Logger"
import type { InputResourceStore } from "./InputResourceStore"

/** The store operations resolving needs: verified bytes for images, a readable path for files. */
export type DraftAttachmentStore = Pick<InputResourceStore, "readBytes" | "resolve">

/**
 * Resolves a draft's resources from the task's store when a receiver consumes it.
 *
 * An image becomes a data URL of exactly the bytes the store verified. A file
 * becomes the path the store vouches for: a captured resource's own copy, or
 * the local file a linked resource names. A resource that can no longer be
 * resolved becomes a notice instead of disappearing.
 */
export class StoreDraftAttachments implements DraftAttachmentPort {
    constructor(private readonly store: () => DraftAttachmentStore) {}

    async resolve(parts: readonly AdmittedInputPart[]): Promise<DraftAttachments> {
        const store = this.store()
        const images: string[] = []
        const files: string[] = []
        const notices: string[] = []
        for (const part of parts) {
            if (part.kind !== "resource") continue
            if (part.nodeKind === "image") {
                const loaded = await store.readBytes(part.ref)
                if (loaded.ok) {
                    images.push(`data:${loaded.value.record.mediaType};base64,${loaded.value.bytes.toString("base64")}`)
                    continue
                }
                notices.push(unavailable(part.entityId, part.displayName, loaded.failure.code))
                continue
            }
            const resolved = await store.resolve(part.ref)
            if (resolved.ok) {
                files.push(resolved.value.contentPath)
                continue
            }
            notices.push(unavailable(part.entityId, part.displayName, resolved.failure.code))
        }
        return { images, files, notices }
    }
}

function unavailable(entityId: string, displayName: string, code: string): string {
    Logger.warn(`[DraftAttachments] resource ${entityId} is unavailable: ${code}`)
    return unavailableAttachmentNotice(displayName, code)
}
