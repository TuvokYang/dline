import { openDraftInputResources } from "@core/input-semantics/DraftInputResourceStore"
import { referenceOf } from "@core/input-semantics/InputResourceStore"
import { String as ProtoString } from "@shared/proto/dline/common"
import { StageAttachmentRequest } from "@shared/proto/dline/file"
import { ShowMessageType } from "@shared/proto/dline/host/window"
import { Logger } from "@shared/services/Logger"
import { HostProvider } from "@/hosts/host-provider"
import { Controller } from ".."

/**
 * Draft identity of attachments staged through the legacy path contract. Their
 * records are never referenced by identity, so one shared draft is enough; the
 * managed attachment area ages them out like any other staged attachment.
 */
const LEGACY_ATTACHMENT_DRAFT_ID = "legacy-attachments"

/**
 * Stages a file the user dropped or pasted into the composer that has no host path (the Webview only
 * sees its bytes). Returns the staged host path, or an empty value when the file was rejected; the
 * rejection reason has already been shown to the user.
 *
 * Legacy entry kept until the composer stages through `stageInputBytes`: it uses the same store, so
 * the bytes are classified and verified once, and only maps the result to the path contract.
 */
export async function stageAttachment(_controller: Controller, request: StageAttachmentRequest): Promise<ProtoString> {
    const store = openDraftInputResources(LEGACY_ATTACHMENT_DRAFT_ID)
    const staged = await store.stageBytes(request.fileName, request.data)
    const resolved = staged.ok ? await store.resolve(referenceOf(staged.value)) : staged
    if (!resolved.ok) {
        Logger.warn(`Rejected a staged attachment: ${resolved.failure.code}`)
        HostProvider.window.showMessage({
            type: ShowMessageType.ERROR,
            message: `Attachment skipped: ${resolved.failure.message}`,
        })
        return ProtoString.create({ value: "" })
    }
    return ProtoString.create({ value: resolved.value.contentPath })
}
