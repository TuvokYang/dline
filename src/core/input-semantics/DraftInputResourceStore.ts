import type { InputResourceOwner, SemanticInputDocument, SemanticResourceRef } from "@shared/input-semantics/document"
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

/** A document rebound to its task, and the release of the draft copies it no longer needs. */
export interface DraftDocumentAdoption {
    readonly document: SemanticInputDocument
    /**
     * Remove the draft copies; call only once the task committed the rebound
     * document durably. Best effort: a copy that cannot be removed now is left
     * to the attachment area, which ages it out.
     */
    release(): Promise<void>
}

type DraftOwner = Extract<InputResourceOwner, { kind: "draft" }>
type DraftRef = SemanticResourceRef & { owner: DraftOwner }

/** The one draft a document's draft references belong to, and those references. */
interface DocumentDraft {
    readonly draft: InputResourceStore
    readonly refs: readonly DraftRef[]
}

/**
 * Find the draft a document stages under; undefined when it references none.
 * A composer stages under exactly one draft identity, so a document spanning
 * several drafts, or naming an invalid one, is refused.
 */
function documentDraftOf(
    document: SemanticInputDocument,
    openDraft: (draftId: string) => InputResourceStore,
): InputResourceResult<DocumentDraft | undefined> {
    const refs = document.resources.filter((ref): ref is DraftRef => ref.owner?.kind === "draft")
    if (refs.length === 0) return resourceSucceeded(undefined)
    if (new Set(refs.map((ref) => ref.owner.draftId)).size > 1) {
        return resourceFailed("semantic_input_resource_invalid", "the document references resources of more than one draft")
    }
    try {
        return resourceSucceeded({ draft: openDraft(refs[0].owner.draftId), refs })
    } catch {
        return resourceFailed("semantic_input_resource_invalid", "the document names an invalid draft identity")
    }
}

/**
 * Check that a draft document's resources could be adopted, without adopting them.
 *
 * Runs before the task exists, so a submission that would certainly be refused
 * is handed back while the composer still owns its draft. Adoption verifies
 * again, because the draft area can change in between.
 */
export async function verifyDraftDocument(
    document: SemanticInputDocument,
    openDraft: (draftId: string) => InputResourceStore = openDraftInputResources,
): Promise<InputResourceResult<void>> {
    const located = documentDraftOf(document, openDraft)
    if (!located.ok) return located
    if (!located.value) return resourceSucceeded(undefined)
    const { draft, refs } = located.value
    for (const ref of refs) {
        const resolved = await draft.resolve(ref)
        if (!resolved.ok) return resolved
    }
    return resourceSucceeded(undefined)
}

/**
 * Bind a new task's opening document to the task that now exists.
 *
 * A welcome composer stages into its draft because no task exists yet, while
 * admission verifies resources against the task's store only. Every draft
 * reference is adopted at once or none is used, and the document keeps its
 * nodes: only its references change. Task-owned references are left for
 * admission to verify. A document spanning several drafts is refused, because a
 * composer stages under exactly one draft identity.
 */
export async function adoptDraftDocument(
    document: SemanticInputDocument,
    task: InputResourceStore,
    openDraft: (draftId: string) => InputResourceStore = openDraftInputResources,
): Promise<InputResourceResult<DraftDocumentAdoption>> {
    const located = documentDraftOf(document, openDraft)
    if (!located.ok) return located
    if (!located.value) return resourceSucceeded({ document, release: async () => {} })
    const { draft, refs: draftRefs } = located.value
    const adopted = await adoptDraftResources(draft, task, draftRefs)
    if (!adopted.ok) return adopted

    const rebound = new Map(adopted.value.map((ref) => [ref.resourceId, ref]))
    return resourceSucceeded({
        document: { ...document, resources: document.resources.map((ref) => rebound.get(ref.resourceId) ?? ref) },
        release: async () => {
            await Promise.allSettled(draftRefs.map((ref) => draft.remove(ref.resourceId)))
        },
    })
}
