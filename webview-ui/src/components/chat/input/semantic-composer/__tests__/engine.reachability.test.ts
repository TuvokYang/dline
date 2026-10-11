import { describe, expect, it } from "vitest"
import { SemanticComposerEngine } from "../engine"
import { type ComposerSegment, type ComposerState, flatTextOf } from "../model"

const typed = (text: string): ComposerSegment => ({ kind: "text", text, source: "typed" })

function texts(states: readonly ComposerState[]): string[] {
    return states.map((state) => flatTextOf(state.segments))
}

/** An engine whose clock advances a full second per edit, so every edit is its own undo step. */
function steppedEngine(historyLimit?: number): SemanticComposerEngine {
    let now = 0
    return new SemanticComposerEngine({ now: () => (now += 2_000), ...(historyLimit ? { historyLimit } : {}) })
}

describe("SemanticComposerEngine reachability", () => {
    it("counts a new generation for every loaded draft and for nothing else", () => {
        const engine = steppedEngine()
        const start = engine.generation

        engine.apply({ type: "insert_text", text: "a", source: "typed" })
        expect(engine.generation).toBe(start)

        engine.apply({ type: "load", segments: [typed("next")] })
        expect(engine.generation).toBe(start + 1)
    })

    it("keeps a held draft reachable through the next load and releases it at the load after", () => {
        const engine = steppedEngine()
        engine.apply({ type: "load", segments: [typed("sent")] })
        const announced: string[][] = []
        engine.onReachabilityChange((reachable) => announced.push(texts(reachable)))

        engine.holdThroughNextLoad(engine.getState())
        engine.apply({ type: "load", segments: [] })
        expect(announced.at(-1)).toContain("sent")

        engine.apply({ type: "load", segments: [typed("other")] })
        expect(announced.at(-1)).not.toContain("sent")
    })

    it("announces the states an edit discards from the redo stack", () => {
        const engine = steppedEngine()
        engine.apply({ type: "insert_text", text: "a", source: "typed" })
        engine.apply({ type: "insert_text", text: "b", source: "typed" })
        engine.undo()
        const announced: string[][] = []
        engine.onReachabilityChange((reachable) => announced.push(texts(reachable)))

        engine.apply({ type: "insert_text", text: "c", source: "typed" })

        expect(announced).toHaveLength(1)
        expect(announced[0]).not.toContain("ab")
    })

    it("announces the undo step the history limit drops", () => {
        const engine = steppedEngine(2)
        const announced: string[][] = []
        engine.onReachabilityChange((reachable) => announced.push(texts(reachable)))

        engine.apply({ type: "insert_text", text: "a", source: "typed" })
        engine.apply({ type: "insert_text", text: "b", source: "typed" })
        expect(announced).toHaveLength(0)

        engine.apply({ type: "insert_text", text: "c", source: "typed" })
        expect(announced).toHaveLength(1)
        expect(announced[0]).not.toContain("")
    })
})
