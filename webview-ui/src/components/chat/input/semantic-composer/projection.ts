import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import {
    type FileInputNode,
    type ImageInputNode,
    type InputSource,
    isMentionNode,
    isSlashCommandNode,
    type LiteralInputNode,
    type MentionInputNode,
    SEMANTIC_INPUT_SCHEMA_VERSION,
    type SemanticInputDocument,
    type SemanticInputNode,
    type SemanticResourceRef,
    type SlashCommandInputNode,
} from "@shared/input-semantics/document"
import { lexSemanticInput, type SemanticActivation, type SemanticTrigger, semanticTriggerAt } from "@shared/input-semantics/lexer"
import { presentationTextOf, presentationTextOfNode } from "@shared/input-semantics/presentation"
import {
    type ComposerAtom,
    type ComposerRange,
    type ComposerSegment,
    type ComposerTextSource,
    flatTextOf,
    segmentLength,
} from "./model"

/**
 * How the composer draft becomes the semantic document a submission sends.
 *
 * The draft is lexed once, as one flat text in which every atom is a single
 * placeholder character, so code fences, escapes and token boundaries read the
 * same as they would without atoms. A candidate the lexer finds is then
 * activated according to where its characters came from:
 * - typed text activates as it always has;
 * - pasted or restored text stays a candidate until the user confirms it;
 * - an editor selection, model text or an application's literal never even
 *   becomes a candidate;
 * - a candidate that runs into an atom stays text, because the atom is an
 *   entity on its own and the text around it cannot absorb it.
 * Atoms are entities the user chose as a whole and need no lexing at all.
 */

export interface ComposerProjectionContext {
    readonly catalog: InputSemanticCatalog
    readonly documentId: string
}

/** One lexed or chosen entity and the flat range it occupies in the draft. */
export interface ComposerEntitySpan {
    readonly range: ComposerRange
    readonly node: SlashCommandInputNode | MentionInputNode
    /** True when the user chose the entity as an atom rather than typing it. */
    readonly isAtom: boolean
}

export interface ComposerProjection {
    readonly document: SemanticInputDocument
    /** Every command and mention, in draft order, with its flat range; the view decorates text from these. */
    readonly entities: readonly ComposerEntitySpan[]
    /**
     * True when the document says something the plain text cannot: an atom, a
     * literal, or a candidate held back because the user did not type it. A
     * draft of typed text alone sends no document, so it does not depend on
     * this view's catalog revision.
     */
    readonly requiresDocument: boolean
    /** Resource atoms whose bytes are still being staged; the draft cannot be sent yet. */
    readonly stagingResources: readonly string[]
    /** Resource atoms whose staging failed; they must be retried or removed before sending. */
    readonly failedResources: readonly string[]
}

const LITERAL_SOURCES: ReadonlySet<InputSource> = new Set(["editor_selection", "model_prefill", "app_action"])
const HELD_SOURCES: ReadonlySet<InputSource> = new Set(["pasted", "restored"])

export function isLiteralSource(source: ComposerTextSource): boolean {
    return LITERAL_SOURCES.has(source)
}

interface PlacedSegment {
    readonly segment: ComposerSegment
    readonly start: number
    readonly end: number
}

function placeSegments(segments: readonly ComposerSegment[]): PlacedSegment[] {
    const placed: PlacedSegment[] = []
    let cursor = 0
    for (const segment of segments) {
        const end = cursor + segmentLength(segment)
        placed.push({ segment, start: cursor, end })
        cursor = end
    }
    return placed
}

function overlaps(left: ComposerRange, start: number, end: number): boolean {
    return left.start < end && start < left.end
}

function activationFor(placed: readonly PlacedSegment[]): (start: number, end: number) => SemanticActivation {
    return (start, end) => {
        let activation: SemanticActivation = "auto"
        for (const { segment, start: segmentStart, end: segmentEnd } of placed) {
            if (!overlaps({ start: segmentStart, end: segmentEnd }, start, end)) continue
            if (segment.kind === "atom" || isLiteralSource(segment.source)) return "opaque"
            if (HELD_SOURCES.has(segment.source)) activation = "candidate_only"
        }
        return activation
    }
}

function atomNode(atom: ComposerAtom): SemanticInputNode {
    switch (atom.kind) {
        case "command":
            return {
                kind: "slash_command",
                entityId: atom.entityId,
                commandId: atom.commandId,
                sourceText: atom.sourceText,
                canonicalName: atom.canonicalName,
                namespace: atom.namespace,
                compositionMode: atom.compositionMode,
                state: "recognized",
            }
        case "mention":
            return {
                kind: "mention",
                entityId: atom.entityId,
                mentionKind: atom.mentionKind,
                sourceText: atom.sourceText,
                canonicalRef: atom.canonicalRef,
                ...(atom.workspaceHint === undefined ? {} : { workspaceHint: atom.workspaceHint }),
                ...(atom.capturePolicy === undefined ? {} : { capturePolicy: atom.capturePolicy }),
                state: "recognized",
            }
        case "resource":
            if (atom.nodeKind === "image") {
                const image: ImageInputNode = {
                    kind: "image",
                    entityId: atom.entityId,
                    resourceId: atom.ref?.resourceId ?? atom.entityId,
                    displayName: atom.displayName,
                }
                return image
            }
            return {
                kind: "file",
                entityId: atom.entityId,
                resourceId: atom.ref?.resourceId ?? atom.entityId,
                fileOrigin: atom.fileOrigin,
                displayName: atom.displayName,
                ...(atom.lineCount === undefined ? {} : { lineCount: atom.lineCount }),
            } satisfies FileInputNode
    }
}

/** Split one lexed text node at segment edges into text, literal and atom nodes. */
function splitTextNode(text: string, start: number, placed: readonly PlacedSegment[]): SemanticInputNode[] {
    const end = start + text.length
    const nodes: SemanticInputNode[] = []
    for (const { segment, start: segmentStart, end: segmentEnd } of placed) {
        const from = Math.max(start, segmentStart)
        const to = Math.min(end, segmentEnd)
        if (from >= to) continue
        if (segment.kind === "atom") {
            nodes.push(atomNode(segment.atom))
            continue
        }
        const piece = text.slice(from - start, to - start)
        if (isLiteralSource(segment.source)) nodes.push({ kind: "literal", text: piece, source: segment.source })
        else nodes.push({ kind: "text", text: piece })
    }
    return nodes
}

/** Merge adjacent text nodes, and adjacent literals of one source, so the document has no empty seams. */
function mergeContent(nodes: readonly SemanticInputNode[]): SemanticInputNode[] {
    const merged: SemanticInputNode[] = []
    for (const node of nodes) {
        const last = merged[merged.length - 1]
        if (node.kind === "text" && last?.kind === "text") {
            merged[merged.length - 1] = { kind: "text", text: last.text + node.text }
            continue
        }
        if (node.kind === "literal" && last?.kind === "literal" && last.source === node.source) {
            merged[merged.length - 1] = { ...last, text: last.text + node.text } satisfies LiteralInputNode
            continue
        }
        merged.push(node)
    }
    return merged
}

function isEntity(node: SemanticInputNode): node is SlashCommandInputNode | MentionInputNode {
    return isSlashCommandNode(node) || isMentionNode(node)
}

/** Project the draft into the semantic document a submission sends. */
export function projectComposerDocument(
    segments: readonly ComposerSegment[],
    context: ComposerProjectionContext,
): ComposerProjection {
    const placed = placeSegments(segments)
    const flat = flatTextOf(segments)
    const lexed = lexSemanticInput(flat, {
        catalog: context.catalog,
        documentId: context.documentId,
        activationAt: activationFor(placed),
    })

    const nodes: SemanticInputNode[] = []
    const entities: ComposerEntitySpan[] = []
    let cursor = 0
    for (const node of lexed.nodes) {
        if (node.kind === "text") {
            nodes.push(...splitTextNode(node.text, cursor, placed))
            cursor += node.text.length
            continue
        }
        const length = presentationTextOfNode(node).length
        nodes.push(node)
        if (isEntity(node)) entities.push({ range: { start: cursor, end: cursor + length }, node, isAtom: false })
        cursor += length
    }

    const resources: SemanticResourceRef[] = []
    const stagingResources: string[] = []
    const failedResources: string[] = []
    let hasAtom = false
    for (const { segment, start } of placed) {
        if (segment.kind !== "atom") continue
        hasAtom = true
        const { atom } = segment
        if (atom.kind === "resource") {
            if (atom.status === "ready" && atom.ref) {
                // A pasted copy points at the same resource; the document binds each resource once.
                const { ref } = atom
                if (!resources.some((resource) => resource.resourceId === ref.resourceId)) resources.push(ref)
            } else if (atom.status === "staging") stagingResources.push(atom.entityId)
            else failedResources.push(atom.entityId)
            continue
        }
        const node = atomNode(atom)
        if (isEntity(node)) entities.push({ range: { start, end: start + 1 }, node, isAtom: true })
    }
    entities.sort((left, right) => left.range.start - right.range.start)

    const merged = mergeContent(nodes)
    const document: SemanticInputDocument = {
        schemaVersion: SEMANTIC_INPUT_SCHEMA_VERSION,
        parserVersion: lexed.parserVersion,
        catalogRevision: lexed.catalogRevision,
        documentId: context.documentId,
        rawText: "",
        nodes: merged,
        resources,
    }
    const heldCandidate = entities.some(({ range, isAtom }) => !isAtom && touchesHeldText(placed, range))
    const hasLiteral = merged.some((node) => node.kind === "literal")
    return {
        document: { ...document, rawText: presentationTextOf(document) },
        entities,
        requiresDocument: hasAtom || hasLiteral || heldCandidate,
        stagingResources,
        failedResources,
    }
}

/**
 * Whether a lexed candidate touches text the user did not type.
 *
 * Such a candidate is held whether or not the catalog knows it yet: a queued
 * or recalled draft may meet a catalog that has learnt it since, and only the
 * document keeps it held then. A typed candidate needs no document, because the
 * legacy adapter activates it exactly as this composer does.
 */
function touchesHeldText(placed: readonly PlacedSegment[], range: ComposerRange): boolean {
    return placed.some(
        ({ segment, start, end }) =>
            segment.kind === "text" && HELD_SOURCES.has(segment.source) && overlaps({ start, end }, range.start, range.end),
    )
}

/**
 * The command or mention the caret is completing, so the matching menu can open.
 *
 * Literal text never opens a menu: nothing written in it can become an entity.
 */
export function composerTriggerAt(segments: readonly ComposerSegment[], caret: number): SemanticTrigger | undefined {
    const trigger = semanticTriggerAt(flatTextOf(segments), caret)
    if (!trigger) return undefined
    const literal = placeSegments(segments).some(
        ({ segment, start, end }) =>
            segment.kind === "text" && isLiteralSource(segment.source) && overlaps({ start, end }, trigger.start, caret),
    )
    return literal ? undefined : trigger
}

/** Options for turning the draft into the text and document one submission sends. */
export interface ComposerSubmissionOptions extends ComposerProjectionContext {
    /**
     * Text the composer adds on the user's behalf, such as a quote. It is a
     * literal: the user did not type it, so nothing in it may run.
     */
    readonly literalPrefix?: string
    /**
     * Send the whole draft as plain text: every command, mention and piece of
     * text becomes a literal, so nothing in it runs or resolves. Attachments
     * stay attachments.
     */
    readonly plainText?: boolean
}

export interface ComposerSubmission {
    readonly text: string
    readonly semanticInput?: SemanticInputDocument
    readonly projection: ComposerProjection
}

/** Compose the text and, when it says more than the text, the document of one submission. */
export function composeComposerSubmission(
    segments: readonly ComposerSegment[],
    options: ComposerSubmissionOptions,
): ComposerSubmission {
    const prefixed: ComposerSegment[] = options.literalPrefix
        ? [{ kind: "text", text: options.literalPrefix, source: "app_action" }, ...segments]
        : [...segments]
    const projection = projectComposerDocument(prefixed, options)
    if (options.plainText) {
        const plain: SemanticInputDocument = { ...projection.document, nodes: plainTextNodes(prefixed), rawText: "" }
        const document = { ...plain, rawText: presentationTextOf(plain) }
        return { text: document.rawText, semanticInput: document, projection }
    }
    const { document } = projection
    return projection.requiresDocument
        ? { text: document.rawText, semanticInput: document, projection }
        : { text: document.rawText, projection }
}

/**
 * The draft as inert nodes: text keeps the source it came from but turns
 * literal, and a command or mention chip becomes the literal text it was
 * written as. A literal is opaque however it was written, so its source stays
 * truthful provenance rather than marking it inert.
 */
function plainTextNodes(segments: readonly ComposerSegment[]): SemanticInputNode[] {
    const nodes: SemanticInputNode[] = []
    for (const segment of segments) {
        if (segment.kind === "text") {
            if (segment.text) nodes.push({ kind: "literal", text: segment.text, source: segment.source })
            continue
        }
        const { atom } = segment
        if (atom.kind === "resource") nodes.push(atomNode(atom))
        else nodes.push({ kind: "literal", text: atom.sourceText, source: "typed" })
    }
    return mergeContent(nodes)
}
