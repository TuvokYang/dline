import { InputResourceStageResults, StageInputBytesRequest } from "@shared/proto/dline/file"
import { Controller } from ".."
import { type StageOutcome, stagingStoreFor, toStageResults } from "./input-resources"

/** Stages files that only exist as bytes in the composer; one result per file, in request order. */
export async function stageInputBytes(
    controller: Controller,
    request: StageInputBytesRequest,
): Promise<InputResourceStageResults> {
    const store = stagingStoreFor(controller, request.draftId)
    const outcomes: StageOutcome[] = []
    for (const file of request.files) {
        const result = store.ok ? await store.value.stageBytes(file.fileName, file.data) : store
        outcomes.push({ result, requestedName: file.fileName })
    }
    return toStageResults(outcomes)
}
