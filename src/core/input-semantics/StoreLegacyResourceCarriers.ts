import type { AdmittedResourcePart } from "@shared/input-semantics/admitted-parts"
import { semanticInputDiagnostic } from "@shared/input-semantics/diagnostics"
import {
    type LegacyResourceCarrierPort,
    type LegacyResourceCarriers,
    SemanticInputRejectedError,
} from "@/core/task/session/TaskInputAdmission"
import type { InputResourceFailure } from "./InputResourceFailure"
import type { InputResourceStore } from "./InputResourceStore"

/** The store operations the projection needs: verified bytes for images, the verified copy for files. */
export type CarrierResourceStore = Pick<InputResourceStore, "readBytes" | "resolve">

/**
 * Hands verified resources to dialog receivers in the flat shape they read.
 *
 * An image becomes a data URL of exactly the bytes the store verified, so a
 * receiver cannot see a different picture than admission accepted. A file
 * becomes the path of the task's own frozen copy, never the path it was
 * staged from, so a later edit of the source cannot change the reply.
 */
export class StoreLegacyResourceCarriers implements LegacyResourceCarrierPort {
    constructor(private readonly store: () => CarrierResourceStore) {}

    async project(documentId: string, parts: readonly AdmittedResourcePart[]): Promise<LegacyResourceCarriers> {
        const store = this.store()
        const images: string[] = []
        const files: string[] = []
        for (const part of parts) {
            if (part.nodeKind === "image") {
                const loaded = await store.readBytes(part.ref)
                if (!loaded.ok) throw refused(documentId, part, loaded.failure)
                images.push(`data:${loaded.value.record.mediaType};base64,${loaded.value.bytes.toString("base64")}`)
                continue
            }
            const resolved = await store.resolve(part.ref)
            if (!resolved.ok) throw refused(documentId, part, resolved.failure)
            files.push(resolved.value.contentPath)
        }
        return { images, files }
    }
}

function refused(documentId: string, part: AdmittedResourcePart, failure: InputResourceFailure): SemanticInputRejectedError {
    return new SemanticInputRejectedError([
        semanticInputDiagnostic(failure.code, failure.message, {
            documentId,
            entityId: part.entityId,
            resourceId: part.ref.resourceId,
        }),
    ])
}
