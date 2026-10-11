import { referenceOf } from "@core/input-semantics/InputResourceStore"
import { openTaskInputResources } from "@core/input-semantics/TaskInputResourceStore"
import { exceedsInlineTextBudget } from "@shared/input-semantics/resource-policy"
import { CreateInputTextResourceRequest, CreateInputTextResourceResponse } from "@shared/proto/dline/task"
import { Logger } from "@shared/services/Logger"
import { Controller } from ".."
import { writableTaskIdOf } from "../file/input-resources"

/**
 * Stores an oversized composer paste as a file owned by the active task.
 *
 * Legacy entry kept until the composer stages through the typed input resource
 * RPCs: it delegates to the same store and only maps the result to the path
 * contract this response still carries.
 *
 * The composer cannot write to disk, and it must not choose the owning task
 * either: ownership decides the lifetime and the read scope of the copy, so the
 * active task is resolved here rather than accepted from the request. When no
 * task owns the input yet, or this window shows the task read-only, the text
 * stays in the composer instead of being written somewhere without an owner.
 */
export async function createInputTextResource(
    controller: Controller,
    request: CreateInputTextResourceRequest,
): Promise<CreateInputTextResourceResponse> {
    const taskId = writableTaskIdOf(controller)
    if (!taskId) {
        return CreateInputTextResourceResponse.create({ created: false, result: "missing_task" })
    }
    if (!exceedsInlineTextBudget(request.text)) {
        return CreateInputTextResourceResponse.create({ created: false, result: "within_inline_budget" })
    }

    try {
        const store = openTaskInputResources(taskId)
        const staged = await store.stageText(request.text, { extension: request.extension })
        const resolved = staged.ok ? await store.resolve(referenceOf(staged.value)) : staged
        if (!resolved.ok) {
            Logger.warn(`Failed to store an oversized composer paste: ${resolved.failure.code} ${resolved.failure.message}`)
            return CreateInputTextResourceResponse.create({ created: false, result: "write_failed" })
        }
        const { record, contentPath } = resolved.value
        return CreateInputTextResourceResponse.create({
            created: true,
            result: "created",
            resourceId: record.resourceId,
            absolutePath: contentPath,
            displayName: record.displayName,
            lineCount: record.lineCount ?? 0,
            byteSize: record.byteLength,
            contentHash: record.contentHash,
        })
    } catch (error) {
        Logger.error("Failed to store an oversized composer paste as a task input resource", error as Error)
        return CreateInputTextResourceResponse.create({ created: false, result: "write_failed" })
    }
}
