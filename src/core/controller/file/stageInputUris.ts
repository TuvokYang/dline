import * as path from "node:path"
import { resourceFailed } from "@core/input-semantics/InputResourceFailure"
import { InputResourceStageResults, StageInputUrisRequest } from "@shared/proto/dline/file"
import { URI } from "vscode-uri"
import { Controller } from ".."
import { type StageOutcome, stagingStoreFor, toStageResults } from "./input-resources"

/**
 * Stages copies of dropped or pasted file URIs.
 *
 * The copy, not the source path, becomes the input: a later edit or deletion of
 * the source cannot change what this input carries.
 */
export async function stageInputUris(controller: Controller, request: StageInputUrisRequest): Promise<InputResourceStageResults> {
    const store = stagingStoreFor(controller, request.draftId)
    const outcomes: StageOutcome[] = []
    for (const uri of request.uris) {
        const filePath = fileSystemPathOf(uri)
        if (!filePath) {
            outcomes.push({ result: resourceFailed("semantic_input_resource_invalid", "a dropped item is not a local file") })
            continue
        }
        const result = store.ok ? await store.value.stageFile(filePath) : store
        outcomes.push({ result, requestedName: path.basename(filePath) })
    }
    return toStageResults(outcomes)
}

function fileSystemPathOf(uri: string): string | undefined {
    try {
        const parsed = URI.parse(uri, true)
        return parsed.scheme === "file" && parsed.fsPath ? parsed.fsPath : undefined
    } catch {
        return undefined
    }
}
