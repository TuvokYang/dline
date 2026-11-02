import { describe, expect, it } from "vitest"
import { combineCommandSequences } from "./combineCommandSequences"
import { readCommandRow } from "./commandRow"
import type { UiMessage } from "./ExtensionMessage"

function commandRow(overrides: Partial<UiMessage> = {}): UiMessage {
    return { ts: 10, type: "ask", ask: "command", text: "npm test", ...overrides }
}

function output(overrides: Partial<UiMessage> = {}): UiMessage {
    return { ts: 11, type: "say", say: "command_output", text: "ready", commandTs: 10, ...overrides }
}

describe("combineCommandSequences", () => {
    it("attaches the output to the field that owns it and leaves the command line alone", () => {
        const combined = combineCommandSequences([commandRow(), output()])

        expect(combined).toHaveLength(1)
        expect(combined[0].text).toBe("npm test")
        expect(readCommandRow(combined[0])).toEqual({
            command: "npm test",
            workingDirectory: undefined,
            output: "ready",
            requestsApproval: false,
        })
    })

    it("joins several outputs in arrival order", () => {
        const combined = combineCommandSequences([
            commandRow(),
            output({ ts: 11, text: "first" }),
            output({ ts: 12, text: "second" }),
        ])

        expect(readCommandRow(combined[0]).output).toBe("first\nsecond")
    })

    it("keeps the approval state a command ask already stated", () => {
        // An approval row states its facts as fields; merging the output must not
        // drop the approval flag, because the card renders its notice from it.
        const approval = commandRow({ command: "npm test", commandWorkingDirectory: "/repo", commandAsksApproval: true })

        const combined = combineCommandSequences([approval, output()])

        expect(readCommandRow(combined[0])).toEqual({
            command: "npm test",
            workingDirectory: "/repo",
            output: "ready",
            requestsApproval: true,
        })
        expect(combined[0].commandAsksApproval).toBe(true)
    })

    it("appends to output the command row already carried", () => {
        // A row restored with its own output must not lose it when a later
        // command_output arrives for the same call.
        const withOutput = commandRow({ command: "npm test", commandOutput: "already there" })

        const combined = combineCommandSequences([withOutput, output()])

        expect(readCommandRow(combined[0]).output).toBe("already there\nready")
    })

    it("reads a legacy command row's facts before merging into them", () => {
        // The row states everything in one string; the merge must split it first,
        // or the directory and approval would be read as part of the command.
        const legacy = commandRow({ text: "npm test\n\nWorking directory: /repoREQ_APP" })

        const combined = combineCommandSequences([legacy, output()])

        expect(readCommandRow(combined[0])).toEqual({
            command: "npm test",
            workingDirectory: "/repo",
            output: "ready",
            requestsApproval: true,
        })
    })

    it("leaves a legacy row's original text in place as the evidence of its encoding", () => {
        // The split is the reader's best interpretation, and a command that ends
        // with the marker cannot be told apart from an approval request. Rewriting
        // the text with that interpretation would destroy the only record of what
        // was actually stored, so the fields carry the reading and the text stays.
        const legacyText = "npm test\n\nWorking directory: /repoREQ_APP"

        const combined = combineCommandSequences([commandRow({ text: legacyText }), output()])

        expect(combined[0].text).toBe(legacyText)
    })

    it("leaves a command with no output untouched and still drops nothing", () => {
        const follower: UiMessage = { ts: 12, type: "say", say: "text", text: "after" }

        const combined = combineCommandSequences([commandRow(), follower])

        expect(combined).toEqual([commandRow(), follower])
    })

    it("does not attach an output to the wrong command", () => {
        const other = commandRow({ ts: 20, text: "npm run build" })

        const combined = combineCommandSequences([commandRow(), other, output({ commandTs: 20, text: "built" })])

        expect(readCommandRow(combined[0]).output).toBe("")
        expect(readCommandRow(combined[1]).output).toBe("built")
    })
})
