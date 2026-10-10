import { OpenDiffRequest, OpenDiffResponse } from "@/shared/proto/dline/host"

export async function openDiff(_request: OpenDiffRequest): Promise<OpenDiffResponse> {
    throw new Error("diffService is not supported. Use the VscodeDiffViewProvider.")
}
