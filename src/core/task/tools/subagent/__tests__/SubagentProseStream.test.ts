import { describe, expect, it } from "vitest"
import { SubagentProseStream } from "../SubagentProseStream"

/** Stream `pieces` as a provider would and collect every delta the activity would append. */
function stream(pieces: readonly string[]): string[] {
    const prose = new SubagentProseStream()
    let reply = ""
    return pieces.map((piece) => {
        reply += piece
        return prose.next(reply)
    })
}

describe("SubagentProseStream", () => {
    it("never shows the markup of a call written as XML", () => {
        const deltas = stream(["I will read it.\n<rea", "d_file>\n<path>src/a.ts</pa", "th>\n</read_file>"])

        expect(deltas.join("")).toBe("I will read it.")
        expect(deltas.join("")).not.toContain("<")
    })

    it("releases a held-back tag once it can no longer open a call", () => {
        const deltas = stream(["if a <", " b then"])

        expect(deltas).toEqual(["if a", " < b then"])
    })

    it("resumes the prose that follows a call", () => {
        const deltas = stream(["Reading.", "<list_files>\n<path>.</path>\n</list_files>", "Done."])

        expect(deltas.join("")).toBe("Reading.\n\nDone.")
    })

    it("gives the final prose of a reply without its calls", () => {
        expect(SubagentProseStream.final("Found it.\n<attempt_completion>\n<result>ok</result>\n</attempt_completion>")).toBe(
            "Found it.",
        )
    })
})
