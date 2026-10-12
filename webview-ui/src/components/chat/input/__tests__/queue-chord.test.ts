import { describe, expect, it } from "vitest"
import { QUEUE_CHORD_MIN_HOLD_MS, type QueueChordKeyEvent, QueueChordTracker } from "../queue-chord"

function key(overrides: Partial<QueueChordKeyEvent> & Pick<QueueChordKeyEvent, "key" | "code">): QueueChordKeyEvent {
    return { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...overrides }
}

const SHIFT_Q = key({ key: "Q", code: "KeyQ", shiftKey: true })
const SHIFT_S = key({ key: "S", code: "KeyS", shiftKey: true })
const SHIFT_ENTER = key({ key: "Enter", code: "Enter", shiftKey: true })

function tracker() {
    let time = 0
    const typed: string[] = []
    const chords = new QueueChordTracker({ insertText: (text) => typed.push(text), now: () => time })
    return {
        chords,
        typed,
        advance: (ms: number) => {
            time += ms
        },
    }
}

describe("QueueChordTracker", () => {
    it.each([
        [SHIFT_Q, "queue"],
        [SHIFT_S, "queue_plain_text"],
    ] as const)("fires %s + Enter as a chord without typing the letter", (letter, chord) => {
        const { chords, typed, advance } = tracker()

        expect(chords.keyDown(letter, false)).toEqual({ kind: "swallow" })
        advance(QUEUE_CHORD_MIN_HOLD_MS)
        expect(chords.keyDown(SHIFT_ENTER, false)).toEqual({ kind: "chord", chord })
        chords.keyUp(letter)

        expect(typed).toEqual([])
    })

    it("types the held letter when it is released without Enter", () => {
        const { chords, typed } = tracker()

        chords.keyDown(SHIFT_Q, false)
        expect(typed).toEqual([])
        chords.keyUp(SHIFT_Q)

        expect(typed).toEqual(["Q"])
    })

    it("types the held letter before the next key, so rolled-over typing keeps its order", () => {
        const { chords, typed } = tracker()

        chords.keyDown(SHIFT_Q, false)
        expect(chords.keyDown(key({ key: "U", code: "KeyU", shiftKey: true }), false)).toEqual({ kind: "pass" })

        expect(typed).toEqual(["Q"])
    })

    it("treats a capital letter typed just before Enter as text, not a chord", () => {
        const { chords, typed, advance } = tracker()

        chords.keyDown(SHIFT_S, false)
        advance(QUEUE_CHORD_MIN_HOLD_MS - 1)

        expect(chords.keyDown(SHIFT_ENTER, false)).toEqual({ kind: "pass" })
        expect(typed).toEqual(["S"])
    })

    it("swallows auto-repeat of the held key, so a long hold types one letter", () => {
        const { chords, typed } = tracker()

        chords.keyDown(SHIFT_Q, false)
        expect(chords.keyDown({ ...SHIFT_Q, repeat: true }, false)).toEqual({ kind: "swallow" })
        chords.keyUp(SHIFT_Q)

        expect(typed).toEqual(["Q"])
    })

    it("leaves lowercase letters and modified letters to the editor", () => {
        const { chords, typed } = tracker()

        expect(chords.keyDown(key({ key: "q", code: "KeyQ" }), false)).toEqual({ kind: "pass" })
        expect(chords.keyDown(key({ key: "S", code: "KeyS", shiftKey: true, ctrlKey: true }), false)).toEqual({
            kind: "pass",
        })
        expect(typed).toEqual([])
    })

    it("needs Shift on Enter too; a plain Enter types the letter and sends as usual", () => {
        const { chords, typed, advance } = tracker()

        chords.keyDown(SHIFT_Q, false)
        advance(QUEUE_CHORD_MIN_HOLD_MS)

        expect(chords.keyDown(key({ key: "Enter", code: "Enter" }), false)).toEqual({ kind: "pass" })
        expect(typed).toEqual(["Q"])
    })

    it("writes the held letter when the editor loses focus", () => {
        const { chords, typed } = tracker()

        chords.keyDown(SHIFT_S, false)
        chords.flush()
        chords.flush()

        expect(typed).toEqual(["S"])
    })

    it("stays out of IME composition", () => {
        const { chords, typed } = tracker()

        expect(chords.keyDown(SHIFT_Q, true)).toEqual({ kind: "pass" })
        expect(typed).toEqual([])
    })
})
