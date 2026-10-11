import type React from "react"
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react"
import { COMPOSER_FRAGMENT_MIME, parseFragment, plainTextOfFragment, serializeFragment } from "./clipboard"
import {
    type ChipAction,
    type ComposerDecoration,
    chipTargetOf,
    modelOffsetAt,
    modelRangeOf,
    readModelSelection,
    renderComposerDom,
    writeModelSelection,
} from "./dom"
import type { SemanticComposerEngine } from "./engine"
import {
    atomAt,
    type ComposerAtom,
    type ComposerRange,
    type ComposerSegment,
    type ComposerState,
    caretAt,
    findAtom,
    isCollapsed,
    selectionRange,
    sliceSegments,
} from "./model"
import type { DeleteDirection, DeleteUnit } from "./operations"
import { useComposerState } from "./useComposerState"
import "./semantic-composer.css"

export interface SemanticComposerEditorHandle {
    focus(): void
    blur(): void
    readonly element: HTMLDivElement | null
    /** The flat offset under a viewport point, for inserting a drop where it landed. */
    offsetAtPoint(x: number, y: number): number | undefined
    /** Bring the caret into view, as after an application inserted text. */
    revealCaret(): void
}

export interface SemanticComposerEditorProps {
    readonly engine: SemanticComposerEngine
    /** Identifies this composer so copied resources are only pasted back into the draft that owns them. */
    readonly composerId: string
    readonly ariaLabel: string
    readonly placeholder?: string
    readonly testId?: string
    readonly className?: string
    readonly style?: React.CSSProperties
    /** Text highlights, recomputed whenever the draft changes. */
    readonly decorate?: (segments: readonly ComposerSegment[]) => readonly ComposerDecoration[]
    /** Runs before the editor's own key handling; prevent the default to take a key over. */
    readonly onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void
    /** Runs before the editor's own paste handling; prevent the default to take the paste over. */
    readonly onPaste?: (event: React.ClipboardEvent<HTMLDivElement>) => void
    /**
     * Offered pasted text that reached the editor only as an insertion, with no
     * readable clipboard event before it; return true to take it over.
     */
    readonly onPasteText?: (text: string, range: ComposerRange) => boolean
    readonly onChipAction?: (atom: ComposerAtom, action: ChipAction) => void
    readonly onFocus?: () => void
    readonly onBlur?: () => void
    readonly onHeightChange?: (height: number) => void
}

const DELETE_UNIT_BY_INPUT_TYPE: Readonly<Record<string, { direction: DeleteDirection; unit: DeleteUnit }>> = {
    deleteContentBackward: { direction: "backward", unit: "character" },
    deleteContentForward: { direction: "forward", unit: "character" },
    deleteWordBackward: { direction: "backward", unit: "word" },
    deleteWordForward: { direction: "forward", unit: "word" },
    deleteSoftLineBackward: { direction: "backward", unit: "line" },
    deleteSoftLineForward: { direction: "forward", unit: "line" },
    deleteHardLineBackward: { direction: "backward", unit: "line" },
    deleteHardLineForward: { direction: "forward", unit: "line" },
}

function isComposingKey(event: React.KeyboardEvent): boolean {
    return event.nativeEvent.isComposing || event.keyCode === 229
}

/** The single atom the selection covers exactly, which keyboard actions then address. */
function selectedAtom(state: ComposerState): ComposerAtom | undefined {
    const range = selectionRange(state.selection)
    return range.end - range.start === 1 ? atomAt(state.segments, range.start) : undefined
}

function selectedAtomIds(state: ComposerState): ReadonlySet<string> {
    const atom = selectedAtom(state)
    return new Set(atom ? [atom.entityId] : [])
}

/** Keep the caret visible inside the scrolling editor after the content was rebuilt. */
function revealSelection(root: HTMLElement): void {
    const selection = root.ownerDocument.getSelection()
    if (!selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    const caret = range.getClientRects?.()[0] ?? range.getBoundingClientRect?.()
    if (!caret) return
    const box = root.getBoundingClientRect()
    if (caret.bottom > box.bottom) root.scrollTop += caret.bottom - box.bottom
    else if (caret.top < box.top) root.scrollTop -= box.top - caret.top
}

/**
 * The editable view of a {@link SemanticComposerEngine}.
 *
 * The browser never edits this element directly: every `beforeinput` is turned
 * into an engine operation and the DOM is rebuilt from the model. The one
 * exception is IME composition, which must run natively; the composed text is
 * committed as a single operation when the composition ends, and only then is
 * the DOM rebuilt, so the IME never sees its text node replaced mid-flight.
 */
export const SemanticComposerEditor = forwardRef<SemanticComposerEditorHandle, SemanticComposerEditorProps>(
    function SemanticComposerEditor(props, ref) {
        const { engine, composerId, decorate, onHeightChange } = props
        const rootRef = useRef<HTMLDivElement>(null)
        const composingRef = useRef(false)
        const compositionRangeRef = useRef<ComposerRange | undefined>(undefined)
        const renderedSegmentsRef = useRef<readonly ComposerSegment[] | undefined>(undefined)
        const callbacksRef = useRef(props)
        callbacksRef.current = props
        const state = useComposerState(engine)

        const render = useCallback(
            (next: ComposerState, force = false) => {
                const root = rootRef.current
                if (!root || composingRef.current) return
                const focused = root.ownerDocument.activeElement === root
                if (force || renderedSegmentsRef.current !== next.segments) {
                    renderComposerDom(root, next.segments, {
                        decorations: decorate?.(next.segments),
                        selectedAtomIds: selectedAtomIds(next),
                    })
                    renderedSegmentsRef.current = next.segments
                    if (focused) {
                        writeModelSelection(root, next.selection)
                        revealSelection(root)
                    }
                } else {
                    const selected = selectedAtomIds(next)
                    for (const chip of root.querySelectorAll<HTMLElement>("[data-composer-atom]")) {
                        chip.classList.toggle("composer-chip--selected", selected.has(chip.dataset.entityId ?? ""))
                    }
                    const current = readModelSelection(root)
                    if (focused && (current?.anchor !== next.selection.anchor || current?.focus !== next.selection.focus)) {
                        writeModelSelection(root, next.selection)
                    }
                }
                root.dataset.empty = String(next.segments.length === 0)
            },
            [decorate],
        )

        // The draft may also change from outside the editor: a menu pick, a staged resource, a restored draft.
        useLayoutEffect(() => render(state), [render, state])
        useLayoutEffect(() => render(engine.getState(), true), [engine, render])

        /** Adopt the browser's selection before an edit, so the edit applies where the user sees the caret. */
        const syncSelection = useCallback(() => {
            const root = rootRef.current
            const selection = root ? readModelSelection(root) : undefined
            if (selection) engine.apply({ type: "select", selection })
        }, [engine])

        useEffect(() => {
            const root = rootRef.current
            if (!root) return
            const documentRef = root.ownerDocument

            const onSelectionChange = () => {
                if (composingRef.current || documentRef.activeElement !== root) return
                syncSelection()
            }

            const onBeforeInput = (event: InputEvent) => {
                if (event.isComposing || event.inputType === "insertCompositionText") return
                event.preventDefault()
                if (composingRef.current) return
                syncSelection()
                const current = engine.getState()
                switch (event.inputType) {
                    case "insertText":
                    case "insertReplacementText": {
                        const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? ""
                        const target = event.getTargetRanges?.()[0]
                        const range = target ? modelRangeOf(root, target) : undefined
                        engine.apply({ type: "insert_text", text, source: "typed", ...(range ? { range } : {}) })
                        return
                    }
                    case "insertFromPaste": {
                        // Reached only when the paste event exposed no text to read, as a
                        // host-driven paste may; the text is still foreign, so held as pasted.
                        const text = event.dataTransfer?.getData("text/plain") || event.data || ""
                        const target = event.getTargetRanges?.()[0]
                        const range = (target && modelRangeOf(root, target)) || selectionRange(current.selection)
                        if (!text || callbacksRef.current.onPasteText?.(text, range)) return
                        engine.apply({ type: "insert_text", text, source: "pasted", range })
                        return
                    }
                    case "insertParagraph":
                    case "insertLineBreak":
                        engine.apply({ type: "insert_text", text: "\n", source: "typed" })
                        return
                    case "historyUndo":
                        engine.undo()
                        return
                    case "historyRedo":
                        engine.redo()
                        return
                }
                const deletion = DELETE_UNIT_BY_INPUT_TYPE[event.inputType]
                if (!deletion) return
                if (!isCollapsed(current.selection)) {
                    engine.apply({ type: "delete_range", range: selectionRange(current.selection) })
                    return
                }
                // The browser knows word and line boundaries best; the engine keeps atoms whole.
                const target = deletion.unit === "character" ? undefined : event.getTargetRanges?.()[0]
                const range = target ? modelRangeOf(root, target) : undefined
                if (range && range.end > range.start) engine.apply({ type: "delete_range", range })
                else engine.apply({ type: "delete", ...deletion })
            }

            const onCompositionStart = () => {
                syncSelection()
                compositionRangeRef.current = selectionRange(engine.getState().selection)
                composingRef.current = true
            }

            const onCompositionEnd = (event: CompositionEvent) => {
                composingRef.current = false
                const range = compositionRangeRef.current
                compositionRangeRef.current = undefined
                const before = engine.getState()
                const committed = event.data ?? ""
                // A cancelled composition commits nothing, so the captured selection must
                // survive it; replacing that range with "" would delete the user's text.
                if (committed)
                    engine.apply({ type: "insert_text", text: committed, source: "typed", ...(range ? { range } : {}) })
                // The model is unchanged but the DOM still holds the composition preview.
                if (engine.getState() === before) render(before, true)
            }

            documentRef.addEventListener("selectionchange", onSelectionChange)
            root.addEventListener("beforeinput", onBeforeInput)
            root.addEventListener("compositionstart", onCompositionStart)
            root.addEventListener("compositionend", onCompositionEnd)
            return () => {
                documentRef.removeEventListener("selectionchange", onSelectionChange)
                root.removeEventListener("beforeinput", onBeforeInput)
                root.removeEventListener("compositionstart", onCompositionStart)
                root.removeEventListener("compositionend", onCompositionEnd)
            }
        }, [engine, render, syncSelection])

        useEffect(() => {
            const root = rootRef.current
            if (!root || !onHeightChange || typeof ResizeObserver === "undefined") return
            const observer = new ResizeObserver(() => onHeightChange(root.getBoundingClientRect().height))
            observer.observe(root)
            return () => observer.disconnect()
        }, [onHeightChange])

        useImperativeHandle(
            ref,
            () => ({
                focus: () => rootRef.current?.focus(),
                blur: () => rootRef.current?.blur(),
                get element() {
                    return rootRef.current
                },
                offsetAtPoint: (x, y) => {
                    const root = rootRef.current
                    const documentRef = root?.ownerDocument as
                        | (Document & { caretPositionFromPoint?: (x: number, y: number) => CaretPosition | null })
                        | undefined
                    if (!root || !documentRef) return undefined
                    const position = documentRef.caretPositionFromPoint?.(x, y)
                    if (position) return modelOffsetAt(root, position.offsetNode, position.offset)
                    const range = documentRef.caretRangeFromPoint?.(x, y)
                    return range ? modelOffsetAt(root, range.startContainer, range.startOffset) : undefined
                },
                revealCaret: () => {
                    const root = rootRef.current
                    if (root) revealSelection(root)
                },
            }),
            [],
        )

        const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (!isComposingKey(event)) {
                const atom = selectedAtom(engine.getState())
                if (atom && (event.key === "Enter" || event.key === " ") && !event.shiftKey) {
                    event.preventDefault()
                    callbacksRef.current.onChipAction?.(atom, "open")
                    return
                }
            }
            callbacksRef.current.onKeyDown?.(event)
            if (event.defaultPrevented || isComposingKey(event)) return
            const modifier = event.ctrlKey || event.metaKey
            if (!modifier || event.altKey) return
            const key = event.key.toLowerCase()
            if (key === "z" && !event.shiftKey) {
                event.preventDefault()
                engine.undo()
            } else if (key === "y" || (key === "z" && event.shiftKey)) {
                event.preventDefault()
                engine.redo()
            }
        }

        const copySelection = (event: React.ClipboardEvent<HTMLDivElement>): ComposerRange | undefined => {
            syncSelection()
            const range = selectionRange(engine.getState().selection)
            if (range.start === range.end) return undefined
            event.preventDefault()
            const fragment = sliceSegments(engine.getState().segments, range)
            event.clipboardData.setData("text/plain", plainTextOfFragment(fragment))
            event.clipboardData.setData(COMPOSER_FRAGMENT_MIME, serializeFragment(fragment, composerId))
            return range
        }

        const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
            syncSelection()
            // Only this composer's own fragment keeps its atoms; any other paste,
            // including another draft's fragment, is foreign text for onPaste first.
            const fragment = parseFragment(event.clipboardData.getData(COMPOSER_FRAGMENT_MIME), composerId)
            if (fragment) {
                event.preventDefault()
                engine.apply({ type: "insert_fragment", segments: fragment })
                return
            }
            callbacksRef.current.onPaste?.(event)
            if (event.defaultPrevented) return
            const text = event.clipboardData.getData("text/plain")
            // An event without readable text leaves the paste to the browser, which
            // then delivers it as an insertFromPaste input the editor handles.
            if (!text) return
            event.preventDefault()
            engine.apply({ type: "insert_text", text, source: "pasted" })
        }

        const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
            const root = rootRef.current
            const target = root ? chipTargetOf(root, event.target) : undefined
            if (!target) return
            const located = findAtom(engine.getState().segments, target.entityId)
            if (!located) return
            // Keep the focus and the caret in the editor while a chip control is used.
            event.preventDefault()
            root?.focus()
            engine.apply({ type: "select", selection: { anchor: located.offset, focus: located.offset + 1 } })
            if (target.action === "remove") {
                engine.apply({ type: "remove_atom", entityId: target.entityId })
                engine.apply({ type: "select", selection: caretAt(located.offset) })
            }
            callbacksRef.current.onChipAction?.(located.atom, target.action)
        }

        return (
            // biome-ignore lint/a11y/useSemanticElements: a textarea cannot hold inline chips; this is the WAI-ARIA multi-line textbox pattern.
            <div
                aria-label={props.ariaLabel}
                aria-multiline="true"
                aria-placeholder={props.placeholder}
                className={`semantic-composer ${props.className ?? ""}`}
                contentEditable
                data-placeholder={props.placeholder}
                data-testid={props.testId}
                onBlur={props.onBlur}
                onCopy={copySelection}
                onCut={(event) => {
                    const range = copySelection(event)
                    if (range) engine.apply({ type: "delete_range", range })
                }}
                onFocus={props.onFocus}
                onKeyDown={handleKeyDown}
                onMouseDown={handleMouseDown}
                onPaste={handlePaste}
                ref={rootRef}
                role="textbox"
                spellCheck
                style={props.style}
                suppressContentEditableWarning
                tabIndex={0}
            />
        )
    },
)
