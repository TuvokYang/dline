import { errnoOf, resourceFailed, resourceSucceeded } from "@core/input-semantics/InputResourceFailure"
import { openFile } from "@integrations/misc/open-file"
import { InputResourceOperationResult, InputResourceRequest } from "@shared/proto/dline/file"
import { Controller } from ".."
import { referencedStoreFor, toOperationResult } from "./input-resources"

/**
 * Opens the verified local copy of an input resource.
 *
 * The Webview names the resource, never a path. The copy opens only when every
 * claim of the reference still matches its record and content, so a changed or
 * redirected resource fails closed instead of showing different bytes.
 */
export async function openInputResource(
    controller: Controller,
    request: InputResourceRequest,
): Promise<InputResourceOperationResult> {
    const target = referencedStoreFor(controller, request.draftId, request.ref)
    if (!target.ok) return toOperationResult(target)

    const resolved = await target.value.store.resolve(target.value.ref)
    if (!resolved.ok) return toOperationResult(resolved)

    try {
        await openFile(resolved.value.contentPath, false, true)
    } catch (error) {
        // The editor reports its own failures with paths; only the errno crosses to the Webview.
        return toOperationResult(
            resourceFailed(
                "semantic_input_resource_open_failed",
                `resource ${resolved.value.record.resourceId} could not be opened (${errnoOf(error)})`,
                resolved.value.record.resourceId,
            ),
        )
    }
    return toOperationResult(resourceSucceeded(undefined))
}
