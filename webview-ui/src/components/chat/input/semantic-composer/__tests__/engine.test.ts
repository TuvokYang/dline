import { describe, expect, it } from "vitest"
import { SemanticComposerEngine } from "../engine"
import {
    type ComposerAtom,
    type ComposerSegment,
    type ComposerState,
    type ComposerTextSource,
    caretAt,
    flatTextOf,
    type MentionAtom,
    type ResourceAtom,
    sliceSegments,
    trimSegments,
} from "../model"

const mention: MentionAtom = {
    kind: "mention",
    entityId: "m-1",
    mentionKind: "file",
    sourceText: "@/src/a.ts",
    canonicalRef: "/src/a.ts",
}

const image: ResourceAtom = {
    kind: "resource",
    entityId: "r-1",
    nodeKind: "image",
    fileOrigin: "pasted_file",
    displayName: "shot.png",
    status: "staging",
}

function engineWith(segments: readonly ComposerSegment[], caret?: number) {
    let clock = 0
    const flat = flatTextOf(segments)
    const initial: ComposerState = { segments, selection: caretAt(caret ?? flat.length), revision: 0 }
    const engine = new SemanticComposerEngine({ initial, now: () => clock })
    return { engine, advance: (ms: number) => (clock += ms) }
}

const text = (value: string, source: ComposerTextSource = "typed"): ComposerSegment => ({ kind: "text", text: value, source })
const atom = (value: ComposerAtom): ComposerSegment => ({ kind: "atom", atom: value })

describe("SemanticComposerEngine", () => {
    it("inserts typed text at the caret and moves the caret after it", () => {
        const { engine } = engineWith([text("helo")], 3)
        engine.apply({ type: "insert_text", text: "l", source: "typed" })
        expect(flatTextOf(engine.getState().segments)).toBe("hello")
        expect(engine.getState().selection).toEqual(caretAt(4))
    })

    it("keeps where each run of text came from", () => {
        const { engine } = engineWith([text("ask ")])
        engine.apply({ type: "insert_text", text: "/compact", source: "pasted" })
        engine.apply({ type: "insert_text", text: " now", source: "typed" })
        expect(engine.getState().segments).toEqual([text("ask "), text("/compact", "pasted"), text(" now")])
    })

    it("normalizes pasted line endings and drops placeholder look-alikes", () => {
        const { engine } = engineWith([])
        engine.apply({ type: "insert_text", text: "a\r\nb\rc\uFFFC", source: "pasted" })
        expect(flatTextOf(engine.getState().segments)).toBe("a\nb\nc")
    })

    it("separates a mention atom from neighbouring words and puts the caret after its space", () => {
        const { engine } = engineWith([text("see")])
        engine.apply({ type: "insert_atom", atom: mention })
        expect(engine.getState().segments).toEqual([text("see "), atom(mention), text(" ")])
        expect(engine.getState().selection).toEqual(caretAt(6))
    })

    it("replaces the typed trigger a menu pick consumes", () => {
        const { engine } = engineWith([text("look @/sr please")], 9)
        engine.apply({ type: "insert_atom", atom: mention, range: { start: 5, end: 9 } })
        expect(engine.getState().segments).toEqual([text("look "), atom(mention), text(" please")])
        // The separator that already followed the trigger is reused, and the caret lands after it.
        expect(engine.getState().selection).toEqual(caretAt(7))
    })

    it("inserts a resource exactly at the caret without adding spaces", () => {
        const { engine } = engineWith([text("ab")], 1)
        engine.apply({ type: "insert_atom", atom: image })
        expect(engine.getState().segments).toEqual([text("a"), atom(image), text("b")])
        expect(engine.getState().selection).toEqual(caretAt(2))
    })

    it("deletes an atom as a whole with one backspace", () => {
        const { engine } = engineWith([text("a"), atom(image), text("b")], 2)
        engine.apply({ type: "delete", direction: "backward", unit: "character" })
        expect(engine.getState().segments).toEqual([text("ab")])
        expect(engine.getState().selection).toEqual(caretAt(1))
    })

    it("deletes a whole grapheme cluster, never half a surrogate pair", () => {
        const { engine } = engineWith([text("a👍🏽")])
        engine.apply({ type: "delete", direction: "backward", unit: "character" })
        expect(flatTextOf(engine.getState().segments)).toBe("a")
    })

    it("deletes forward over an atom and by word around atoms", () => {
        const { engine } = engineWith([text("one two"), atom(image), text(" three")], 7)
        engine.apply({ type: "delete", direction: "forward", unit: "word" })
        expect(flatTextOf(engine.getState().segments)).toBe("one two three")
        engine.apply({ type: "delete", direction: "backward", unit: "word" })
        expect(flatTextOf(engine.getState().segments)).toBe("one  three")
    })

    it("swaps an atom in place without moving the caret", () => {
        const { engine } = engineWith([text("a"), atom(image), text("b")], 3)
        const ready: ResourceAtom = { ...image, status: "ready" }
        engine.apply({ type: "replace_atom", entityId: image.entityId, atom: ready })
        expect(engine.getState().segments[1]).toEqual(atom(ready))
        expect(engine.getState().selection).toEqual(caretAt(3))
    })

    // A settlement is not an edit: undo must never bring back a placeholder whose staging is over.
    it("settles an atom without an undo step, also in the states undo and redo reach", () => {
        const { engine } = engineWith([text("a")], 1)
        engine.apply({ type: "insert_atom", atom: image })
        engine.apply({ type: "insert_text", text: "b", source: "typed" })
        const ready: ResourceAtom = { ...image, status: "ready" }

        engine.apply({ type: "replace_atom", entityId: image.entityId, atom: ready })
        expect(engine.getState().segments[1]).toEqual(atom(ready))

        engine.undo()
        expect(flatTextOf(engine.getState().segments)).toBe(flatTextOf([text("a"), atom(ready)]))
        expect(engine.getState().segments[1]).toEqual(atom(ready))
        engine.undo()
        expect(flatTextOf(engine.getState().segments)).toBe("a")
        engine.redo()
        expect(engine.getState().segments[1]).toEqual(atom(ready))
    })

    it("settles an atom the user removed, so undo restores it settled", () => {
        const { engine } = engineWith([text("a"), atom(image)], 2)
        engine.apply({ type: "remove_atom", entityId: image.entityId })
        const ready: ResourceAtom = { ...image, status: "ready" }

        engine.apply({ type: "replace_atom", entityId: image.entityId, atom: ready })
        expect(flatTextOf(engine.getState().segments)).toBe("a")

        engine.undo()
        expect(engine.getState().segments[1]).toEqual(atom(ready))
    })

    it("removes an atom by identity and keeps the caret on the same character", () => {
        const { engine } = engineWith([text("a"), atom(image), text("bc")], 3)
        engine.apply({ type: "remove_atom", entityId: image.entityId })
        expect(flatTextOf(engine.getState().segments)).toBe("abc")
        expect(engine.getState().selection).toEqual(caretAt(2))
    })

    it("undoes consecutive typing as one step and redoes it", () => {
        const { engine, advance } = engineWith([])
        for (const character of "hello") {
            engine.apply({ type: "insert_text", text: character, source: "typed" })
            advance(100)
        }
        engine.undo()
        expect(flatTextOf(engine.getState().segments)).toBe("")
        engine.redo()
        expect(flatTextOf(engine.getState().segments)).toBe("hello")
    })

    it("starts a new undo step after a pause, a caret move or a structural edit", () => {
        const { engine, advance } = engineWith([])
        engine.apply({ type: "insert_text", text: "a", source: "typed" })
        advance(2000)
        engine.apply({ type: "insert_text", text: "b", source: "typed" })
        engine.apply({ type: "select", selection: caretAt(0) })
        engine.apply({ type: "insert_text", text: "c", source: "typed" })
        engine.apply({ type: "insert_atom", atom: image })

        engine.undo()
        expect(flatTextOf(engine.getState().segments)).toBe("cab")
        engine.undo()
        expect(flatTextOf(engine.getState().segments)).toBe("ab")
        engine.undo()
        expect(flatTextOf(engine.getState().segments)).toBe("a")
        engine.undo()
        expect(flatTextOf(engine.getState().segments)).toBe("")
    })

    it("restores the atom identity and selection on undo", () => {
        const { engine } = engineWith([text("a"), atom(image), text("b")], 2)
        engine.apply({ type: "delete", direction: "backward", unit: "character" })
        engine.undo()
        expect(engine.getState().segments).toEqual([text("a"), atom(image), text("b")])
        expect(engine.getState().selection).toEqual(caretAt(2))
    })

    it("clears the history when a different draft is loaded", () => {
        const { engine } = engineWith([])
        engine.apply({ type: "insert_text", text: "first", source: "typed" })
        engine.apply({ type: "load", segments: [text("second", "restored")] })
        expect(engine.canUndo()).toBe(false)
        engine.undo()
        expect(flatTextOf(engine.getState().segments)).toBe("second")
    })

    it("starts a loaded draft's history with the one step it seeds", () => {
        const { engine } = engineWith([])
        engine.apply({ type: "insert_text", text: "first", source: "typed" })
        engine.apply({ type: "insert_text", text: " more", source: "pasted" })
        engine.apply({ type: "load", segments: [], undoTo: [text("sent"), atom(mention)] })

        expect(engine.getState().segments).toEqual([])
        engine.undo()
        expect(engine.getState().segments).toEqual([text("sent"), atom(mention)])
        expect(engine.getState().selection).toEqual(caretAt(5))
        // Nothing before the seed survives the load.
        expect(engine.canUndo()).toBe(false)
        engine.redo()
        expect(engine.getState().segments).toEqual([])
    })

    it("drops redo after a new edit", () => {
        const { engine } = engineWith([])
        engine.apply({ type: "insert_text", text: "a", source: "typed" })
        engine.undo()
        engine.apply({ type: "insert_text", text: "b", source: "pasted" })
        engine.redo()
        expect(flatTextOf(engine.getState().segments)).toBe("b")
    })

    it("publishes each change and stops after dispose", () => {
        const { engine } = engineWith([])
        const seen: string[] = []
        const subscription = engine.subscribe((state) => seen.push(flatTextOf(state.segments)))
        engine.apply({ type: "insert_text", text: "a", source: "typed" })
        engine.apply({ type: "select", selection: caretAt(1) })
        subscription.dispose()
        engine.apply({ type: "insert_text", text: "b", source: "typed" })
        expect(seen).toEqual(["a"])
    })

    it("bumps the revision for content changes only", () => {
        const { engine } = engineWith([text("ab")], 0)
        engine.apply({ type: "select", selection: caretAt(1) })
        expect(engine.getState().revision).toBe(0)
        engine.apply({ type: "insert_text", text: "x", source: "typed" })
        expect(engine.getState().revision).toBe(1)
    })
})

describe("composer model helpers", () => {
    it("slices a fragment with its atoms", () => {
        const segments = [text("ab"), atom(image), text("cd")]
        expect(sliceSegments(segments, { start: 1, end: 4 })).toEqual([text("b"), atom(image), text("c")])
    })

    it("trims around visible content but keeps atoms", () => {
        expect(trimSegments([text("  "), atom(image), text(" x  ")])).toEqual([atom(image), text(" x")])
        expect(trimSegments([text("  \n ")])).toEqual([])
    })
})
