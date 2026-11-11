import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Terminal } from "vscode"
import { getLatestTerminalOutput } from "./get-latest-output"

const capture = vi.hoisted(() => ({
    terminal: {} as Terminal,
    active: undefined as Terminal | undefined,
    clipboard: "",
    output: "",
    focus: "composer",
    calls: [] as string[],
}))

vi.mock("@utils/env", () => ({
    readTextFromClipboard: async () => capture.clipboard,
    writeTextToClipboard: async (text: string) => {
        capture.clipboard = text
    },
}))

vi.mock("vscode", () => ({
    window: {
        get activeTerminal() {
            return capture.active
        },
    },
    commands: {
        executeCommand: async (command: string) => {
            capture.calls.push(command)
            // VS Code's xterm selectAll focuses the terminal before selecting.
            if (command === "workbench.action.terminal.selectAll") capture.focus = "terminal"
            if (
                command === "workbench.action.terminal.copySelection" ||
                command === "workbench.action.terminal.copyLastCommandOutput"
            ) {
                capture.clipboard = capture.output
            }
        },
    },
}))

describe("terminal output capture", () => {
    beforeEach(() => {
        capture.active = capture.terminal
        capture.clipboard = "user clipboard"
        capture.output = "first output\nsecond output\nfinal output"
        capture.focus = "composer"
        capture.calls = []
    })

    it("reads completed command output without moving keyboard focus or discarding its last line", async () => {
        const output = await getLatestTerminalOutput({ terminal: capture.terminal, scope: "command" })

        expect(output).toBe("first output\nsecond output\nfinal output")
        expect(capture.focus).toBe("composer")
        expect(capture.clipboard).toBe("user clipboard")
        expect(capture.calls).toEqual(["workbench.action.terminal.copyLastCommandOutput"])
    })

    it("keeps whole-buffer capture available for explicit terminal references", async () => {
        const output = await getLatestTerminalOutput({ terminal: capture.terminal, wholeBuffer: true })

        expect(output).toBe("first output\nsecond output\nfinal output")
        expect(capture.clipboard).toBe("user clipboard")
        expect(capture.calls).toEqual([
            "workbench.action.terminal.selectAll",
            "workbench.action.terminal.copySelection",
            "workbench.action.terminal.clearSelection",
        ])
    })

    it("does not copy another active terminal's output", async () => {
        capture.active = {} as Terminal

        expect(await getLatestTerminalOutput({ terminal: capture.terminal, scope: "command" })).toBe("")
        expect(capture.focus).toBe("composer")
        expect(capture.clipboard).toBe("user clipboard")
        expect(capture.calls).toEqual([])
    })
})
