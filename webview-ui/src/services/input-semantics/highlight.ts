import { isResourceNode, type SemanticInputDocument, type SemanticResourceRef } from "@shared/input-semantics/document"
import { presentationTextOfNode } from "@shared/input-semantics/presentation"
import {
    normalizeSubmittedInputs,
    SUBMITTED_INPUT_SEPARATOR,
    type SubmittedInputFacts,
} from "@shared/input-semantics/submitted-input"

export type SemanticSegmentRole = "text" | "command" | "mention" | "resource"

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
    /** The stored resource a sent resource segment names, when its row recorded one. */
    readonly resource?: SemanticResourceRef
}

/**
 * The segments of an already-sent row, from the facts recorded when it was sent.
 *
 * History never lexes sent text again: the catalog may have gained, renamed or
 * withdrawn a command since, and re-reading would show a literal `/compact` as
 * a command or hide one that ran. A resource keeps its role, so the row draws
 * it as the chip the composer showed. A row without facts is legacy and has no
 * segments, so its caller shows the plain text.
 */
export function segmentSubmittedInputs(
    inputs: readonly SubmittedInputFacts[] | undefined,
): readonly SemanticHighlightSegment[] | undefined {
    if (!inputs || inputs.length === 0) return undefined
    return inputs.flatMap((input, index) => [
        ...(index > 0 ? [{ text: SUBMITTED_INPUT_SEPARATOR, role: "text" as const, active: false }] : []),
        ...input.segments.map(
            (segment): SemanticHighlightSegment =>
                segment.role === "text"
                    ? { text: segment.text, role: "text", active: false }
                    : {
                          text: segment.text,
                          role: segment.role,
                          active: segment.active,
                          ...(segment.resource ? { resource: segment.resource } : {}),
                      },
        ),
    ])
}

/** Link target that marks an active entity inside a sent row's Markdown. */
const SUBMITTED_ENTITY_HREF = "#dline-entity/"

/**
 * An entity a sent or queued row's Markdown marks for the renderer.
 *
 * A resource link carries a key its surface resolves to the full resource -
 * a queued entry still holds its document - and the display name, which is
 * all a sent row recorded and all the renderer needs when nothing resolves.
 */
export type SubmittedEntityLink =
    | { readonly role: "command" | "mention"; readonly text: string }
    | { readonly role: "resource"; readonly key: string; readonly text: string }

/** Backslash-escape everything Markdown could read as syntax inside link text. */
function escapeMarkdownText(text: string): string {
    return text.replace(/[\\`*_[\]<>()#!|~&]/g, "\\$&")
}

/** The display name a resource segment names; the segment shows it as `[name]`. */
export function resourceNameOfSegment(text: string): string {
    return /^\[(.*)\]$/s.exec(text)?.[1] ?? text
}

function resourceLink(key: string, displayName: string): string {
    return `[${escapeMarkdownText(displayName)}](${SUBMITTED_ENTITY_HREF}resource/${encodeURIComponent(key)}/${encodeURIComponent(displayName)})`
}

function entityLink(segment: SemanticHighlightSegment, index: number): string {
    if (segment.role === "resource") return resourceLink(String(index), resourceNameOfSegment(segment.text))
    return `[${escapeMarkdownText(segment.text)}](${SUBMITTED_ENTITY_HREF}${segment.role}/${encodeURIComponent(segment.text)})`
}

function isMarkedEntity(segment: SemanticHighlightSegment): boolean {
    return segment.active && segment.role !== "text"
}

/**
 * A sent row's Markdown with every active command, mention and resource marked
 * as an entity link, from the facts recorded when it was sent.
 *
 * The row keeps its Markdown, so a fenced selection still reads as code; only
 * the entities the task actually ran, read or received are marked, and nothing
 * is lexed again. A resource link is keyed by its segment's position, the only
 * identity a sent row keeps. Facts that do not spell the row's text, a legacy
 * row and a row without active entities all return `undefined`, and the caller
 * shows the plain text.
 */
export function markSubmittedEntities(
    text: string | undefined,
    inputs: readonly SubmittedInputFacts[] | undefined,
): string | undefined {
    if (!text) return undefined
    const segments = segmentSubmittedInputs(normalizeSubmittedInputs(inputs, text))
    if (!segments?.some(isMarkedEntity)) return undefined
    return segments.map((segment, index) => (isMarkedEntity(segment) ? entityLink(segment, index) : segment.text)).join("")
}

/** A resource a sent row recorded, with the name its chip shows. */
export interface SubmittedResource {
    readonly displayName: string
    readonly resource: SemanticResourceRef
}

/**
 * The stored resources of a sent row, keyed as {@link markSubmittedEntities}
 * keys its resource links, so the row can open the chip a link names.
 *
 * Only active resource segments that recorded their stored resource appear;
 * a legacy row, or facts that do not spell the row's text, resolve nothing.
 */
export function submittedResourcesByKey(
    text: string | undefined,
    inputs: readonly SubmittedInputFacts[] | undefined,
): ReadonlyMap<string, SubmittedResource> {
    const resources = new Map<string, SubmittedResource>()
    if (!text) return resources
    segmentSubmittedInputs(normalizeSubmittedInputs(inputs, text))?.forEach((segment, index) => {
        if (segment.role !== "resource" || !segment.active || !segment.resource) return
        resources.set(String(index), { displayName: resourceNameOfSegment(segment.text), resource: segment.resource })
    })
    return resources
}

/**
 * A queued entry's Markdown, with every resource marked as an entity link keyed
 * by its node's entity id, so the queue can resolve the link to the resource
 * its document still holds. Everything else reads as the entry's text does.
 */
export function markDocumentResources(document: SemanticInputDocument): string {
    return document.nodes
        .map((node) => (isResourceNode(node) ? resourceLink(node.entityId, node.displayName) : presentationTextOfNode(node)))
        .join("")
}

/** The entity a link written by {@link markSubmittedEntities} or {@link markDocumentResources} names, or `undefined` for any other link. */
export function parseSubmittedEntityLink(href: string | undefined): SubmittedEntityLink | undefined {
    if (!href?.startsWith(SUBMITTED_ENTITY_HREF)) return undefined
    const [role, ...rest] = href.slice(SUBMITTED_ENTITY_HREF.length).split("/")
    try {
        if (role === "command" || role === "mention") return { role, text: decodeURIComponent(rest.join("/")) }
        if (role === "resource" && rest.length === 2) {
            return { role, key: decodeURIComponent(rest[0]), text: decodeURIComponent(rest[1]) }
        }
    } catch {
        // A malformed escape is not a link this module wrote.
    }
    return undefined
}
