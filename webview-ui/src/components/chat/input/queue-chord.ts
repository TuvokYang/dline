import { QUEUE_CHORD_KEY_CODES, type QueueChord } from "@/utils/chat-input-shortcut"

/** The parts of a keyboard event the chord reads. */
export interface QueueChordKeyEvent {
    readonly key: string
    readonly code: string
    readonly shiftKey: boolean
    readonly ctrlKey: boolean
    readonly altKey: boolean
    readonly metaKey: boolean
    readonly repeat: boolean
}

/**
 * What the composer does with a key press the chord has seen.
 *
 * - `pass`: an ordinary key; the composer handles it as before.
 * - `swallow`: the chord holds this key back; prevent its default.
 * - `chord`: Enter completed a chord; prevent the default and hand the draft over.
 */
export type QueueChordOutcome =
    | { readonly kind: "pass" }
    | { readonly kind: "swallow" }
    | { readonly kind: "chord"; readonly chord: QueueChord }

/**
 * How long the chord key must already be down when Enter arrives. Typing a
 * capital Q or S and Enter in quick succession overlaps the keys for a few
 * dozen milliseconds; that is a typed letter followed by Enter, not a chord.
 */
export const QUEUE_CHORD_MIN_HOLD_MS = 150

export interface QueueChordTrackerOptions {
    /** Types a letter the tracker held back, exactly as the browser would have typed it. */
    readonly insertText: (text: string) => void
    readonly now?: () => number
    readonly minHoldMs?: number
}

interface HeldChordKey {
    readonly chord: QueueChord
    readonly code: string
    /** The character the key would have typed, written once the key turns out not to be a chord. */
    readonly text: string
    readonly since: number
}

const PASS: QueueChordOutcome = { kind: "pass" }
const SWALLOW: QueueChordOutcome = { kind: "swallow" }

function chordOfCode(code: string): QueueChord | undefined {
    for (const [chord, chordCode] of Object.entries(QUEUE_CHORD_KEY_CODES) as [QueueChord, string][]) {
        if (chordCode === code) return chord
    }
    return undefined
}

function hasOnlyShift(event: QueueChordKeyEvent): boolean {
    return event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
}

/**
 * Recognizes Shift + Q + Enter and Shift + S + Enter in the composer.
 *
 * Holding Shift and Q would type a capital Q before Enter is pressed, so the
 * tracker holds that letter back instead of letting the browser type it. If
 * Enter follows while the key is still down, the letter was never text and the
 * chord fires. Otherwise the letter is written as soon as anything else
 * happens - the key is released, another key is pressed, or the editor loses
 * focus - so ordinary typing keeps its characters and their order.
 */
export class QueueChordTracker {
    private held: HeldChordKey | undefined
    private readonly insertText: (text: string) => void
    private readonly now: () => number
    private readonly minHoldMs: number

    constructor(options: QueueChordTrackerOptions) {
        this.insertText = options.insertText
        this.now = options.now ?? (() => performance.now())
        this.minHoldMs = options.minHoldMs ?? QUEUE_CHORD_MIN_HOLD_MS
    }

    keyDown(event: QueueChordKeyEvent, isComposing: boolean): QueueChordOutcome {
        if (isComposing) {
            this.flush()
            return PASS
        }
        if (this.held && event.code === this.held.code) {
            // Auto-repeat of the held key: one press types one letter.
            return SWALLOW
        }
        if (event.key === "Enter") return this.enter(event)
        // Shift is part of the chord; pressing it again must not release the letter.
        if (event.key === "Shift") return PASS

        const chord = chordOfCode(event.code)
        if (chord && hasOnlyShift(event) && !event.repeat && event.key.length === 1) {
            this.flush()
            this.held = { chord, code: event.code, text: event.key, since: this.now() }
            return SWALLOW
        }
        this.flush()
        return PASS
    }

    keyUp(event: Pick<QueueChordKeyEvent, "code">): void {
        if (this.held && event.code === this.held.code) this.flush()
    }

    /** Write a held letter now, as the browser would have when the key went down. */
    flush(): void {
        const held = this.held
        if (!held) return
        this.held = undefined
        this.insertText(held.text)
    }

    private enter(event: QueueChordKeyEvent): QueueChordOutcome {
        const held = this.held
        if (held && hasOnlyShift(event) && this.now() - held.since >= this.minHoldMs) {
            this.held = undefined
            return { kind: "chord", chord: held.chord }
        }
        this.flush()
        return PASS
    }
}
