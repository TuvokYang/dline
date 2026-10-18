import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { act, fireEvent, render } from "@testing-library/react"
import { createRef } from "react"
import { describe, expect, it, vi } from "vitest"
import { COMPOSER_FRAGMENT_MIME } from "../clipboard"
import { plainTextOfComposerDom, writeModelSelection } from "../dom"
import { SemanticComposerEngine } from "../engine"
import { type ComposerSegment, caretAt, flatTextOf, type ResourceAtom } from "../model"
import { SemanticComposerEditor, type SemanticComposerEditorHandle } from "../SemanticComposerEditor"

// Read the stylesheet source directly: Vitest does not process CSS, so a `?raw` import resolves to an empty string.
const composerCss = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../semantic-composer.css"), "utf8")

/** The element selector of the stylesheet rule that draws the placeholder hint. */
function placeholderHostSelector(): string {
    const rule = /([^{}]+)\{[^}]*content:\s*attr\(data-placeholder\)/.exec(composerCss)
    if (!rule) throw new Error("semantic-composer.css no longer draws the placeholder from data-placeholder")
    return rule[1]
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim()
        .replace(/::before$/, "")
}

const image: ResourceAtom = {
    kind: "resource",
    entityId: "img-1",
    nodeKind: "image",
    fileOrigin: "pasted_file",
    displayName: "shot.png",
    status: "staging",
}

function setup(segments: readonly ComposerSegment[] = [], caret?: number) {
    const engine = new SemanticComposerEngine({
        initial: { segments, selection: caretAt(caret ?? flatTextOf(segments).length), revision: 0 },
    })
    const onChipAction = vi.fn()
    const handle = createRef<SemanticComposerEditorHandle>()
    const view = render(
        <SemanticComposerEditor
            ariaLabel="Message"
            composerId="composer-a"
            engine={engine}
            onChipAction={onChipAction}
            placeholder="Type a message..."
            ref={handle}
            testId="chat-input"
        />,
    )
    const root = view.getByTestId("chat-input")
    act(() => root.focus())
    const place = (offset: number) => act(() => writeModelSelection(root, caretAt(offset)))
    const input = (inputType: string, data?: string) =>
        act(() => {
            root.dispatchEvent(new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true }))
        })
    return { engine, root, place, input, onChipAction, handle }
}

function clipboard(data: Record<string, string> = {}) {
    const store = new Map(Object.entries(data))
    return {
        getData: (type: string) => store.get(type) ?? "",
        setData: (type: string, value: string) => store.set(type, value),
        store,
    }
}

describe("SemanticComposerEditor", () => {
    it("is an accessible multi-line textbox with a placeholder", () => {
        const { root } = setup()
        expect(root.getAttribute("role")).toBe("textbox")
        expect(root.getAttribute("aria-multiline")).toBe("true")
        expect(root.getAttribute("aria-placeholder")).toBe("Type a message...")
        expect(root.dataset.empty).toBe("true")
    })

    // The hint gives way to the caret: an empty box shows it only while unfocused.
    it("hides the placeholder hint while the empty box has focus", () => {
        const { root } = setup()
        const hint = placeholderHostSelector()
        // jsdom 30's selector engine caches `:not(:focus)` per element, so a blur
        // never flips `matches(hint)`. Check the focus gate and the empty-box host
        // separately against the real focus state instead.
        const focusGate = ":not(:focus)"
        expect(hint.endsWith(focusGate)).toBe(true)
        const host = hint.slice(0, -focusGate.length)

        expect(root.matches(host)).toBe(true)
        expect(document.activeElement).toBe(root)
        act(() => root.blur())
        expect(document.activeElement).not.toBe(root)
        expect(root.matches(host)).toBe(true)
    })

    it("turns typed input into engine edits at the DOM caret", () => {
        const { engine, root, place, input } = setup([{ kind: "text", text: "helo", source: "typed" }])
        place(3)
        input("insertText", "l")
        expect(flatTextOf(engine.getState().segments)).toBe("hello")
        expect(plainTextOfComposerDom(root)).toBe("hello")
        expect(engine.getState().selection).toEqual(caretAt(4))
    })

    it("inserts a newline for Enter and Shift+Enter that the parent did not take", () => {
        const { engine, input } = setup()
        input("insertParagraph")
        input("insertLineBreak")
        expect(flatTextOf(engine.getState().segments)).toBe("\n\n")
    })

    it("renders atoms as non-editable chips at their position and deletes them whole", () => {
        const { engine, root, place, input } = setup([
            { kind: "text", text: "a", source: "typed" },
            { kind: "atom", atom: image },
            { kind: "text", text: "b", source: "typed" },
        ])
        const chip = root.querySelector('[data-entity-id="img-1"]')
        expect(chip?.getAttribute("contenteditable")).toBe("false")
        expect(chip?.previousElementSibling?.textContent).toBe("a")
        expect(chip?.nextElementSibling?.textContent).toBe("b")

        place(2)
        input("deleteContentBackward")
        expect(engine.getState().segments).toEqual([{ kind: "text", text: "ab", source: "typed" }])
        expect(root.querySelector("[data-composer-atom]")).toBeNull()
    })

    it("gives the caret a text position after a trailing atom", () => {
        const { root, engine } = setup([{ kind: "atom", atom: image }])
        act(() => writeModelSelection(root, caretAt(1)))
        const selection = document.getSelection()
        expect(selection?.anchorNode?.parentElement?.hasAttribute("data-composer-anchor")).toBe(true)
        expect(engine.getState().selection).toEqual(caretAt(1))
    })

    it("commits IME composition once, at the position where it started", () => {
        const { engine, root, place } = setup([{ kind: "text", text: "ab", source: "typed" }])
        place(1)
        act(() => {
            root.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }))
            // The IME edits the DOM natively; the engine must not react until the end.
            root.dispatchEvent(
                new InputEvent("beforeinput", {
                    inputType: "insertCompositionText",
                    data: "ni",
                    isComposing: true,
                    cancelable: true,
                }),
            )
            root.dispatchEvent(new CompositionEvent("compositionend", { data: "你" }))
        })
        expect(flatTextOf(engine.getState().segments)).toBe("a你b")
        expect(engine.getState().selection).toEqual(caretAt(2))
        expect(plainTextOfComposerDom(root)).toBe("a你b")
    })

    it("restores the DOM when a composition is cancelled", () => {
        const { engine, root, place } = setup([{ kind: "text", text: "ab", source: "typed" }])
        place(1)
        act(() => {
            root.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }))
            root.querySelector("[data-composer-text]")?.firstChild?.replaceWith(document.createTextNode("aXXb"))
            root.dispatchEvent(new CompositionEvent("compositionend", { data: "" }))
        })
        expect(flatTextOf(engine.getState().segments)).toBe("ab")
        expect(plainTextOfComposerDom(root)).toBe("ab")
    })

    it("keeps a selected text range when a composition over it is cancelled", () => {
        const { engine, root } = setup([{ kind: "text", text: "abc", source: "typed" }])
        act(() => writeModelSelection(root, { anchor: 0, focus: 2 }))
        act(() => {
            root.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }))
            root.dispatchEvent(new CompositionEvent("compositionend", { data: "" }))
        })
        expect(flatTextOf(engine.getState().segments)).toBe("abc")
        expect(plainTextOfComposerDom(root)).toBe("abc")
    })

    it("keeps a selected atom when a composition over it is cancelled", () => {
        const segments: readonly ComposerSegment[] = [
            { kind: "text", text: "a", source: "typed" },
            { kind: "atom", atom: image },
            { kind: "text", text: "b", source: "typed" },
        ]
        const { engine, root } = setup(segments)
        act(() => writeModelSelection(root, { anchor: 0, focus: 2 }))
        act(() => {
            root.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }))
            root.dispatchEvent(new CompositionEvent("compositionend", { data: "" }))
        })
        expect(engine.getState().segments).toEqual(segments)
        expect(root.querySelector('[data-entity-id="img-1"]')).not.toBeNull()
    })

    it("undoes and redoes with the keyboard and the browser history commands", () => {
        const { engine, root, input } = setup()
        input("insertText", "x")
        fireEvent.keyDown(root, { key: "z", ctrlKey: true })
        expect(flatTextOf(engine.getState().segments)).toBe("")
        input("historyRedo")
        expect(flatTextOf(engine.getState().segments)).toBe("x")
        input("historyUndo")
        expect(flatTextOf(engine.getState().segments)).toBe("")
    })

    it("lets the parent take a key before the editor", () => {
        const engine = new SemanticComposerEngine()
        const onKeyDown = vi.fn((event: React.KeyboardEvent) => event.preventDefault())
        const view = render(
            <SemanticComposerEditor ariaLabel="m" composerId="c" engine={engine} onKeyDown={onKeyDown} testId="t" />,
        )
        fireEvent.keyDown(view.getByTestId("t"), { key: "z", ctrlKey: true })
        expect(onKeyDown).toHaveBeenCalledOnce()
    })

    it("pastes plain text as pasted text and keeps it held", () => {
        const { engine, root } = setup()
        act(() => {
            fireEvent.paste(root, { clipboardData: clipboard({ "text/plain": "/compact" }) })
        })
        expect(engine.getState().segments).toEqual([{ kind: "text", text: "/compact", source: "pasted" }])
    })

    // A host-driven paste (the VS Code webview's) may expose no clipboard text in
    // the paste event; the browser then inserts it, and the editor must take that
    // insertion instead of cancelling it and losing the text.
    it("leaves a paste without readable text to the browser and holds its insertion as pasted", () => {
        const { engine, root, input } = setup()
        let notCancelled = false
        act(() => {
            notCancelled = fireEvent.paste(root, { clipboardData: clipboard() })
        })
        expect(notCancelled).toBe(true)

        input("insertFromPaste", "/compact keep")

        expect(engine.getState().segments).toEqual([{ kind: "text", text: "/compact keep", source: "pasted" }])
    })

    it("offers a paste that arrives only as an insertion to the parent first", () => {
        const engine = new SemanticComposerEngine()
        const onPasteText = vi.fn(() => true)
        const view = render(
            <SemanticComposerEditor ariaLabel="Message" composerId="composer-a" engine={engine} onPasteText={onPasteText} />,
        )
        const root = view.getByRole("textbox")
        act(() => {
            root.focus()
            root.dispatchEvent(
                new InputEvent("beforeinput", {
                    inputType: "insertFromPaste",
                    data: "long text",
                    bubbles: true,
                    cancelable: true,
                }),
            )
        })

        expect(onPasteText).toHaveBeenCalledWith("long text", { start: 0, end: 0 })
        expect(engine.getState().segments).toEqual([])
    })

    it("copies a fragment with its atoms and pastes it back as new atoms", () => {
        const ready: ResourceAtom = {
            ...image,
            status: "ready",
            ref: {
                resourceId: "r-1",
                expectedContentHash: "sha256:abc",
                mediaType: "image/png",
                byteLength: 3,
                owner: { kind: "draft", draftId: "composer-a" },
                generation: 1,
            },
        }
        const { engine, root } = setup([
            { kind: "text", text: "a", source: "typed" },
            { kind: "atom", atom: ready },
        ])
        act(() => engine.apply({ type: "select", selection: { anchor: 0, focus: 2 } }))
        const data = clipboard()
        act(() => {
            fireEvent.copy(root, { clipboardData: data })
        })
        expect(data.store.get("text/plain")).toBe("a[shot.png]")
        act(() => engine.apply({ type: "select", selection: caretAt(2) }))
        act(() => {
            fireEvent.paste(root, {
                clipboardData: clipboard({ [COMPOSER_FRAGMENT_MIME]: data.store.get(COMPOSER_FRAGMENT_MIME) ?? "" }),
            })
        })
        const atoms = engine.getState().segments.filter((segment) => segment.kind === "atom")
        expect(atoms).toHaveLength(2)
        expect(new Set(atoms.map((segment) => segment.kind === "atom" && segment.atom.entityId)).size).toBe(2)
    })

    it("offers another draft's fragment to onPaste as foreign text and inserts its plain text as pasted", () => {
        const engine = new SemanticComposerEngine({ initial: { segments: [], selection: caretAt(0), revision: 0 } })
        const onPaste = vi.fn()
        const view = render(
            <SemanticComposerEditor ariaLabel="Message" composerId="composer-a" engine={engine} onPaste={onPaste} />,
        )
        const foreign = JSON.stringify({
            version: 1,
            composerId: "composer-b",
            segments: [{ kind: "text", text: "/compact", source: "typed" }],
        })

        act(() => {
            fireEvent.paste(view.getByRole("textbox"), {
                clipboardData: clipboard({ "text/plain": "/compact", [COMPOSER_FRAGMENT_MIME]: foreign }),
            })
        })

        expect(onPaste).toHaveBeenCalledOnce()
        expect(engine.getState().segments).toEqual([{ kind: "text", text: "/compact", source: "pasted" }])
    })

    it("removes a chip with its remove control and opens it with Enter when selected", () => {
        const { engine, root, onChipAction } = setup([{ kind: "atom", atom: image }])
        act(() => engine.apply({ type: "select", selection: { anchor: 0, focus: 1 } }))
        fireEvent.keyDown(root, { key: "Enter" })
        expect(onChipAction).toHaveBeenCalledWith(image, "open")

        const remove = root.querySelector('[data-chip-action="remove"]')
        if (!remove) throw new Error("remove control expected")
        fireEvent.mouseDown(remove)
        expect(engine.getState().segments).toEqual([])
        expect(onChipAction).toHaveBeenLastCalledWith(image, "remove")
    })

    it("re-renders when the draft changes from outside", () => {
        const { engine, root } = setup()
        act(() => engine.apply({ type: "load", segments: [{ kind: "text", text: "restored", source: "restored" }] }))
        expect(plainTextOfComposerDom(root)).toBe("restored")
        expect(root.dataset.empty).toBe("false")
    })
})
