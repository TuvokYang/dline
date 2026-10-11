import type { SemanticResourceRef } from "@shared/input-semantics/document"
import { DlineRuntimeFileManager } from "@/services/runtime-files/DlineRuntimeFileManager"
import { type InputResourceResult, resourceFailed, resourceSucceeded } from "./InputResourceFailure"
import { type InputResourceRoot, InputResourceStore, referenceOf } from "./InputResourceStore"

const DRAFT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** The managed attachment area a draft borrows; its directories age out unless kept. */
export interface DraftAttachmentArea {
    attachmentDirectory(stableId: string): string
    markAttachmentDirectoryRetained(stableId: string): Promise<void>
}

/**
 * The input resources a composer draft owns before its task exists.
 *
 * A draft has no task storage yet, so its resources live in the managed
 * attachment area, which deletes directories nobody touched for a while. Every
 * verified access keeps a resource alive, so a draft that is still in use does
 * not lose it. That storage only bridges the time until admission: a resource's
 * lasting identity is its ID and owner, never the temporary path, and admission
 * adopts it into the task.
 */
export function draftInputResourceRoot(draftId: string, area: DraftAttachmentArea = DlineRuntimeFileManager): InputResourceRoot {
    if (!DRAFT_ID_PATTERN.test(draftId)) {
        throw new Error("Invalid draft identity for input resources")
    }
    return {
        owner: { kind: "draft", draftId },
        resourceDirectory: (resourceId) => area.attachmentDirectory(resourceId),
        onVerifiedAccess: (resourceId) => area.markAttachmentDirectoryRetained(resourceId),
    }
}

export function openDraftInputResources(draftId: string, area?: DraftAttachmentArea): InputResourceStore {
    return new InputResourceStore(draftInputResourceRoot(draftId, area))
}

/**
 * Adopt every resource a draft document references into the new task, or none.
 *
 * The returned references keep each resource ID and order and carry the task
 * owner and the advanced generation, so the caller rebinds its document by
 * replacing references only. A failure removes the copies this call created and
 * reports the first failing resource; adoptions an earlier attempt completed are
 * kept, because a retried hand-off may already reference them. Draft resources
 * are never removed here: the caller removes them after the task commits the
 * rebound document durably.
 */
export async function adoptDraftResources(
    draft: InputResourceStore,
    task: InputResourceStore,
    refs: readonly SemanticResourceRef[],
): Promise<InputResourceResult<readonly SemanticResourceRef[]>> {
    const draftOwner = draft.owner
    if (draftOwner.kind !== "draft" || task.owner.kind !== "task") {
        return resourceFailed("semantic_input_resource_adopt_failed", "resources move only from a draft into a task")
    }
    const foreign = refs.find((ref) => ref.owner?.kind !== "draft" || ref.owner.draftId !== draftOwner.draftId)
    if (foreign) {
        return resourceFailed(
            "semantic_input_resource_invalid",
            `resource ${foreign.resourceId} is not owned by this draft`,
            foreign.resourceId,
        )
    }

    const adopted = await task.adoptAll(draft, refs)
    if (!adopted.ok) return adopted
    return resourceSucceeded(adopted.value.map((adoption) => referenceOf(adoption.record)))
}
