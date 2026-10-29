import { CloseAllDiffsRequest, CloseAllDiffsResponse } from "@/shared/proto/dline/host"
import { closeOpenedMultiFileDiffs } from "./openMultiFileDiff"

export async function closeAllDiffs(_request: CloseAllDiffsRequest): Promise<CloseAllDiffsResponse> {
    await closeOpenedMultiFileDiffs()
    return {}
}
