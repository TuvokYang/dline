import { semanticInputDiagnostic } from "@shared/input-semantics/diagnostics"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import type { EventSubmissionResult } from "@/core/task/runtime"
import { SemanticInputRejectedError } from "@/core/task/session/TaskInputAdmission"
import { adoptDraftDocument, type DraftDocumentAdoption, verifyDraftDocument } from "./DraftInputResourceStore"
import type { InputResourceFailure } from "./InputResourceFailure"
import type { InputResourceStore } from "./InputResourceStore"
import { openTaskInputResources } from "./TaskInputResourceStore"

function rejectedOpening(document: SemanticInputDocument, failure: InputResourceFailure): SemanticInputRejectedError {
    const { code, message, resourceId } = failure
    return new SemanticInputRejectedError([
        semanticInputDiagnostic(code, message, { documentId: document.documentId, ...(resourceId ? { resourceId } : {}) }),
    ])
}

/**
 * Refuse, before the task exists, an opening document whose draft resources
 * could not be adopted.
 *
 * A new task starts in the background, where a refusal can no longer hand the
 * draft back; failing here leaves the composer owning its draft so it can be
 * restored and sent again.
 */
export async function preflightOpeningDocument(
    document: SemanticInputDocument,
    verify: (document: SemanticInputDocument) => ReturnType<typeof verifyDraftDocument> = verifyDraftDocument,
): Promise<void> {
    const verified = await verify(document)
    if (!verified.ok) throw rejectedOpening(document, verified.failure)
}

/** What the opening needs from the task to know its first submission is durable. */
export interface OpeningDurability {
    waitForDurable(revision: number): Promise<void>
}

/**
 * Remove the draft copies once the task holds the rebound document durably.
 *
 * A refused start keeps them: the submission never happened, so the draft
 * still owns its attachments. Waiting for durability matters because the
 * copies are the only ones a crash before the commit could still recover.
 */
export async function releaseOpeningOnceDurable(
    opening: DraftDocumentAdoption,
    started: EventSubmissionResult,
    durability: OpeningDurability,
): Promise<void> {
    if (started.kind !== "accepted") return
    await durability.waitForDurable(started.receipt.revision)
    await opening.release()
}

/**
 * Bind the document that opens a task to the task's own resources.
 *
 * Runs once the task exists and before admission, which verifies resources
 * against the task's store only. A failed adoption refuses the submission the
 * way admission would, so the user sees why the task did not start instead of
 * a turn that silently lacks an attachment.
 */
export async function bindOpeningDocument(
    document: SemanticInputDocument,
    taskId: string,
    openTask: (taskId: string) => InputResourceStore = openTaskInputResources,
): Promise<DraftDocumentAdoption> {
    const adopted = await adoptDraftDocument(document, openTask(taskId))
    if (adopted.ok) return adopted.value
    throw rejectedOpening(document, adopted.failure)
}
