import * as path from "node:path"
import { resourceFailed } from "@core/input-semantics/InputResourceFailure"
import { ATTACHABLE_FILE_EXTENSIONS, ATTACHABLE_IMAGE_EXTENSIONS, isAttachableImageName } from "@shared/attachments"
import { InputResourceStageResults, SelectInputResourcesRequest } from "@shared/proto/dline/file"
import { HostProvider } from "@/hosts/host-provider"
import { Controller } from ".."
import { openStagingStore, type StageOutcome, sameStagingTarget, stagingTargetOf, toStageResults } from "./input-resources"

/**
 * Prompts for files and links each selection by its local path.
 *
 * A picked file is read from its path whenever the input is used, as an
 * attached path always was; only pasted content is captured as a copy.
 * The owner is resolved before the picker opens and checked again after it
 * closes: the dialog can stay open while the user switches tasks, and the
 * selection belongs to the composer they started from, not to whichever task
 * is active afterwards. Picker filters are advisory on some platforms, so an
 * image picked while the model cannot read images is rejected here rather than
 * trusted to the dialog. The dialog cannot cap how many files are picked, so
 * only as many as fit in the draft are linked; the rest are never read.
 */
export async function selectInputResources(
    controller: Controller,
    request: SelectInputResourcesRequest,
): Promise<InputResourceStageResults> {
    const target = stagingTargetOf(controller, request.draftId)
    if (!target.ok) return toStageResults([{ result: target }])
    const maxCount = request.maxCount ?? Number.POSITIVE_INFINITY
    if (maxCount <= 0) return toStageResults([])

    const extensions = request.imagesAllowed
        ? [...ATTACHABLE_IMAGE_EXTENSIONS, ...ATTACHABLE_FILE_EXTENSIONS]
        : [...ATTACHABLE_FILE_EXTENSIONS]
    const selection = await HostProvider.window.showOpenDialogue({
        canSelectMany: maxCount > 1,
        openLabel: "Select",
        filters: { files: extensions },
    })

    const current = stagingTargetOf(controller, request.draftId)
    const store =
        current.ok && sameStagingTarget(target.value, current.value)
            ? openStagingStore(target.value)
            : resourceFailed("semantic_input_resource_invalid", "the composer changed while files were being selected")
    const outcomes: StageOutcome[] = []
    for (const filePath of (selection.paths ?? []).slice(0, maxCount)) {
        const name = path.basename(filePath)
        if (!request.imagesAllowed && isAttachableImageName(name)) {
            outcomes.push({
                result: resourceFailed(
                    "semantic_input_resource_invalid_mime",
                    `${name} is an image, which the current model cannot read`,
                ),
                requestedName: name,
            })
            continue
        }
        const result = store.ok ? await store.value.linkFile(filePath) : store
        outcomes.push({ result, requestedName: name })
    }
    return toStageResults(outcomes)
}
