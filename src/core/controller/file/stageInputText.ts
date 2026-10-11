import { InputResourceStageResults, StageInputTextRequest } from "@shared/proto/dline/file"
import { Controller } from ".."
import { stagingStoreFor, toStageResults } from "./input-resources"

/** Stages composer text as an input resource the Host-chosen owner holds. */
export async function stageInputText(controller: Controller, request: StageInputTextRequest): Promise<InputResourceStageResults> {
    const store = stagingStoreFor(controller, request.draftId)
    if (!store.ok) return toStageResults([{ result: store }])
    return toStageResults([{ result: await store.value.stageText(request.text, { extension: request.extension }) }])
}
