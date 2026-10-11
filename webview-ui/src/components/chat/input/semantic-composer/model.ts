import type {
    FileNodeOrigin,
    InputSource,
    MentionCapturePolicy,
    MentionKind,
    SemanticResourceRef,
    SlashCommandComposition,
    SlashCommandNamespace,
} from "@shared/input-semantics/document"

/**
 * The composer's editing model.
 *
 * A draft is an ordered list of segments: runs of text that remember where they
 * came from, and atoms - a command, a mention or a resource the user chose as a
 * whole. Positions are flat offsets: a text character counts one UTF-16 unit and
 * an atom counts exactly one, so the model, the DOM view and the shared lexer
 * (which sees each atom as {@link ATOM_PLACEHOLDER}) all address the same offsets.
 */

/** The character an atom occupies in the flat text the lexer and the trigger scanner read. */
export const ATOM_PLACEHOLDER = "\uFFFC"

/** Where a run of composer text came from; it decides whether a candidate inside it may activate. */
export type ComposerTextSource = InputSource

export interface ComposerTextSegment {
    readonly kind: "text"
    readonly text: string
    readonly source: ComposerTextSource
}

export interface CommandAtom {
    readonly kind: "command"
    readonly entityId: string
    readonly commandId: string
    /** The trigger exactly as the menu row showed it, e.g. "/compact". */
    readonly sourceText: string
    readonly canonicalName: string
    readonly namespace: SlashCommandNamespace
    readonly compositionMode: SlashCommandComposition
}

export interface MentionAtom {
    readonly kind: "mention"
    readonly entityId: string
    readonly mentionKind: MentionKind
    /** The mention as written, including its `@`. */
    readonly sourceText: string
    readonly canonicalRef: string
    readonly workspaceHint?: string
    readonly capturePolicy?: MentionCapturePolicy
}

/** Why a resource atom cannot be submitted yet. */
export interface ResourceAtomError {
    readonly code: string
    readonly message: string
    /** True when the composer still holds what it staged from, so the stage can be repeated in place. */
    readonly retryable?: boolean
}

/**
 * A resource at its insertion position.
 *
 * The atom exists before the host has staged the bytes, so the position the
 * user chose survives a slow stage: `staging` holds the place, `ready` binds the
 * reference the document sends, and `failed` keeps the place with a recoverable
 * error instead of silently dropping what the user attached.
 */
export interface ResourceAtom {
    readonly kind: "resource"
    readonly entityId: string
    readonly nodeKind: "image" | "file"
    readonly fileOrigin: FileNodeOrigin
    readonly displayName: string
    readonly status: "staging" | "ready" | "failed"
    /** Present exactly when `status` is `ready`. */
    readonly ref?: SemanticResourceRef
    readonly lineCount?: number
    /** Present exactly when `status` is `failed`. */
    readonly error?: ResourceAtomError
    /** Display-only thumbnail; never an identity and never sent. */
    readonly previewUrl?: string
}

export type ComposerAtom = CommandAtom | MentionAtom | ResourceAtom

export interface ComposerAtomSegment {
    readonly kind: "atom"
    readonly atom: ComposerAtom
}

export type ComposerSegment = ComposerTextSegment | ComposerAtomSegment

/** A half-open flat range `[start, end)`. */
export interface ComposerRange {
    readonly start: number
    readonly end: number
}

/** The user's selection; `focus` is where the caret is drawn. */
export interface ComposerSelection {
    readonly anchor: number
    readonly focus: number
}

export interface ComposerState {
    readonly segments: readonly ComposerSegment[]
    readonly selection: ComposerSelection
    /** Increases with every content change; selection moves keep it. */
    readonly revision: number
}

export const EMPTY_COMPOSER_STATE: ComposerState = { segments: [], selection: { anchor: 0, focus: 0 }, revision: 0 }

export function isAtomSegment(segment: ComposerSegment): segment is ComposerAtomSegment {
    return segment.kind === "atom"
}

export function segmentLength(segment: ComposerSegment): number {
    return segment.kind === "text" ? segment.text.length : 1
}

export function contentLength(segments: readonly ComposerSegment[]): number {
    return segments.reduce((total, segment) => total + segmentLength(segment), 0)
}

export function isCollapsed(selection: ComposerSelection): boolean {
    return selection.anchor === selection.focus
}

export function selectionRange(selection: ComposerSelection): ComposerRange {
    return { start: Math.min(selection.anchor, selection.focus), end: Math.max(selection.anchor, selection.focus) }
}

export function caretAt(offset: number): ComposerSelection {
    return { anchor: offset, focus: offset }
}

export function clampOffset(offset: number, segments: readonly ComposerSegment[]): number {
    return Math.max(0, Math.min(contentLength(segments), offset))
}

/** The flat text the shared lexer reads: every atom becomes {@link ATOM_PLACEHOLDER}. */
export function flatTextOf(segments: readonly ComposerSegment[]): string {
    return segments.map((segment) => (segment.kind === "text" ? segment.text : ATOM_PLACEHOLDER)).join("")
}

/** Typed or pasted text normalized for the model: LF line ends and no atom placeholder look-alikes. */
export function normalizeComposerText(text: string): string {
    return text.replace(/\r\n?/g, "\n").replaceAll(ATOM_PLACEHOLDER, "")
}

/** Drop empty text and merge adjacent text of the same source, so equal drafts have equal segments. */
export function normalizeSegments(segments: readonly ComposerSegment[]): ComposerSegment[] {
    const normalized: ComposerSegment[] = []
    for (const segment of segments) {
        if (segment.kind === "text" && segment.text.length === 0) continue
        const last = normalized[normalized.length - 1]
        if (segment.kind === "text" && last?.kind === "text" && last.source === segment.source) {
            normalized[normalized.length - 1] = { kind: "text", text: last.text + segment.text, source: last.source }
            continue
        }
        normalized.push(segment)
    }
    return normalized
}

/** Split the segments at a flat offset; an atom is never split because it is one unit long. */
function splitAt(segments: readonly ComposerSegment[], offset: number): [ComposerSegment[], ComposerSegment[]] {
    const before: ComposerSegment[] = []
    const after: ComposerSegment[] = []
    let cursor = 0
    for (const segment of segments) {
        const length = segmentLength(segment)
        if (cursor + length <= offset) before.push(segment)
        else if (cursor >= offset) after.push(segment)
        else if (segment.kind === "text") {
            const cut = offset - cursor
            before.push({ ...segment, text: segment.text.slice(0, cut) })
            after.push({ ...segment, text: segment.text.slice(cut) })
        }
        cursor += length
    }
    return [before, after]
}

/** The segments inside `range`, cut at its edges. */
export function sliceSegments(segments: readonly ComposerSegment[], range: ComposerRange): ComposerSegment[] {
    const [, tail] = splitAt(segments, range.start)
    const [inside] = splitAt(tail, range.end - range.start)
    return normalizeSegments(inside)
}

/** Replace `range` with `inserted`. */
export function replaceSegments(
    segments: readonly ComposerSegment[],
    range: ComposerRange,
    inserted: readonly ComposerSegment[],
): ComposerSegment[] {
    const [before] = splitAt(segments, range.start)
    const [, after] = splitAt(segments, range.end)
    return normalizeSegments([...before, ...inserted, ...after])
}

/** The atom occupying `[offset, offset + 1)`, if any. */
export function atomAt(segments: readonly ComposerSegment[], offset: number): ComposerAtom | undefined {
    let cursor = 0
    for (const segment of segments) {
        const length = segmentLength(segment)
        if (offset < cursor + length) return segment.kind === "atom" && cursor === offset ? segment.atom : undefined
        cursor += length
    }
    return undefined
}

/** Where an atom sits, by its entity identity. */
export function findAtom(
    segments: readonly ComposerSegment[],
    entityId: string,
): { readonly offset: number; readonly atom: ComposerAtom } | undefined {
    let cursor = 0
    for (const segment of segments) {
        if (segment.kind === "atom" && segment.atom.entityId === entityId) return { offset: cursor, atom: segment.atom }
        cursor += segmentLength(segment)
    }
    return undefined
}

export function atomsOf(segments: readonly ComposerSegment[]): ComposerAtom[] {
    return segments.filter(isAtomSegment).map((segment) => segment.atom)
}

export function resourceAtomsOf(segments: readonly ComposerSegment[]): ResourceAtom[] {
    return atomsOf(segments).filter((atom): atom is ResourceAtom => atom.kind === "resource")
}

/** True when the draft holds nothing but whitespace. */
export function isBlankDraft(segments: readonly ComposerSegment[]): boolean {
    return segments.every((segment) => segment.kind === "text" && segment.text.trim().length === 0)
}

/**
 * Remove whitespace before the first and after the last visible content.
 *
 * Atoms are content, so a draft that starts with an image keeps the text after it intact.
 */
export function trimSegments(segments: readonly ComposerSegment[]): ComposerSegment[] {
    const trimmed = [...normalizeSegments(segments)]
    while (trimmed.length > 0) {
        const first = trimmed[0]
        if (first.kind !== "text") break
        const text = first.text.trimStart()
        if (text.length > 0) {
            trimmed[0] = { ...first, text }
            break
        }
        trimmed.shift()
    }
    while (trimmed.length > 0) {
        const last = trimmed[trimmed.length - 1]
        if (last.kind !== "text") break
        const text = last.text.trimEnd()
        if (text.length > 0) {
            trimmed[trimmed.length - 1] = { ...last, text }
            break
        }
        trimmed.pop()
    }
    return trimmed
}

/** A composer draft holding `text` from one source with the caret at its end. */
export function stateFromText(text: string, source: ComposerTextSource = "typed"): ComposerState {
    const segments = normalizeSegments([{ kind: "text", text: normalizeComposerText(text), source }])
    return { segments, selection: caretAt(contentLength(segments)), revision: 0 }
}
