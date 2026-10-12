import type { UiMessage } from "@shared/ExtensionMessage"
import { SubmittedEntity } from "@/components/common/SubmittedEntity"
import { type SemanticHighlightSegment, segmentSubmittedInputs } from "@/services/input-semantics/highlight"

/** Render one segment, keeping a mention clickable and everything else plain. */
function renderSegment(segment: SemanticHighlightSegment, index: number, withShadow: boolean): JSX.Element | string {
    if (!segment.active || segment.role === "text") {
        return segment.text
    }
    return <SubmittedEntity key={`${segment.role}-${index}`} role={segment.role} text={segment.text} withShadow={withShadow} />
}

/**
 * Highlight an already-sent user row from the facts recorded when it was sent.
 *
 * Pure and catalog-free: the row says which commands ran and which mentions
 * were read, so a later catalog cannot change how it reads. A legacy row has no
 * facts and is shown as its plain text, never re-scanned for entities.
 */
export function highlightSubmittedMessage(
    message: Pick<UiMessage, "text" | "submittedInputs"> | null | undefined,
    withShadow = true,
): (string | JSX.Element)[] | string | undefined {
    const text = message?.text
    if (!text) return text
    const segments = segmentSubmittedInputs(message?.submittedInputs)
    if (!segments?.some((segment) => segment.active && segment.role !== "text")) return text
    return segments.map((segment, index) => renderSegment(segment, index, withShadow))
}
