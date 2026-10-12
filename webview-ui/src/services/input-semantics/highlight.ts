import {
    normalizeSubmittedInputs,
    SUBMITTED_INPUT_SEPARATOR,
    type SubmittedInputFacts,
} from "@shared/input-semantics/submitted-input"

export type SemanticSegmentRole = "text" | "command" | "mention"

export interface SemanticHighlightSegment {
    readonly text: string
    readonly role: SemanticSegmentRole
    /**
     * Whether the entity still acts as an entity.
     *
     * An unrecognized mention, or anything a lifecycle barrier pushed into the
     * pre-message, reads as literal text and must not look like an entity.
     */
    readonly active: boolean
}

/**
 * The segments of an already-sent row, from the facts recorded when it was sent.
 *
 * History never lexes sent text again: the catalog may have gained, renamed or
 * withdrawn a command since, and re-reading would show a literal `/compact` as
 * a command or hide one that ran. A resource reads as text here; the row names
 * it, and only commands and mentions are drawn as entities. A row without facts
 * is legacy and has no segments, so its caller shows the plain text.
 */
export function segmentSubmittedInputs(
    inputs: readonly SubmittedInputFacts[] | undefined,
): readonly SemanticHighlightSegment[] | undefined {
    if (!inputs || inputs.length === 0) return undefined
    return inputs.flatMap((input, index) => [
        ...(index > 0 ? [{ text: SUBMITTED_INPUT_SEPARATOR, role: "text" as const, active: false }] : []),
        ...input.segments.map(
            (segment): SemanticHighlightSegment =>
                segment.role === "command" || segment.role === "mention"
                    ? { text: segment.text, role: segment.role, active: segment.active }
                    : { text: segment.text, role: "text", active: false },
        ),
    ])
}

/** Link target that marks an active entity inside a sent row's Markdown. */
const SUBMITTED_ENTITY_HREF = "#dline-entity/"

/** An active command or mention a sent row's Markdown marks for the renderer. */
export interface SubmittedEntityLink {
    readonly role: Exclude<SemanticSegmentRole, "text">
    readonly text: string
}

/** Backslash-escape everything Markdown could read as syntax inside link text. */
function escapeMarkdownText(text: string): string {
    return text.replace(/[\\`*_[\]<>()#!|~&]/g, "\\$&")
}

/**
 * A sent row's Markdown with every active command and mention marked as an
 * entity link, from the facts recorded when it was sent.
 *
 * The row keeps its Markdown, so a fenced selection still reads as code; only
 * the entities the task actually ran or read are marked, and nothing is lexed
 * again. Facts that do not spell the row's text, a legacy row and a row without
 * active entities all return `undefined`, and the caller shows the plain text.
 */
export function markSubmittedEntities(
    text: string | undefined,
    inputs: readonly SubmittedInputFacts[] | undefined,
): string | undefined {
    if (!text) return undefined
    const segments = segmentSubmittedInputs(normalizeSubmittedInputs(inputs, text))
    if (!segments?.some((segment) => segment.active && segment.role !== "text")) return undefined
    return segments
        .map((segment) =>
            segment.active && segment.role !== "text"
                ? `[${escapeMarkdownText(segment.text)}](${SUBMITTED_ENTITY_HREF}${segment.role}/${encodeURIComponent(segment.text)})`
                : segment.text,
        )
        .join("")
}

/** The entity a link written by {@link markSubmittedEntities} names, or `undefined` for any other link. */
export function parseSubmittedEntityLink(href: string | undefined): SubmittedEntityLink | undefined {
    if (!href?.startsWith(SUBMITTED_ENTITY_HREF)) return undefined
    const [role, ...rest] = href.slice(SUBMITTED_ENTITY_HREF.length).split("/")
    if (role !== "command" && role !== "mention") return undefined
    try {
        return { role, text: decodeURIComponent(rest.join("/")) }
    } catch {
        return undefined
    }
}
