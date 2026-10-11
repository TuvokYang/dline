import { type InputSemanticCatalog, resolveCommandTrigger } from "@shared/input-semantics/catalog"
import {
    isMentionNode,
    isSlashCommandNode,
    type MentionInputNode,
    type SemanticInputNode,
    type SlashCommandInputNode,
} from "@shared/input-semantics/document"
import {
    canStartCandidateAt,
    lexSemanticInput,
    type SemanticTrigger,
    semanticCandidateSpans,
    semanticTriggerAt,
} from "@shared/input-semantics/lexer"
import { formatMentionReference, parseMentionReference, sameMentionReference } from "@shared/input-semantics/mention-reference"
import { confirmRange, type PasteProvenance, rebaseProvenance, type TextSpan } from "./paste-provenance"

/**
 * What a menu pick or an application action asks to place in the draft.
 *
 * An intent names the entity, never free text: a command by its catalog
 * identity, a mention by its reference. How a mention is spelled in the draft
 * is decided by the shared reference grammar, never by the caller.
 */
export type SemanticEditIntent =
    /**
     * A command by catalog identity, written with `trigger`: the spelling its
     * menu row shows, which the catalog must still resolve to `commandId`.
     */
    | { readonly kind: "command"; readonly commandId: string; readonly trigger: string }
    /**
     * A mention by its unquoted reference: a workspace path, optionally with a
     * `root:` prefix, a URL, a commit, `problems`, `terminal` or `git-changes`.
     */
    | { readonly kind: "mention"; readonly reference: string }

/** Why an intent was refused instead of being written as look-alike text. */
export type SemanticEditRejection =
    /** The catalog no longer resolves the spelling to that command, for example because its capability was withdrawn. */
    | "unknown_command"
    /** The written text would not come back as exactly this entity, for example inside code. */
    | "unrecognizable_entity"

export type SemanticEditResult =
    | {
          readonly ok: true
          /** The edited draft with the entity's span confirmed as user intent. */
          readonly provenance: PasteProvenance
          /** Where the caret belongs: after the entity and its separating space. */
          readonly caret: number
          readonly entity: TextSpan
      }
    | { readonly ok: false; readonly reason: SemanticEditRejection }

/** Lexing here only verifies the edit, so its document identity never leaves this module. */
const VERIFICATION_DOCUMENT_ID = "semantic-edit"

/**
 * The text a menu pick replaces: the sigil and partial name the caret is
 * completing, or an empty span at the caret when nothing of that kind is being
 * typed there.
 */
export function typedTriggerSpan(text: string, caret: number, kind: SemanticTrigger["kind"]): TextSpan {
    const trigger = semanticTriggerAt(text, caret)
    return trigger?.kind === kind ? { start: trigger.start, end: caret } : { start: caret, end: caret }
}

function entityTextOf(intent: SemanticEditIntent, catalog: InputSemanticCatalog): string | undefined {
    if (intent.kind === "mention") return `@${formatMentionReference(intent.reference)}`
    return resolveCommandTrigger(catalog, intent.trigger)?.id === intent.commandId ? intent.trigger : undefined
}

function isEntityNode(node: SemanticInputNode): node is SlashCommandInputNode | MentionInputNode {
    return isSlashCommandNode(node) || isMentionNode(node)
}

/**
 * True when the scanner reads `entity` in `text` as exactly the intended,
 * active entity: the same span and spelling, and the same identity - the
 * command's descriptor, or the mention's kind, path and workspace.
 */
function readsBackAs(
    text: string,
    entity: TextSpan,
    entityText: string,
    intent: SemanticEditIntent,
    catalog: InputSemanticCatalog,
): boolean {
    const ordinal = semanticCandidateSpans(text).findIndex((span) => span.start === entity.start && span.end === entity.end)
    if (ordinal === -1) return false
    // Every candidate becomes one entity node under "auto", in text order.
    const node = lexSemanticInput(text, { catalog, documentId: VERIFICATION_DOCUMENT_ID, activation: "auto" }).nodes.filter(
        isEntityNode,
    )[ordinal]
    if (!node || node.sourceText !== entityText || node.state !== "recognized") return false
    if (intent.kind === "command") return isSlashCommandNode(node) && node.commandId === intent.commandId
    return (
        isMentionNode(node) &&
        sameMentionReference(
            { kind: node.mentionKind, ref: node.canonicalRef, workspaceHint: node.workspaceHint },
            parseMentionReference(intent.reference),
        )
    )
}

/**
 * Place an entity the user picked into the draft.
 *
 * `replace` is the text the pick consumes, such as the typed `/par` or `@sr`,
 * or an empty span at the caret for an application action. The entity is
 * written followed by one space - and preceded by one when the text before it
 * would not let it start, as when inserting right after a word - and its span
 * is confirmed so a surrounding paste can never demote it to a candidate.
 *
 * The edited text is read back with the shared scanner before anything is
 * returned. An intent that would not come back as exactly the picked entity -
 * a withdrawn command, a reference the grammar cannot express, a caret inside
 * code - is refused rather than written as text that merely looks like one.
 */
export function applySemanticEdit(
    provenance: PasteProvenance,
    replace: TextSpan,
    intent: SemanticEditIntent,
    catalog: InputSemanticCatalog,
): SemanticEditResult {
    const entityText = entityTextOf(intent, catalog)
    if (entityText === undefined) return { ok: false, reason: "unknown_command" }

    const before = provenance.text.slice(0, replace.start)
    const after = provenance.text.slice(replace.end)
    const leading = canStartCandidateAt(before, before.length, intent.kind) ? "" : " "
    const separator = after.startsWith(" ") ? "" : " "
    const text = `${before}${leading}${entityText}${separator}${after}`
    const start = replace.start + leading.length
    const entity = { start, end: start + entityText.length }
    if (!readsBackAs(text, entity, entityText, intent, catalog)) return { ok: false, reason: "unrecognizable_entity" }

    return {
        ok: true,
        provenance: confirmRange(rebaseProvenance(provenance, text), entity),
        caret: entity.end + 1,
        entity,
    }
}
