import type { ResourceInputNode, SemanticResourceRef } from "@shared/input-semantics/document"
import { describeResourcePresentation, type ResourceVisualKind } from "@shared/input-semantics/presentation"
import { translateUi, type UiTranslator } from "@/i18n/messages"
import type { ComposerAtom, ResourceAtom } from "./model"

const englishUi: UiTranslator = (key, ...args) => translateUi("en", key, ...args)

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
    /**
     * Whether the label is kept off the chip's face. An image is recognized by
     * its thumbnail and format badge, and a generated name such as
     * `image_20261014021004_e10…` only crowds them out; the name stays in the
     * tooltip and the accessible name.
     */
    readonly labelHidden: boolean
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

/** Spoken kinds are selected by semantic visual family, not a file's name or translated text. */
function resourceKindName(kind: ResourceVisualKind, t: UiTranslator): string {
    return t(`chatInput.chip.kind.${kind}`)
}

/**
 * A ready resource's chip, wherever an input names it: the composer, a queued
 * entry or a sent row.
 *
 * `hint` names what the surrounding surface lets the user do with the chip; a
 * surface that offers nothing passes none, so the tooltip never promises a key
 * or click that does not work there.
 */
export function describeResourceChip(
    node: ResourceInputNode,
    resource?: SemanticResourceRef,
    hint?: string,
    t: UiTranslator = englishUi,
): ChipPresentation {
    const { visualKind, formatBadge } = describeResourcePresentation(node, resource)
    const lineCount = node.kind === "file" ? node.lineCount : undefined
    const summary = t("chatInput.chip.summary", { name: node.displayName, format: formatBadge, lines: lineCount })
    return {
        icon: ICON_BY_VISUAL_KIND[visualKind],
        label: node.displayName,
        labelHidden: visualKind === "image",
        badge: formatBadge,
        tone: "resource",
        ariaLabel: t("chatInput.chip.ready", {
            kind: resourceKindName(visualKind, t),
            name: node.displayName,
            format: formatBadge,
            lines: lineCount,
        }),
        tooltip: hint ? t("chatInput.chip.withHint", { summary, hint }) : summary,
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

function resourceFailureReason(error: ResourceAtom["error"], t: UiTranslator): string {
    switch (error?.code) {
        case "semantic_input_resource_stage_failed":
            return t("chatInput.chip.stageFailed")
        case "semantic_input_resource_missing":
            return t("chatInput.chip.missing")
        default:
            return error?.message ?? t("chatInput.chip.failedFallback")
    }
}

function describeResource(atom: ResourceAtom, t: UiTranslator): ChipPresentation {
    const node = resourceNodeOf(atom)
    if (atom.status === "ready") return describeResourceChip(node, atom.ref, t("chatInput.chip.hint"), t)
    const { visualKind, formatBadge } = describeResourcePresentation(node, atom.ref)
    const kindName = resourceKindName(visualKind, t)
    if (atom.status === "failed") {
        const reason = resourceFailureReason(atom.error, t)
        return {
            icon: "error",
            label: atom.displayName,
            labelHidden: visualKind === "image",
            badge: formatBadge,
            tone: "error",
            ariaLabel: t("chatInput.chip.failed", { kind: kindName, name: atom.displayName, format: formatBadge, reason }),
            tooltip: t("chatInput.chip.error", { name: atom.displayName, reason }),
            busy: false,
            plainText: "",
        }
    }
    return {
        icon: "loading",
        label: atom.displayName,
        labelHidden: visualKind === "image",
        badge: formatBadge,
        tone: "warning",
        ariaLabel: t("chatInput.chip.stagingAria", { kind: kindName, name: atom.displayName, format: formatBadge }),
        tooltip: t("chatInput.chip.staging", { name: atom.displayName }),
        busy: true,
        plainText: "",
    }
}

/** Class of a chip's name element; a hidden name stays readable to assistive tech. */
export function chipLabelClass(chip: ChipPresentation): string {
    return chip.labelHidden ? "composer-chip__label composer-chip__label--hidden" : "composer-chip__label"
}

export function describeChip(atom: ComposerAtom, t: UiTranslator = englishUi): ChipPresentation {
    switch (atom.kind) {
        case "command":
            return {
                icon: "symbol-event",
                label: atom.sourceText,
                labelHidden: false,
                tone: "command",
                ariaLabel: t("chatInput.chip.command", { command: atom.sourceText }),
                tooltip: t("chatInput.chip.command", { command: atom.sourceText }),
                busy: false,
                plainText: atom.sourceText,
            }
        case "mention":
            return {
                icon: atom.mentionKind === "folder" ? "folder" : atom.mentionKind === "url" ? "link" : "mention",
                label: atom.sourceText.slice(1),
                labelHidden: false,
                tone: "mention",
                ariaLabel: t("chatInput.chip.mention", { mention: atom.sourceText }),
                tooltip: atom.sourceText,
                busy: false,
                plainText: atom.sourceText,
            }
        case "resource":
            return describeResource(atom, t)
    }
}
