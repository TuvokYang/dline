import type { UiMessage } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/dline/common"
import { FileServiceClient } from "@/services/grpc-client"
import { type SemanticHighlightSegment, segmentSubmittedInputs } from "@/services/input-semantics/highlight"

function highlightClass(withShadow: boolean): string {
    return withShadow ? "mention-context-highlight-with-shadow" : "mention-context-highlight"
}

/** Render one segment, keeping a mention clickable and everything else plain. */
function renderSegment(segment: SemanticHighlightSegment, index: number, withShadow: boolean): JSX.Element | string {
    if (!segment.active || segment.role === "text") {
        return segment.text
    }
    if (segment.role === "mention") {
        // The lexer keeps the leading `@` in the source text, while openMention
        // addresses the target without it.
        const target = segment.text.replace(/^@/, "")
        return (
            // A button rather than a span: opening a mention is an action, so it
            // has to be reachable and activatable from the keyboard.
            <button
                className={`${highlightClass(withShadow)} cursor-pointer bg-transparent border-0 p-0 font-inherit`}
                key={`mention-${index}`}
                onClick={() => FileServiceClient.openMention(StringRequest.create({ value: target }))}
                type="button">
                {segment.text}
            </button>
        )
    }
    return (
        <span className={highlightClass(withShadow)} key={`command-${index}`}>
            {segment.text}
        </span>
    )
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
