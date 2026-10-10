import { describe, expect, it } from "vitest"
import { isCommandCompletionSuccessful } from "../command-completion"
import type { TerminalCompletionDetails } from "../types"

describe("command completion classification", () => {
    it.each<readonly [string, TerminalCompletionDetails | undefined, boolean]>([
        ["explicit zero exit without a signal", { exitCode: 0, signal: null }, true],
        ["non-zero exit", { exitCode: 2, signal: null }, false],
        ["termination signal", { exitCode: 0, signal: "SIGTERM" }, false],
        ["undefined exit code", { exitCode: undefined, signal: null }, false],
        ["null exit code", { exitCode: null, signal: null }, false],
        ["missing completion details", undefined, false],
    ])("classifies %s", (_caseName, details, expected) => {
        expect(isCommandCompletionSuccessful(details)).toBe(expected)
    })
})
