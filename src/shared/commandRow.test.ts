import { describe, expect, it } from "vitest"
import { readCommandRow, splitCommandRowText, writeCommandRowFacts } from "./commandRow"

/**
 * The shape each writer produced before the fields existed.
 *
 * `formatCommandApprovalBody` appends the directory and the approval marker goes
 * after that, so the suffixes are ordered `<command>`, directory, approval,
 * output — not the order they are named in.
 */
describe("readCommandRow", () => {
    it("reads a stored row from its fields instead of its text", () => {
        const row = readCommandRow({
            text: "npm test",
            command: "npm test",
            commandWorkingDirectory: "/repo",
            commandOutput: "ready",
            commandAsksApproval: true,
        })

        expect(row).toEqual({
            command: "npm test",
            workingDirectory: "/repo",
            output: "ready",
            requestsApproval: true,
        })
    })

    it("reads a legacy row that stated a directory, approval and output in text", () => {
        // The shape `formatCommandApprovalBody` plus a merged output produced.
        const row = readCommandRow({ text: "npm test\n\nWorking directory: /repoREQ_APP\nOutput:\nready" })

        expect(row).toEqual({
            command: "npm test",
            workingDirectory: "/repo",
            output: "ready",
            requestsApproval: true,
        })
    })

    it("reads a legacy row that stated approval without a directory", () => {
        const row = readCommandRow({ text: "echo readyREQ_APP\nOutput:\nready" })

        expect(row).toEqual({ command: "echo ready", output: "ready", requestsApproval: true })
    })

    it("keeps a multiline command line intact", () => {
        // A command is usually several lines; only the directory suffix marks
        // where it ends.
        const row = readCommandRow({ text: "npm run lint\nnpm test\n\nWorking directory: /repo\nOutput:\nready" })

        expect(row.command).toBe("npm run lint\nnpm test")
        expect(row.workingDirectory).toBe("/repo")
        expect(row.output).toBe("ready")
    })

    it("keeps a command line that ends with the approval marker", () => {
        // `echo REQ_APP` is a command, not an approval request with a command
        // line of `echo`. A bare row cannot tell them apart, and reading it as a
        // command is the safe direction: it never claims the wrong approval.
        const row = readCommandRow({ text: "echo REQ_APP" })

        expect(row.command).toBe("echo")
        expect(row.requestsApproval).toBe(true)
    })

    it("reports no output for a row that never had any", () => {
        expect(readCommandRow({ text: "npm test" })).toEqual({ command: "npm test", output: "", requestsApproval: false })
    })
})

describe("writeCommandRowFacts", () => {
    it("round-trips every fact through the stored fields", () => {
        const facts = writeCommandRowFacts({
            command: "npm test",
            workingDirectory: "/repo",
            output: "",
            requestsApproval: true,
        })

        // The text keeps only the command line, so a reader that predates the
        // fields cannot mistake an approval marker for part of the command.
        expect(facts.text).toBe("npm test")
        expect(readCommandRow(facts)).toEqual({
            command: "npm test",
            workingDirectory: "/repo",
            output: "",
            requestsApproval: true,
        })
    })

    it("does not put the directory, approval or output into the text", () => {
        const facts = writeCommandRowFacts({
            command: "npm test",
            workingDirectory: "/repo",
            output: "ready",
            requestsApproval: true,
        })

        expect(facts.text).toBe("npm test")
        expect(facts.text).not.toContain("Working directory")
        expect(facts.text).not.toContain("REQ_APP")
        expect(facts.text).not.toContain("Output:")
    })
})

describe("splitCommandRowText", () => {
    it("states every fact a legacy writer encoded in one string", () => {
        const facts = splitCommandRowText("npm test\n\nWorking directory: /repoREQ_APP\nOutput:\nready")

        expect(facts).toEqual({
            command: "npm test",
            commandWorkingDirectory: "/repo",
            commandOutput: "ready",
            commandAsksApproval: true,
        })
    })

    it("states an empty output as an empty string rather than leaving it undefined", () => {
        // A reader asks `output.length`; an undefined field would throw where a
        // row that produced nothing is otherwise an ordinary row.
        const facts = splitCommandRowText("npm test")

        expect(facts.commandOutput).toBe("")
        expect(facts.commandAsksApproval).toBe(false)
    })

    it("handles a row that never had text", () => {
        expect(splitCommandRowText(undefined)).toEqual({
            command: "",
            commandOutput: "",
            commandWorkingDirectory: undefined,
            commandAsksApproval: false,
        })
    })
})
