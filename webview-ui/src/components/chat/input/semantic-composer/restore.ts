import {
    type ResourceInputNode,
    resourceRefOf,
    type SemanticInputDocument,
    type SemanticInputNode,
} from "@shared/input-semantics/document"
import { semanticCandidateSpans } from "@shared/input-semantics/lexer"
import { createReadyResourceAtom } from "./atoms"
import { type ComposerAtom, type ComposerSegment, normalizeComposerText, normalizeSegments, type ResourceAtom } from "./model"

/**
 * Turn a draft that left the composer back into composer segments.
 *
 * Only what the document recorded as the user's confirmed intent comes back
 * live: recognized commands and mentions return as atoms, bound resources as
 * ready resource atoms. Everything else returns as restored text, which holds
 * any candidate in it until the user confirms it, so no later edit can complete
 * text the user never typed into a command.
 */

function resourceAtomOf(document: SemanticInputDocument, node: ResourceInputNode): ResourceAtom {
    const ref = resourceRefOf(document, node)
    if (!ref) {
        return {
            kind: "resource",
            entityId: node.entityId,
            nodeKind: node.kind,
            fileOrigin: node.kind === "file" ? node.fileOrigin : "pasted_file",
            displayName: node.displayName,
            status: "failed",
            error: { code: "semantic_input_resource_missing", message: "The attachment is no longer available." },
        }
    }
    return createReadyResourceAtom(
        {
            ref,
            displayName: node.displayName,
            nodeKind: node.kind,
            fileOrigin: node.kind === "file" ? node.fileOrigin : "pasted_file",
            ...(node.kind === "file" && node.lineCount !== undefined ? { lineCount: node.lineCount } : {}),
        },
        node.entityId,
    )
}

function entityAtomOf(node: SemanticInputNode): ComposerAtom | undefined {
    if (node.kind === "slash_command" && node.state === "recognized") {
        return {
            kind: "command",
            entityId: node.entityId,
            commandId: node.commandId,
            sourceText: node.sourceText,
            canonicalName: node.canonicalName,
            namespace: node.namespace,
            compositionMode: node.compositionMode,
        }
    }
    if (node.kind === "mention" && node.state === "recognized") {
        return {
            kind: "mention",
            entityId: node.entityId,
            mentionKind: node.mentionKind,
            sourceText: node.sourceText,
            canonicalRef: node.canonicalRef,
            ...(node.workspaceHint === undefined ? {} : { workspaceHint: node.workspaceHint }),
            ...(node.capturePolicy === undefined ? {} : { capturePolicy: node.capturePolicy }),
        }
    }
    return undefined
}

export function segmentsFromDocument(document: SemanticInputDocument): ComposerSegment[] {
    const segments: ComposerSegment[] = []
    for (const node of document.nodes) {
        switch (node.kind) {
            case "text":
                segments.push({ kind: "text", text: node.text, source: "restored" })
                break
            case "literal":
                segments.push({ kind: "text", text: node.text, source: node.source })
                break
            case "image":
            case "file":
                segments.push({ kind: "atom", atom: resourceAtomOf(document, node) })
                break
            case "slash_command":
            case "mention": {
                const atom = entityAtomOf(node)
                segments.push(atom ? { kind: "atom", atom } : { kind: "text", text: node.sourceText, source: "restored" })
                break
            }
        }
    }
    return normalizeSegments(segments)
}

/**
 * Segments of a draft recalled without a document.
 *
 * A composition carries a document whenever a held character touches any
 * candidate, so every candidate of a draft without one was typed and stays
 * live. The other characters cannot be told apart and come back held.
 */
export function segmentsFromRecalledText(text: string): ComposerSegment[] {
    const normalized = normalizeComposerText(text)
    const segments: ComposerSegment[] = []
    let cursor = 0
    for (const span of semanticCandidateSpans(normalized)) {
        segments.push({ kind: "text", text: normalized.slice(cursor, span.start), source: "restored" })
        segments.push({ kind: "text", text: normalized.slice(span.start, span.end), source: "typed" })
        cursor = span.end
    }
    segments.push({ kind: "text", text: normalized.slice(cursor), source: "restored" })
    return normalizeSegments(segments)
}

/** The segments of a draft that left the composer and came back, with its document when one survived. */
export function segmentsForRecalledDraft(text: string, document?: SemanticInputDocument): ComposerSegment[] {
    return document && document.rawText === text ? segmentsFromDocument(document) : segmentsFromRecalledText(text)
}
