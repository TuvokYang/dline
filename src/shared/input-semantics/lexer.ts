import { mentionRegexGlobal } from "../context-mentions"
import type { InputSemanticCatalog, InputSemanticDescriptor } from "./catalog"
import {
    type MentionKind,
    SEMANTIC_INPUT_SCHEMA_VERSION,
    type SemanticEntityState,
    type SemanticInputDocument,
    type SemanticInputNode,
    type SlashCommandNamespace,
} from "./document"

/** Grammar version of this lexer; a consumer with a different version must not trust its nodes. */
export const SEMANTIC_INPUT_PARSER_VERSION = "1.0.0"

/**
 * A command must start the text or follow whitespace, so a URL or path such as
 * "https://host/compact" or "src/compact" never starts a command.
 */
const SLASH_COMMAND_SCAN = /(^|\s)(\/[a-zA-Z0-9_.:@-]+)(?=\s|$)/g

/**
 * Whether a recognized shape may become an active entity.
 *
 * Typed input may activate. Pasted text must not: a log line or quoted answer
 * that happens to contain "/compact" or "@/etc/passwd" stays a candidate until
 * the user confirms it.
 */
export type SemanticActivation = "auto" | "candidate_only"

export interface LexSemanticInputOptions {
    readonly catalog: InputSemanticCatalog
    readonly documentId: string
    readonly activation?: SemanticActivation
    /**
     * Activation for one candidate, by its UTF-16 span in `rawText`.
     *
     * A composer mixes typed and pasted text in one draft, so a single switch
     * cannot say which candidates the user actually typed. When present this
     * decides every candidate and `activation` is ignored.
     */
    readonly activationAt?: (start: number, end: number) => SemanticActivation
}

interface Candidate {
    readonly start: number
    readonly end: number
    readonly sourceText: string
    readonly kind: "command" | "mention"
}

function scanCandidates(rawText: string): Candidate[] {
    const candidates: Candidate[] = []

    for (const match of rawText.matchAll(SLASH_COMMAND_SCAN)) {
        const boundary = match[1] ?? ""
        const sourceText = match[2]
        const start = (match.index ?? 0) + boundary.length
        candidates.push({ start, end: start + sourceText.length, sourceText, kind: "command" })
    }

    for (const match of rawText.matchAll(mentionRegexGlobal)) {
        const start = match.index ?? 0
        candidates.push({ start, end: start + match[0].length, sourceText: match[0], kind: "mention" })
    }

    candidates.sort((left, right) => left.start - right.start)

    // An overlap means two shapes claim the same characters; the earlier one wins
    // so the projection stays a partition of the text.
    const partition: Candidate[] = []
    let consumedUntil = 0
    for (const candidate of candidates) {
        if (candidate.start < consumedUntil) continue
        partition.push(candidate)
        consumedUntil = candidate.end
    }
    return partition
}

/**
 * The UTF-16 range of every candidate in `rawText`.
 *
 * Where a candidate sits depends on the grammar alone, never on a catalog, so
 * this separates candidate text from plain text without resolving anything.
 */
export function semanticCandidateSpans(rawText: string): { readonly start: number; readonly end: number }[] {
    return scanCandidates(rawText).map(({ start, end }) => ({ start, end }))
}

function namespaceOf(descriptor: InputSemanticDescriptor): SlashCommandNamespace {
    if (descriptor.id.startsWith("command.skill.")) return "skill"
    if (descriptor.id.startsWith("command.workflow.")) return "workflow"
    if (descriptor.id.startsWith("command.mcp.")) return "mcp"
    return "cmd"
}

/** The user-facing name without the trigger and without its namespace prefix. */
function canonicalNameOf(trigger: string): string {
    const withoutSlash = trigger.startsWith("/") ? trigger.slice(1) : trigger
    const lastColon = withoutSlash.lastIndexOf(":")
    return lastColon === -1 ? withoutSlash : withoutSlash.slice(lastColon + 1)
}

function findCommand(catalog: InputSemanticCatalog, token: string): InputSemanticDescriptor | undefined {
    return catalog.descriptors.find(
        (descriptor) => descriptor.kind === "command" && (descriptor.trigger === token || descriptor.aliases?.includes(token)),
    )
}

function mentionKindOf(reference: string): MentionKind {
    if (reference === "problems") return "problems"
    if (reference === "terminal") return "terminal"
    if (reference === "git-changes") return "git_changes"
    if (/^[a-f0-9]{7,40}$/.test(reference)) return "git_commit"
    if (/^\w+:\/\//.test(reference)) return "url"
    return reference.endsWith("/") ? "folder" : "file"
}

function findMention(catalog: InputSemanticCatalog, kind: MentionKind): InputSemanticDescriptor | undefined {
    return catalog.descriptors.find((descriptor) => descriptor.id === `mention.${kind}`)
}

function stateFor(resolved: boolean, activation: SemanticActivation): SemanticEntityState {
    if (!resolved) return "unresolved"
    return activation === "auto" ? "recognized" : "unresolved"
}

function nodeFor(
    candidate: Candidate,
    entityId: string,
    catalog: InputSemanticCatalog,
    activation: SemanticActivation,
): SemanticInputNode {
    if (candidate.kind === "command") {
        const descriptor = findCommand(catalog, candidate.sourceText)
        return {
            kind: "slash_command",
            entityId,
            commandId: descriptor?.id ?? "",
            sourceText: candidate.sourceText,
            canonicalName: canonicalNameOf(descriptor?.trigger ?? candidate.sourceText),
            namespace: descriptor ? namespaceOf(descriptor) : "cmd",
            compositionMode: descriptor?.lifecycle === "task" ? "lifecycle_barrier" : "composable",
            state: stateFor(Boolean(descriptor), activation),
        }
    }

    const reference = candidate.sourceText.slice(1)
    const mentionKind = mentionKindOf(reference)
    return {
        kind: "mention",
        entityId,
        mentionKind,
        sourceText: candidate.sourceText,
        canonicalRef: reference,
        capturePolicy: "snapshot_at_submit",
        state: stateFor(Boolean(findMention(catalog, mentionKind)), activation),
    }
}

/**
 * Lex raw text into a semantic document against one catalog revision.
 *
 * This is the only place that turns characters into semantic entities. Core
 * never repeats it on an already structured document: recognition happens once,
 * and every later stage addresses nodes by identity.
 */
export function lexSemanticInput(rawText: string, options: LexSemanticInputOptions): SemanticInputDocument {
    const activationOf =
        options.activationAt ?? ((_start: number, _end: number) => options.activation ?? ("auto" as SemanticActivation))
    const nodes: SemanticInputNode[] = []
    let cursor = 0
    let ordinal = 0

    for (const candidate of scanCandidates(rawText)) {
        if (candidate.start > cursor) nodes.push({ kind: "text", text: rawText.slice(cursor, candidate.start) })
        const activation = activationOf(candidate.start, candidate.end)
        nodes.push(nodeFor(candidate, `${options.documentId}#${ordinal}`, options.catalog, activation))
        ordinal += 1
        cursor = candidate.end
    }
    if (cursor < rawText.length) nodes.push({ kind: "text", text: rawText.slice(cursor) })

    return {
        schemaVersion: SEMANTIC_INPUT_SCHEMA_VERSION,
        parserVersion: SEMANTIC_INPUT_PARSER_VERSION,
        catalogRevision: String(options.catalog.revision),
        documentId: options.documentId,
        rawText,
        nodes,
        resources: [],
    }
}
