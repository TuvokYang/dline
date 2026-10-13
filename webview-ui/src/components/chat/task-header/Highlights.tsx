import type { UiMessage } from "@shared/ExtensionMessage"
import { LinkedResourceChip } from "@/components/common/ResourceChip"
import { SubmittedEntity } from "@/components/common/SubmittedEntity"
import {
    resourceNameOfSegment,
    type SemanticHighlightSegment,
    segmentSubmittedInputs,
} from "@/services/input-semantics/highlight"

/** Render one segment: a mention stays clickable, a resource is its chip, everything else is plain. */
function renderSegment(segment: SemanticHighlightSegment, index: number, withShadow: boolean): JSX.Element | string {
    if (!segment.active || segment.role === "text") {
        return segment.text
    }
    const key = `${segment.role}-${index}`
    if (segment.role === "resource") {
        return <LinkedResourceChip displayName={resourceNameOfSegment(segment.text)} entityKey={String(index)} key={key} />
    }
    return <SubmittedEntity key={key} role={segment.role} text={segment.text} withShadow={withShadow} />
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
