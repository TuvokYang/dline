import { resourceFailed } from "@core/input-semantics/InputResourceFailure"
import { InputResourceOperationResult, InputResourceRequest } from "@shared/proto/dline/file"
import { Controller } from ".."
import { referencedStoreFor, toOperationResult } from "./input-resources"

/**
 * Removes a resource the composer draft no longer references.
 *
 * Only draft-owned resources are removable from the composer: a task-owned
 * resource may still be referenced by history, queued input or a retry, and is
 * removed only with its task.
 */
export async function removeInputResource(
    controller: Controller,
    request: InputResourceRequest,
): Promise<InputResourceOperationResult> {
    const target = referencedStoreFor(controller, request.draftId, request.ref)
    if (!target.ok) return toOperationResult(target)

    const { ref, store } = target.value
    if (ref.owner.kind !== "draft") {
        return toOperationResult(
            resourceFailed(
                "semantic_input_resource_invalid",
                `resource ${ref.resourceId} belongs to a task and stays with it`,
                ref.resourceId,
            ),
        )
    }
    return toOperationResult(await store.remove(ref.resourceId))
}
