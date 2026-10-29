import {
    atomAt,
    type ComposerAtom,
    type ComposerRange,
    type ComposerSegment,
    type ComposerSelection,
    type ComposerState,
    type ComposerTextSource,
    caretAt,
    clampOffset,
    contentLength,
    findAtom,
    flatTextOf,
    isCollapsed,
    normalizeComposerText,
    normalizeSegments,
    replaceSegments,
    selectionRange,
} from "./model"

/**
 * One edit of the composer draft.
 *
 * Every user gesture and application action is expressed as an operation, so
 * the view never mutates the draft directly and every change is undoable. A
 * `range` defaults to the current selection.
 */
export type SemanticEditOperation =
    | { readonly type: "select"; readonly selection: ComposerSelection }
    | { readonly type: "insert_text"; readonly text: string; readonly source: ComposerTextSource; readonly range?: ComposerRange }
    /**
     * Place an atom. A command or mention is kept apart from neighbouring text
     * by one space on each side, so its written form never fuses with a word.
     */
    | { readonly type: "insert_atom"; readonly atom: ComposerAtom; readonly range?: ComposerRange }
    /** Insert a copied piece of a draft, atoms included. */
    | { readonly type: "insert_fragment"; readonly segments: readonly ComposerSegment[]; readonly range?: ComposerRange }
    | { readonly type: "delete"; readonly direction: DeleteDirection; readonly unit: DeleteUnit }
    | { readonly type: "delete_range"; readonly range: ComposerRange }
    /**
     * Settle an atom in place, e.g. when a staged resource becomes ready; its
     * position and identity stay. A settlement is a fact about the atom, not an
     * edit by the user, so it is never an undo step of its own.
     */
    | { readonly type: "replace_atom"; readonly entityId: string; readonly atom: ComposerAtom }
    | { readonly type: "remove_atom"; readonly entityId: string }
    /**
     * Replace the whole draft, as when a queued or refused draft comes back.
     * The history starts fresh; `undoTo`, when given, becomes its only step,
     * so a sent draft stays one undo away from the empty composer it left.
     */
    | {
          readonly type: "load"
          readonly segments: readonly ComposerSegment[]
          readonly selection?: ComposerSelection
          readonly undoTo?: readonly ComposerSegment[]
      }

export type DeleteDirection = "backward" | "forward"
export type DeleteUnit = "character" | "word" | "line"

/** How an operation relates to undo grouping. */
export type EditKind = "selection" | "typing" | "deletion" | "structural" | "settlement" | "load"

export interface OperationResult {
    readonly state: ComposerState
    readonly kind: EditKind
    /** False when the operation left the draft and its selection exactly as they were. */
    readonly changed: boolean
    /** For a load: the single undo step its fresh history starts with. */
    readonly historySeed?: ComposerState
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function unchanged(state: ComposerState, kind: EditKind): OperationResult {
    return { state, kind, changed: false }
}

/** A draft as an undo step: its content with the caret at the end. */
function seedState(segments: readonly ComposerSegment[], revision: number): ComposerState {
    const normalized = normalizeSegments(segments)
    return { segments: normalized, selection: caretAt(contentLength(normalized)), revision }
}

function withContent(state: ComposerState, segments: readonly ComposerSegment[], caret: number, kind: EditKind): OperationResult {
    const normalized = normalizeSegments(segments)
    return {
        state: { segments: normalized, selection: caretAt(clampOffset(caret, normalized)), revision: state.revision + 1 },
        kind,
        changed: true,
    }
}

function clampRange(range: ComposerRange, segments: readonly ComposerSegment[]): ComposerRange {
    const start = clampOffset(Math.min(range.start, range.end), segments)
    const end = clampOffset(Math.max(range.start, range.end), segments)
    return { start, end }
}

function targetRange(state: ComposerState, range: ComposerRange | undefined): ComposerRange {
    return clampRange(range ?? selectionRange(state.selection), state.segments)
}

function isSeparatorBefore(segments: readonly ComposerSegment[], offset: number): boolean {
    if (offset === 0) return true
    return /\s/.test(flatTextOf(segments).charAt(offset - 1))
}

function isSeparatorAt(segments: readonly ComposerSegment[], offset: number): boolean {
    return /\s/.test(flatTextOf(segments).charAt(offset))
}

function insertAtom(state: ComposerState, atom: ComposerAtom, range: ComposerRange): OperationResult {
    const remaining = replaceSegments(state.segments, range, [])
    const spaced = atom.kind !== "resource"
    const leading = spaced && !isSeparatorBefore(remaining, range.start) ? " " : ""
    const trailing = spaced && !isSeparatorAt(remaining, range.start) ? " " : ""
    const inserted: ComposerSegment[] = [
        { kind: "text", text: leading, source: "typed" },
        { kind: "atom", atom },
        { kind: "text", text: trailing, source: "typed" },
    ]
    // A separator that already follows the atom is where the caret belongs, so typing continues after it.
    const caretGap = spaced ? 1 : 0
    const caret = range.start + leading.length + 1 + caretGap
    return withContent(state, replaceSegments(state.segments, range, inserted), caret, "structural")
}

/** The extent of one user-perceived character before or after `offset` within the flat text. */
function characterExtent(text: string, offset: number, direction: DeleteDirection): ComposerRange {
    if (direction === "backward") {
        let start = Math.max(0, offset - 1)
        for (const { index } of graphemes.segment(text.slice(0, offset))) start = index
        return { start, end: offset }
    }
    const next = graphemes.segment(text.slice(offset))[Symbol.iterator]().next()
    return { start: offset, end: offset + (next.done ? 0 : next.value.segment.length) }
}

/**
 * The extent of one word before or after `offset`: the whitespace next to the
 * caret and the run of non-whitespace beyond it. An atom is a word on its own.
 */
function wordExtent(
    text: string,
    offset: number,
    direction: DeleteDirection,
    atomAtOffset: (index: number) => boolean,
): ComposerRange {
    const isSpace = (index: number) => /\s/.test(text.charAt(index)) && !atomAtOffset(index)
    if (direction === "backward") {
        let start = offset
        while (start > 0 && isSpace(start - 1)) start--
        if (start > 0 && atomAtOffset(start - 1)) return { start: start - 1, end: offset }
        while (start > 0 && !isSpace(start - 1) && !atomAtOffset(start - 1)) start--
        return { start, end: offset }
    }
    let end = offset
    while (end < text.length && isSpace(end)) end++
    if (end < text.length && atomAtOffset(end)) return { start: offset, end: end + 1 }
    while (end < text.length && !isSpace(end) && !atomAtOffset(end)) end++
    return { start: offset, end }
}

function lineExtent(text: string, offset: number, direction: DeleteDirection): ComposerRange {
    if (direction === "backward") {
        const lineStart = text.lastIndexOf("\n", offset - 1) + 1
        return { start: lineStart === offset ? Math.max(0, offset - 1) : lineStart, end: offset }
    }
    const lineEnd = text.indexOf("\n", offset)
    const end = lineEnd === -1 ? text.length : lineEnd === offset ? offset + 1 : lineEnd
    return { start: offset, end }
}

function deleteExtent(state: ComposerState, direction: DeleteDirection, unit: DeleteUnit): ComposerRange {
    const offset = state.selection.focus
    const text = flatTextOf(state.segments)
    const isAtom = (index: number) => atomAt(state.segments, index) !== undefined
    // An atom is removed as a whole, whatever the unit.
    const neighbour = direction === "backward" ? offset - 1 : offset
    if (neighbour >= 0 && isAtom(neighbour)) return { start: neighbour, end: neighbour + 1 }
    if (unit === "word") return wordExtent(text, offset, direction, isAtom)
    if (unit === "line") return lineExtent(text, offset, direction)
    return characterExtent(text, offset, direction)
}

function deleteRange(state: ComposerState, range: ComposerRange): OperationResult {
    if (range.start === range.end) return unchanged(state, "deletion")
    return withContent(state, replaceSegments(state.segments, range, []), range.start, "deletion")
}

/** Apply one operation to a draft. Pure: the input state is never modified. */
export function applyOperation(state: ComposerState, operation: SemanticEditOperation): OperationResult {
    switch (operation.type) {
        case "select": {
            const anchor = clampOffset(operation.selection.anchor, state.segments)
            const focus = clampOffset(operation.selection.focus, state.segments)
            if (anchor === state.selection.anchor && focus === state.selection.focus) return unchanged(state, "selection")
            return { state: { ...state, selection: { anchor, focus } }, kind: "selection", changed: true }
        }
        case "insert_text": {
            const range = targetRange(state, operation.range)
            const text = normalizeComposerText(operation.text)
            if (text.length === 0 && range.start === range.end) return unchanged(state, "typing")
            const inserted: ComposerSegment[] = [{ kind: "text", text, source: operation.source }]
            const kind: EditKind = operation.source === "typed" && range.start === range.end ? "typing" : "structural"
            return withContent(state, replaceSegments(state.segments, range, inserted), range.start + text.length, kind)
        }
        case "insert_atom":
            return insertAtom(state, operation.atom, targetRange(state, operation.range))
        case "insert_fragment": {
            const range = targetRange(state, operation.range)
            const fragment = normalizeSegments(
                operation.segments.map((segment) =>
                    segment.kind === "text" ? { ...segment, text: normalizeComposerText(segment.text) } : segment,
                ),
            )
            const caret = range.start + contentLength(fragment)
            return withContent(state, replaceSegments(state.segments, range, fragment), caret, "structural")
        }
        case "delete": {
            if (!isCollapsed(state.selection)) return deleteRange(state, selectionRange(state.selection))
            return deleteRange(state, deleteExtent(state, operation.direction, operation.unit))
        }
        case "delete_range":
            return deleteRange(state, clampRange(operation.range, state.segments))
        case "replace_atom": {
            const located = findAtom(state.segments, operation.entityId)
            if (!located) return unchanged(state, "settlement")
            const range = { start: located.offset, end: located.offset + 1 }
            const segments = replaceSegments(state.segments, range, [{ kind: "atom", atom: operation.atom }])
            return {
                state: { segments, selection: state.selection, revision: state.revision + 1 },
                kind: "settlement",
                changed: true,
            }
        }
        case "remove_atom": {
            const located = findAtom(state.segments, operation.entityId)
            if (!located) return unchanged(state, "structural")
            const range = { start: located.offset, end: located.offset + 1 }
            const segments = replaceSegments(state.segments, range, [])
            const shift = (offset: number) => (offset > located.offset ? offset - 1 : offset)
            return {
                state: {
                    segments,
                    selection: { anchor: shift(state.selection.anchor), focus: shift(state.selection.focus) },
                    revision: state.revision + 1,
                },
                kind: "structural",
                changed: true,
            }
        }
        case "load": {
            const segments = normalizeSegments(operation.segments)
            const selection = operation.selection ?? caretAt(contentLength(segments))
            return {
                state: {
                    segments,
                    selection: {
                        anchor: clampOffset(selection.anchor, segments),
                        focus: clampOffset(selection.focus, segments),
                    },
                    revision: state.revision + 1,
                },
                kind: "load",
                changed: true,
                ...(operation.undoTo === undefined ? {} : { historySeed: seedState(operation.undoTo, state.revision) }),
            }
        }
    }
}
