import { describe, expect, it } from "vitest"
import { commandResultForModel } from "../ExecuteCommandToolHandler"

describe("ExecuteCommandToolHandler model result", () => {
    it("removes stdout only from a muted successful completion", () => {
        const result = commandResultForModel(
            {
                userRejected: false,
                result: "Command executed successfully (exit code 0).\nlarge stdout",
                completed: true,
                exitCode: 0,
                signal: null,
            },
            true,
        )

        expect(result).toBe("Command executed successfully (exit code 0).")
    })

    it.each([
        ["failed", { completed: true, exitCode: 7, signal: null }],
        ["signalled", { completed: true, exitCode: 0, signal: "SIGINT" as const }],
        ["timed out", { completed: false, exitCode: undefined, signal: null, timedOut: true }],
        ["still running", { completed: false, exitCode: undefined, signal: null }],
        ["cancelled", { completed: false, exitCode: undefined, signal: null, userRejected: true }],
    ])("preserves %s diagnostics", (_name, state) => {
        const result = commandResultForModel(
            {
                userRejected: false,
                result: "diagnostic output",
                ...state,
            },
            true,
        )

        expect(result).toBe("diagnostic output")
    })

    it("preserves successful stdout when muting is disabled", () => {
        const result = commandResultForModel(
            {
                userRejected: false,
                result: "Command executed successfully (exit code 0).\nneeded stdout",
                completed: true,
                exitCode: 0,
                signal: null,
            },
            false,
        )

        expect(result).toContain("needed stdout")
    })
})
