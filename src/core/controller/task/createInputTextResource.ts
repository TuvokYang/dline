import { TaskInputResourceStore } from "@core/input-semantics/TaskInputResourceStore"
import { exceedsInlineTextBudget } from "@shared/input-semantics/resource-policy"
import { CreateInputTextResourceRequest, CreateInputTextResourceResponse } from "@shared/proto/dline/task"
import { Logger } from "@shared/services/Logger"
import { Controller } from ".."

const SAFE_EXTENSION_PATTERN = /^[A-Za-z0-9]{1,16}$/
const DEFAULT_EXTENSION = "txt"

/**
 * Stores an oversized composer paste as a file owned by the active task.
 *
 * The composer cannot write to disk, and it must not choose the owning task
 * either: ownership decides the lifetime and the read scope of the copy, so the
 * active task is resolved here rather than accepted from the request. When no
 * task owns the input yet, the text stays in the composer instead of being
 * written somewhere without an owner.
 */
export async function createInputTextResource(
    controller: Controller,
    request: CreateInputTextResourceRequest,
): Promise<CreateInputTextResourceResponse> {
    const taskId = controller.task?.taskId
    if (!taskId) {
        return CreateInputTextResourceResponse.create({ created: false, result: "missing_task" })
    }
    if (!exceedsInlineTextBudget(request.text)) {
        return CreateInputTextResourceResponse.create({ created: false, result: "within_inline_budget" })
    }

    try {
        const resource = await new TaskInputResourceStore(taskId).storeText(request.text, safeExtension(request.extension))
        return CreateInputTextResourceResponse.create({
            created: true,
            result: "created",
            resourceId: resource.resourceId,
            absolutePath: resource.absolutePath,
            displayName: resource.displayName,
            lineCount: resource.lineCount,
            byteSize: resource.byteSize,
            contentHash: resource.contentHash,
        })
    } catch (error) {
        Logger.error("Failed to store an oversized composer paste as a task input resource", error as Error)
        return CreateInputTextResourceResponse.create({ created: false, result: "write_failed" })
    }
}

/** Keep the caller's language hint only when it is a plain extension. */
function safeExtension(extension: string | undefined): string {
    return extension && SAFE_EXTENSION_PATTERN.test(extension) ? extension : DEFAULT_EXTENSION
}
