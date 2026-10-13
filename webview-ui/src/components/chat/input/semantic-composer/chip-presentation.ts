import type { ResourceInputNode, SemanticResourceRef } from "@shared/input-semantics/document"
import { describeResourcePresentation, type ResourceVisualKind } from "@shared/input-semantics/presentation"
import type { ComposerAtom, ResourceAtom } from "./model"

/**
 * What one atom shows, independent of how it is drawn.
 *
 * The DOM renderer, tests and accessibility all read this one description, so
 * an icon, a badge or a screen-reader name can never disagree with each other.
 */
export interface ChipPresentation {
    /** Codicon name, without the `codicon-` prefix. */
    readonly icon: string
    readonly label: string
    /** Short uppercase format, e.g. "PDF"; absent for commands and mentions. */
    readonly badge?: string
    readonly tone: "command" | "mention" | "resource" | "warning" | "error"
    /** Full screen-reader name: kind, name, format and state. */
    readonly ariaLabel: string
    readonly tooltip: string
    /** True while the host is still staging the bytes. */
    readonly busy: boolean
    /** The text this atom contributes when the draft is read as plain text. */
    readonly plainText: string
}

const ICON_BY_VISUAL_KIND: Readonly<Record<ResourceVisualKind, string>> = {
    image: "file-media",
    pdf: "file-pdf",
    text: "note",
    code: "file-code",
    document: "book",
    spreadsheet: "table",
    notebook: "notebook",
    data: "json",
    file: "file",
}

/** Spoken kind of each visual family. */
const KIND_NAME_BY_VISUAL_KIND: Readonly<Record<ResourceVisualKind, string>> = {
    image: "Image",
    pdf: "PDF document",
    text: "Text file",
    code: "Code file",
    document: "Document",
    spreadsheet: "Spreadsheet",
    notebook: "Notebook",
    data: "Data file",
    file: "File",
}

/** What a composer chip tells the user its keys do. */
const COMPOSER_CHIP_HINT = "Press Enter to open, Backspace to remove."

/**
 * A ready resource's chip, wherever an input names it: the composer, a queued
 * entry or a sent row.
 *
 * `hint` names what the surrounding surface lets the user do with the chip; a
 * surface that offers nothing passes none, so the tooltip never promises a key
 * or click that does not work there.
 */
export function describeResourceChip(node: ResourceInputNode, resource?: SemanticResourceRef, hint?: string): ChipPresentation {
    const { visualKind, formatBadge } = describeResourcePresentation(node, resource)
    const lineCount = node.kind === "file" ? node.lineCount : undefined
    const lines = lineCount === undefined ? "" : `, ${lineCount} lines`
    const summary = `${node.displayName} (${formatBadge}${lines})`
    return {
        icon: ICON_BY_VISUAL_KIND[visualKind],
        label: node.displayName,
        badge: formatBadge,
        tone: "resource",
        ariaLabel: `${KIND_NAME_BY_VISUAL_KIND[visualKind]} ${node.displayName}, ${formatBadge}${lines}`,
        tooltip: hint ? `${summary}. ${hint}` : summary,
        busy: false,
        plainText: "",
    }
}

function resourceNodeOf(atom: ResourceAtom): ResourceInputNode {
    return atom.nodeKind === "image"
        ? {
              kind: "image",
              entityId: atom.entityId,
              resourceId: atom.ref?.resourceId ?? atom.entityId,
              displayName: atom.displayName,
          }
        : {
              kind: "file",
              entityId: atom.entityId,
              resourceId: atom.ref?.resourceId ?? atom.entityId,
              fileOrigin: atom.fileOrigin,
              displayName: atom.displayName,
              lineCount: atom.lineCount,
          }
}

function describeResource(atom: ResourceAtom): ChipPresentation {
    const node = resourceNodeOf(atom)
    if (atom.status === "ready") return describeResourceChip(node, atom.ref, COMPOSER_CHIP_HINT)
    const { visualKind, formatBadge } = describeResourcePresentation(node, atom.ref)
    const kindName = KIND_NAME_BY_VISUAL_KIND[visualKind]
    if (atom.status === "failed") {
        const reason = atom.error?.message ?? "The attachment could not be added."
        return {
            icon: "error",
            label: atom.displayName,
            badge: formatBadge,
            tone: "error",
            ariaLabel: `${kindName} ${atom.displayName}, ${formatBadge}, failed: ${reason}`,
            tooltip: `${atom.displayName}: ${reason}`,
            busy: false,
            plainText: "",
        }
    }
    return {
        icon: "loading",
        label: atom.displayName,
        badge: formatBadge,
        tone: "warning",
        ariaLabel: `${kindName} ${atom.displayName}, ${formatBadge}, attaching`,
        tooltip: `Attaching ${atom.displayName}…`,
        busy: true,
        plainText: "",
    }
}

export function describeChip(atom: ComposerAtom): ChipPresentation {
    switch (atom.kind) {
        case "command":
            return {
                icon: "symbol-event",
                label: atom.sourceText,
                tone: "command",
                ariaLabel: `Command ${atom.sourceText}`,
                tooltip: `Command ${atom.sourceText}`,
                busy: false,
                plainText: atom.sourceText,
            }
        case "mention":
            return {
                icon: atom.mentionKind === "folder" ? "folder" : atom.mentionKind === "url" ? "link" : "mention",
                label: atom.sourceText.slice(1),
                tone: "mention",
                ariaLabel: `Mention ${atom.sourceText}`,
                tooltip: atom.sourceText,
                busy: false,
                plainText: atom.sourceText,
            }
        case "resource":
            return describeResource(atom)
    }
}
