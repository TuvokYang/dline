import type { AdmittedInputPart } from "@shared/input-semantics/admitted-parts"
import { Logger } from "@shared/services/Logger"
import type { InteractionDraft } from "./InteractionResponse"

/** A draft's resources in the flat shape its receivers read. */
export interface DraftAttachments {
    /** Image data URLs of exactly the bytes the store verified. */
    readonly images: readonly string[]
    /** Paths a receiver may read: a captured resource's own copy, or the file a linked resource names. */
    readonly files: readonly string[]
    /** One line per resource that could not be resolved, so the receiver says it is missing instead of omitting it. */
    readonly notices: readonly string[]
}

/**
 * Resolves a draft's admitted resource parts for receivers that read flat attachments.
 *
 * A draft persists its parts, never these lists: resolving happens only when a
 * receiver consumes the draft, so the journal holds no image data or local
 * path as an attachment's authority, and a reopened task resolves the same
 * parts again.
 */
export interface DraftAttachmentPort {
    resolve(parts: readonly AdmittedInputPart[]): Promise<DraftAttachments>
}

/**
 * The draft a flat-reading receiver is handed: its legacy lists plus its resolved parts.
 *
 * A draft without resource parts is returned unchanged. Otherwise the text is
 * projected from the parts, so a receiver reads each resource by name where the
 * user placed it instead of its stable id, and the parts are dropped: the
 * returned draft is a receiver's view, and keeping both carriers would let a
 * receiver that persists it again send every resource twice.
 *
 * Never rejects. The answer is already durable when this runs, so a port that
 * cannot read reports every resource as unavailable instead of failing the
 * receiver or stranding an unowned dialog.
 */
export async function resolveDraftForReceiver(
    draft: InteractionDraft,
    port: DraftAttachmentPort | undefined,
): Promise<InteractionDraft> {
    const parts = draft.admittedParts
    if (!parts?.some((part) => part.kind === "resource")) return draft
    const resolved = await resolveOrReport(parts, port)
    const { admittedParts: _resolvedParts, ...receiverDraft } = draft
    return {
        ...receiverDraft,
        text: [textOfParts(parts), ...resolved.notices].filter((line) => line.length > 0).join("\n"),
        images: [...draft.images, ...resolved.images],
        files: [...draft.files, ...resolved.files],
    }
}

async function resolveOrReport(
    parts: readonly AdmittedInputPart[],
    port: DraftAttachmentPort | undefined,
): Promise<DraftAttachments> {
    if (!port) return unresolvedAttachments(parts)
    try {
        return await port.resolve(parts)
    } catch (error) {
        Logger.warn(`[DraftAttachments] could not resolve draft resources: ${error instanceof Error ? error.name : "unknown"}`)
        return unresolvedAttachments(parts)
    }
}

/** The parts as a person reads them: text as composed, each resource by its display name. */
function textOfParts(parts: readonly AdmittedInputPart[]): string {
    return parts.map((part) => (part.kind === "text" ? part.text : `[${part.displayName}]`)).join("")
}

function unresolvedAttachments(parts: readonly AdmittedInputPart[]): DraftAttachments {
    const notices = parts.flatMap((part) =>
        part.kind === "resource" ? [unavailableAttachmentNotice(part.displayName, "semantic_input_resource_open_failed")] : [],
    )
    return { images: [], files: [], notices }
}

/** Names the attachment and why it is missing; never a path or its content. */
export function unavailableAttachmentNotice(displayName: string, code: string): string {
    return `[The attached resource "${displayName}" is unavailable: ${code}]`
}
