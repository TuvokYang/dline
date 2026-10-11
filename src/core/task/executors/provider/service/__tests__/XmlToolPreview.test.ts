import { parseAssistantMessage, type ToolUse } from "@core/assistant-message"
import { describe, expect, it } from "vitest"
import { assistantProse, XmlToolPreview } from "../XmlToolPreview"

function preview() {
    let next = 0
    return new XmlToolPreview(() => ++next)
}

/** Stream `reply` one piece at a time, as a provider would, collecting every card drawn. */
function stream(target: XmlToolPreview, pieces: readonly string[]): { prose: string[]; cards: ToolUse[] } {
    let text = ""
    const prose: string[] = []
    const cards: ToolUse[] = []
    for (const piece of pieces) {
        text += piece
        const frame = target.read(text)
        prose.push(frame.prose)
        cards.push(...frame.cards())
    }
    return { prose, cards }
}

function settle(target: XmlToolPreview, text: string): ToolUse[] {
    let identity = 0
    const blocks = parseAssistantMessage(
        text,
        target.registry(() => ({ function_id: `call-${++identity}`, dline_tid: `tid-${identity}` })),
    )
    return blocks.filter((block): block is ToolUse => block.type === "tool_use" && !block.partial)
}

describe("XmlToolPreview", () => {
    // WS-051 stripped markup from the streamed prose but drew no card for it,
    // so a call written as markup stayed invisible until the turn settled.
    it("draws one card per call while it streams and settles the call on that card's row", () => {
        const target = preview()
        const pieces = ["Reading it. <read_file>", "<path>src/a", ".ts</path>", "</read_file>"]

        const { prose, cards } = stream(target, pieces)

        expect(prose.every((value) => value === "Reading it.")).toBe(true)
        expect(cards.map((card) => [card.name, card.params.path, card.partial])).toEqual([
            ["read_file", undefined, true],
            ["read_file", "src/a.ts", true],
        ])
        expect(new Set(cards.map((card) => card.ts)).size).toBe(1)
        expect(cards.every((card) => card.function_id === "" && card.dline_tid === "")).toBe(true)

        const [settled] = settle(target, pieces.join(""))
        expect(settled).toMatchObject({ name: "read_file", ts: cards[0].ts, function_id: "call-1", dline_tid: "tid-1" })
    })

    it("gives each call of a reply its own row, in the order they were written", () => {
        const target = preview()
        const reply = "<read_file><path>a.ts</path></read_file><read_file><path>b.ts</path></read_file>"

        const { cards } = stream(target, [reply.slice(0, 40), reply.slice(40)])
        const rows = [...new Map(cards.map((card) => [card.params.path, card.ts])).values()]

        expect(rows).toHaveLength(2)
        expect(rows[0]).toBeLessThan(rows[1])
        expect(settle(target, reply).map((tool) => tool.ts)).toEqual(rows)
    })

    it("redraws a card only when what it shows changed", () => {
        const target = preview()

        const { cards } = stream(target, ["<read_file><path>a.ts</path>", "  ", "\n", "</read_file>"])

        expect(cards).toHaveLength(1)
    })

    // A model that never closes its markup leaves a call that never runs; it must
    // neither run nor reappear as prose, so the turn keeps only what it said.
    it("leaves a call that never closed out of the settled turn and out of the prose", () => {
        const target = preview()
        const reply = "Writing it. <write_to_file><path>a.ts</path><content>partial"

        const { prose, cards } = stream(target, [reply])

        expect(cards).toEqual([
            expect.objectContaining({ name: "write_to_file", params: expect.objectContaining({ content: "partial" }) }),
        ])
        expect(prose).toEqual(["Writing it."])
        expect(settle(target, reply)).toEqual([])
        expect(assistantProse(reply)).toBe("Writing it.")
    })

    it("holds back a trailing tag that may still open a call and releases it once it cannot", () => {
        const target = preview()

        expect(target.read("Let me look <").prose).toBe("Let me look")
        expect(target.read("Let me look <read_fi").prose).toBe("Let me look")
        expect(target.read("Let me look <read_fix").prose).toBe("Let me look <read_fix")
        expect(target.read("Is a < b").prose).toBe("Is a < b")
        expect(target.read("Done.</read_file").prose).toBe("Done.</read_file")
    })

    it("shows no card before the opening tag is complete", () => {
        const target = preview()

        const frame = target.read("Hi <read_file")

        expect(frame.prose).toBe("Hi")
        expect(frame.cards()).toEqual([])
    })

    // Whether the turn may call an explicit-only tool is decided when the call
    // settles; a card drawn sooner would show a call the task may refuse.
    it("never previews an explicit-only call", () => {
        const target = preview()

        const frame = target.read("<summarize_task><context>SECRET_SUMMARY</context></summarize_task>")

        expect(frame.prose).toBe("")
        expect(frame.cards()).toEqual([])
    })
})
