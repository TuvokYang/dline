import { stageAttachmentBytes } from "@integrations/misc/process-files"
import { String as ProtoString } from "@shared/proto/dline/common"
import { StageAttachmentRequest } from "@shared/proto/dline/file"
import { Controller } from ".."

/**
 * Stages a file the user dropped or pasted into the composer that has no host path (the Webview only
 * sees its bytes). Returns the staged host path, or an empty value when the file was rejected; the
 * rejection reason has already been shown to the user.
 */
export async function stageAttachment(_controller: Controller, request: StageAttachmentRequest): Promise<ProtoString> {
	const stagedPath = await stageAttachmentBytes(request.fileName, request.data)
	return ProtoString.create({ value: stagedPath ?? "" })
}
