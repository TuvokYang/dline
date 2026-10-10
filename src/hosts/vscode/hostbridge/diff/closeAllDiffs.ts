import { CloseAllDiffsRequest, CloseAllDiffsResponse } from "@/shared/proto/dline/host"

export async function closeAllDiffs(_request: CloseAllDiffsRequest): Promise<CloseAllDiffsResponse> {
    throw new Error("diffService is not supported. Use the VscodeDiffViewProvider.")
}
