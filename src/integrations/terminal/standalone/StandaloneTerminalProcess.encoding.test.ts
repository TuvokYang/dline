import assert from "node:assert/strict"
import { describe, it } from "vitest"
import { WINDOWS_POWERSHELL_LEGACY_PATH } from "@/utils/shell"
import { StandaloneTerminal } from "./StandaloneTerminal"
import { StandaloneTerminalProcess } from "./StandaloneTerminalProcess"

/**
 * Regression coverage for BUGFIX-021.
 *
 * On Windows the child shell is spawned with piped stdio, so PowerShell falls back to the
 * system ANSI code page (CP936 on zh-CN machines) instead of UTF-8. Any command that pipes a
 * UTF-8 emitting child process through PowerShell (`... | Select-Object ...`) therefore has its
 * bytes decoded with the wrong code page before Dline ever reads them, producing mojibake such
 * as `鈹佲攣` for `━` and `脳` for `×`.
 */

/** Box-drawing and multiplication signs are what Biome uses for its diagnostic frames. */
const BIOME_STYLE_MARKERS = "━━━ × 中文"

/** Mojibake produced when UTF-8 bytes of the markers above are decoded as CP936. */
const CP936_MOJIBAKE_LEAD = "鈹"

function collectOutput(terminalProcess: StandaloneTerminalProcess): { lines: string[] } {
    const lines: string[] = []
    ;(terminalProcess.on as (...args: unknown[]) => typeof terminalProcess)("line", (line: string) => {
        lines.push(line)
    })
    return { lines }
}

function waitForCompletion(terminalProcess: StandaloneTerminalProcess, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("command did not complete in time")), timeoutMs)
        terminalProcess.once("completed", () => {
            clearTimeout(timer)
            resolve()
        })
    })
}

describe("StandaloneTerminalProcess Windows console encoding", () => {
    it.runIf(process.platform === "win32")(
        "preserves UTF-8 output produced by a child process piped through PowerShell",
        async () => {
            const terminalProcess = new StandaloneTerminalProcess()
            const terminal = new StandaloneTerminal({
                cwd: process.cwd(),
                shellPath: WINDOWS_POWERSHELL_LEGACY_PATH,
            })
            const captured = collectOutput(terminalProcess)

            // `node -e` writes raw UTF-8 bytes, mirroring how biome/tsc emit their diagnostics.
            // Piping through Select-Object forces PowerShell to decode those bytes into a
            // .NET string, which is exactly where the code page mismatch corrupts them.
            const command = `node -e "process.stdout.write('${BIOME_STYLE_MARKERS}\\n')" | Select-Object -First 1`

            try {
                const completion = waitForCompletion(terminalProcess, 30_000)
                await terminalProcess.run(terminal, command)
                await completion
            } finally {
                await terminalProcess.terminate()
            }

            const output = captured.lines.join("\n")
            assert.ok(
                !output.includes(CP936_MOJIBAKE_LEAD),
                `output was decoded with the wrong code page: ${JSON.stringify(output)}`,
            )
            assert.ok(
                output.includes(BIOME_STYLE_MARKERS),
                `expected markers to survive the pipe, got: ${JSON.stringify(output)}`,
            )
        },
        40_000,
    )

    it.runIf(process.platform === "win32")("forces UTF-8 console encoding for PowerShell commands", () => {
        const terminalProcess = new StandaloneTerminalProcess()
        const getShellArgs = (
            terminalProcess as unknown as { getShellArgs(shell: string, command: string): string[] }
        ).getShellArgs.bind(terminalProcess)

        const args = getShellArgs(WINDOWS_POWERSHELL_LEGACY_PATH, "Get-Location")

        assert.equal(args[0], "-Command")
        assert.match(args[1], /\[Console\]::OutputEncoding\s*=/)
        assert.ok(args[1].endsWith("Get-Location"), `user command must stay last, got: ${JSON.stringify(args[1])}`)
    })

    it.runIf(process.platform === "win32")("forces UTF-8 code page for cmd commands", () => {
        const terminalProcess = new StandaloneTerminalProcess()
        const getShellArgs = (
            terminalProcess as unknown as { getShellArgs(shell: string, command: string): string[] }
        ).getShellArgs.bind(terminalProcess)

        const args = getShellArgs("C:\\Windows\\System32\\cmd.exe", "echo ready")

        assert.equal(args[0], "/c")
        assert.match(args[1], /chcp 65001/)
        assert.ok(args[1].endsWith("echo ready"), `user command must stay last, got: ${JSON.stringify(args[1])}`)
    })
})
