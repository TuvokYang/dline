import { mentionRegex } from "../context-mentions"
import { COMMAND_TRIGGER_CHARS, type InputSemanticCatalog, type InputSemanticDescriptor, resolveCommandTrigger } from "./catalog"
import { commandNamespaceOf } from "./command-namespace"
import {
    type MentionKind,
    SEMANTIC_INPUT_SCHEMA_VERSION,
    type SemanticEntityState,
    type SemanticInputDocument,
    type SemanticInputNode,
} from "./document"
import { parseMentionReference } from "./mention-reference"

/** Grammar version of this lexer; a consumer with a different version must not trust its nodes. */
export const SEMANTIC_INPUT_PARSER_VERSION = "1.1.0"

const COMMAND_SIGIL = "/"
const MENTION_SIGIL = "@"
const ESCAPE = "\\"
/** The command token after its sigil; it must end at whitespace or the end of the text. */
const COMMAND_TOKEN = new RegExp(`/[${COMMAND_TRIGGER_CHARS}]+(?=\\s|$)`, "y")
/** What may follow a command sigil while the user is still typing the name. */
const PARTIAL_COMMAND_NAME = new RegExp(`^[${COMMAND_TRIGGER_CHARS}]*$`)
const MENTION_TOKEN = new RegExp(mentionRegex.source, "y")
/** Characters after which a mention may start besides whitespace, so "(@/src/a.ts)" still mentions. */
const MENTION_OPENERS: ReadonlySet<string> = new Set(["(", "[", "{"])
/** A fenced code block opens and closes on its own line with three or more backticks or tildes. */
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const INLINE_CODE_MARK = "`"

/**
 * Whether a recognized shape may become an active entity.
 *
 * Typed input may activate. Pasted text must not: a log line or quoted answer
 * that happens to contain "/compact" or "@/etc/passwd" stays a candidate until
 * the user confirms it. Opaque text (an editor selection, model text, a tool
 * result) never even becomes a candidate: it stays text whatever it contains.
 */
export type SemanticActivation = "auto" | "candidate_only" | "opaque"

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

/** A half-open UTF-16 range `[start, end)`. */
interface Range {
    readonly start: number
    readonly end: number
}

/**
 * Scan raw text into command and mention candidates.
 *
 * The rules are lexical only, so the Webview and Core always agree on where a
 * candidate sits:
 * - A sigil starts a candidate only at a boundary: the start of the text or
 *   whitespace, and for a mention also an opening bracket. A slash inside a URL,
 *   path or XML tag, or an at-sign inside an e-mail address or attribute, is text.
 * - Fenced and inline code are opaque.
 * - Backslashes escape a sigil by parity: an odd run before it keeps it literal,
 *   an even run lets it start a candidate. The run belongs to the text before
 *   the candidate; whoever materializes text halves it (see {@link sigilEscapeRunBefore}).
 * - Offsets are UTF-16 code units, and a candidate never ends inside a surrogate pair.
 */
function scanCandidates(rawText: string): Candidate[] {
    const opaque = codeRanges(rawText)
    const candidates: Candidate[] = []
    let consumedUntil = 0

    for (let index = 0; index < rawText.length; index++) {
        if (index < consumedUntil) continue
        const sigil = rawText[index]
        if (sigil !== COMMAND_SIGIL && sigil !== MENTION_SIGIL) continue

        const candidate = candidateAt(rawText, index, sigil === COMMAND_SIGIL ? "command" : "mention")
        if (!candidate || overlapsAny(opaque, candidate)) continue
        candidates.push(candidate)
        // Candidates partition the text, so a later sigil inside this one is part of it.
        consumedUntil = candidate.end
    }
    return candidates
}

function candidateAt(rawText: string, index: number, kind: Candidate["kind"]): Candidate | undefined {
    if (!canStartCandidateAt(rawText, index, kind)) return undefined

    const token = kind === "command" ? COMMAND_TOKEN : MENTION_TOKEN
    token.lastIndex = index
    const match = token.exec(rawText)
    if (!match) return undefined
    const end = index + match[0].length
    if (isInsideSurrogatePair(rawText, end)) return undefined
    return { start: index, end, sourceText: match[0], kind }
}

/**
 * How many backslashes directly precede `index`.
 *
 * An odd count escapes the sigil at `index`; an even count leaves it active.
 * Either way the materialized text keeps half of the run, so `\\/compact`
 * reads as `\` followed by the command and `\/compact` as the literal `/compact`.
 */
export function sigilEscapeRunBefore(rawText: string, index: number): number {
    let count = 0
    while (index - count - 1 >= 0 && rawText[index - count - 1] === ESCAPE) count++
    return count
}

/**
 * True when a sigil of `kind` at `index` may start a candidate: it is not
 * escaped, and the text before it - and before any escape run - ends at a
 * boundary. Only text before `index` is read, so a writer can ask before the
 * sigil exists.
 */
export function canStartCandidateAt(rawText: string, index: number, kind: "command" | "mention"): boolean {
    const escapes = sigilEscapeRunBefore(rawText, index)
    return escapes % 2 === 0 && isBoundary(rawText, index - escapes, kind)
}

function isBoundary(rawText: string, index: number, kind: Candidate["kind"]): boolean {
    if (index === 0) return true
    const previous = rawText[index - 1]
    return /\s/.test(previous) || (kind === "mention" && MENTION_OPENERS.has(previous))
}

function isInsideSurrogatePair(text: string, index: number): boolean {
    if (index <= 0 || index >= text.length) return false
    const before = text.charCodeAt(index - 1)
    const after = text.charCodeAt(index)
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

function overlapsAny(ranges: readonly Range[], candidate: Range): boolean {
    return ranges.some((range) => candidate.start < range.end && range.start < candidate.end)
}

/** Fenced code blocks, then inline code spans outside them, in text order. */
function codeRanges(rawText: string): Range[] {
    const fenced = fencedCodeRanges(rawText)
    return [...fenced, ...inlineCodeRanges(rawText, fenced)].sort((left, right) => left.start - right.start)
}

/** A fence closes on a line with the same mark at least as long and nothing else; an unclosed fence runs to the end. */
function fencedCodeRanges(rawText: string): Range[] {
    const ranges: Range[] = []
    let open: { readonly mark: string; readonly start: number } | undefined
    let lineStart = 0
    while (lineStart <= rawText.length) {
        const newline = rawText.indexOf("\n", lineStart)
        const lineEnd = newline === -1 ? rawText.length : newline
        const fence = CODE_FENCE.exec(rawText.slice(lineStart, lineEnd).replace(/\r$/, ""))
        if (open) {
            const mark = fence?.[1]
            if (mark && mark[0] === open.mark[0] && mark.length >= open.mark.length && fence[2].trim() === "") {
                ranges.push({ start: open.start, end: lineEnd })
                open = undefined
            }
        } else if (fence) {
            open = { mark: fence[1], start: lineStart }
        }
        if (newline === -1) break
        lineStart = newline + 1
    }
    if (open) ranges.push({ start: open.start, end: rawText.length })
    return ranges
}

/**
 * A run of backticks opens a span closed by the next run of the same length; an unmatched run is text.
 *
 * Runs once per keystroke, so it stays linear in practice: fences are walked
 * with one cursor, and a run length that found no closer before a limit is not
 * searched for again before that limit.
 */
function inlineCodeRanges(rawText: string, fenced: readonly Range[]): Range[] {
    const ranges: Range[] = []
    const unmatchedBefore = new Map<number, number>()
    let fenceIndex = 0
    let index = 0
    while (index < rawText.length) {
        while (fenceIndex < fenced.length && fenced[fenceIndex].end <= index) fenceIndex++
        const nextFence = fenced[fenceIndex]
        if (nextFence && index >= nextFence.start) {
            index = nextFence.end
            continue
        }
        if (rawText[index] !== INLINE_CODE_MARK) {
            index++
            continue
        }
        const openLength = backtickRunLength(rawText, index)
        const limit = nextFence?.start ?? rawText.length
        const close =
            unmatchedBefore.get(openLength) === limit
                ? undefined
                : closingBacktickRun(rawText, index + openLength, openLength, limit)
        if (close === undefined) {
            unmatchedBefore.set(openLength, limit)
            index += openLength
            continue
        }
        ranges.push({ start: index, end: close + openLength })
        index = close + openLength
    }
    return ranges
}

function backtickRunLength(rawText: string, index: number): number {
    let length = 0
    while (rawText[index + length] === INLINE_CODE_MARK) length++
    return length
}

function closingBacktickRun(rawText: string, from: number, length: number, limit: number): number | undefined {
    let index = from
    while (index < limit) {
        if (rawText[index] !== INLINE_CODE_MARK) {
            index++
            continue
        }
        const runLength = backtickRunLength(rawText, index)
        if (runLength === length && index + runLength <= limit) return index
        index += runLength
    }
    return undefined
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

/** The command or mention the caret is in the middle of typing. */
export interface SemanticTrigger {
    readonly kind: "command" | "mention"
    /** UTF-16 offset of the sigil. */
    readonly start: number
    /** Text between the sigil and the caret. */
    readonly query: string
}

/**
 * Find the sigil the caret is completing, under the rules that recognize a
 * finished candidate.
 *
 * A menu opened where the scanner sees text would offer an entity that the
 * submission then sends literally: inside code, after an escaping backslash, or
 * in the middle of a URL or an e-mail address. Only the last sigil of each kind
 * in the whitespace-free run before the caret counts, because that is the text
 * a menu pick replaces; no part of that text may be code, or the pick would
 * swallow it.
 */
export function semanticTriggerAt(rawText: string, caret: number): SemanticTrigger | undefined {
    const runStart = whitespaceRunStart(rawText, caret)
    const opaque = codeRanges(rawText)
    const command = triggerOfKind(rawText, runStart, caret, "command", opaque)
    const mention = triggerOfKind(rawText, runStart, caret, "mention", opaque)
    if (command && mention) return command.start > mention.start ? command : mention
    return command ?? mention
}

function whitespaceRunStart(rawText: string, caret: number): number {
    let index = caret
    while (index > 0 && !/\s/.test(rawText[index - 1])) index--
    return index
}

function triggerOfKind(
    rawText: string,
    runStart: number,
    caret: number,
    kind: Candidate["kind"],
    opaque: readonly Range[],
): SemanticTrigger | undefined {
    const start = rawText.lastIndexOf(kind === "command" ? COMMAND_SIGIL : MENTION_SIGIL, caret - 1)
    if (start < runStart || start >= caret) return undefined
    if (!canStartCandidateAt(rawText, start, kind)) return undefined
    if (overlapsAny(opaque, { start, end: caret })) return undefined
    const query = rawText.slice(start + 1, caret)
    if (kind === "command" && !PARTIAL_COMMAND_NAME.test(query)) return undefined
    return { kind, start, query }
}

/** The user-facing name without the trigger and without its namespace prefix. */
function canonicalNameOf(trigger: string): string {
    const withoutSlash = trigger.startsWith("/") ? trigger.slice(1) : trigger
    const lastColon = withoutSlash.lastIndexOf(":")
    return lastColon === -1 ? withoutSlash : withoutSlash.slice(lastColon + 1)
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
        const descriptor = resolveCommandTrigger(catalog, candidate.sourceText)
        return {
            kind: "slash_command",
            entityId,
            commandId: descriptor?.id ?? "",
            sourceText: candidate.sourceText,
            canonicalName: canonicalNameOf(descriptor?.trigger ?? candidate.sourceText),
            namespace: descriptor ? commandNamespaceOf(descriptor.id) : "cmd",
            compositionMode: descriptor?.lifecycle === "task" ? "lifecycle_barrier" : "composable",
            state: stateFor(Boolean(descriptor), activation),
        }
    }

    const reference = parseMentionReference(candidate.sourceText.slice(1))
    return {
        kind: "mention",
        entityId,
        mentionKind: reference.kind,
        sourceText: candidate.sourceText,
        canonicalRef: reference.ref,
        ...(reference.workspaceHint === undefined ? {} : { workspaceHint: reference.workspaceHint }),
        capturePolicy: "snapshot_at_submit",
        state: stateFor(Boolean(findMention(catalog, reference.kind)), activation),
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
        const activation = activationOf(candidate.start, candidate.end)
        // Opaque text keeps the candidate inside the surrounding text node.
        if (activation === "opaque") continue
        if (candidate.start > cursor) nodes.push({ kind: "text", text: rawText.slice(cursor, candidate.start) })
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
