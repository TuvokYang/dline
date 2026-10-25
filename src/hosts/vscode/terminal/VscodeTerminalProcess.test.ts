// @ts-nocheck — should library type issues
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import "should"
// sinon import removed
import * as vscode from "vscode"
import { VscodeTerminalProcess } from "./VscodeTerminalProcess"
import { TerminalRegistry } from "./VscodeTerminalRegistry"

const getLatestTerminalOutput = vi.hoisted(() => vi.fn<() => Promise<string | undefined>>())

vi.mock("@/hosts/vscode/terminal/get-latest-output", () => ({ getLatestTerminalOutput }))

declare module "vscode" {
    // https://github.com/microsoft/vscode/blob/f0417069c62e20f3667506f4b7e53ca0004b4e3e/src/vscode-dts/vscode.d.ts#L7442
    interface Terminal {
        shellIntegration?: {
            cwd?: vscode.Uri
            executeCommand?: (command: string) => {
                read: () => AsyncIterable<string>
            }
        }
    }
}

// Create a mock stream for simulating terminal output - this is only used for tests
// that need controlled output which can't be guaranteed with real terminals
function createMockStream(lines: string[] = ["test-command", "line1", "line2", "line3"]) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const line of lines) {
                yield `${line}\n`
            }
        },
    }
}

describe("TerminalProcess (Integration Tests)", () => {
    let process: VscodeTerminalProcess
    let createdTerminals: vscode.Terminal[] = []

    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        setVscodeHostProviderMock()
        getLatestTerminalOutput.mockReset()
        getLatestTerminalOutput.mockResolvedValue(undefined)
        process = new VscodeTerminalProcess()
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
        // Remove any event listeners left on the TerminalProcess
        process.removeAllListeners()
        // Dispose all terminals created during the test
        createdTerminals.forEach((t) => {
            t.dispose()
        })
        createdTerminals = []
    })

    describe("Real terminal tests", () => {
        // This test works with or without shell integration
        it("should create and run a command in a real terminal", async () => {
            // Create a real VS Code terminal for testing
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)

            // Spy on emit to verify behavior
            const emitSpy = vi.spyOn(process, "emit")

            // Run a simple command
            const runPromise = process.run(terminal, "echo test")

            // If terminal doesn't have shell integration, advance timer
            if (!terminal.shellIntegration) {
                await vi.advanceTimersByTimeAsync(3000)
            }

            await runPromise

            // Verify that the continue event was emitted
            expect(emitSpy).toHaveBeenCalledWith("continue")
            expect(emitSpy).toHaveBeenCalledWith("completed", expect.any(Object))
        })

        it("should execute and capture events from a simple command", async () => {
            // Create a real VS Code terminal
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)

            // Spy on emit to verify line events
            const emitSpy = vi.spyOn(process, "emit")

            // Run a command that produces predictable output
            const runPromise = process.run(terminal, "echo 'Line 1' && echo 'Line 2'")

            // If terminal doesn't have shell integration, advance timer
            if (!terminal.shellIntegration) {
                await vi.advanceTimersByTimeAsync(3000)
            }

            await runPromise

            // Check that the events were emitted
            expect(emitSpy).toHaveBeenCalledWith("completed", expect.any(Object))
            expect(emitSpy).toHaveBeenCalledWith("continue")
        })

        it("should execute a command that lists files", async () => {
            // Create a real VS Code terminal
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)

            // Spy on emit to verify behavior
            const emitSpy = vi.spyOn(process, "emit")

            // Run a command that lists files
            const runPromise = process.run(terminal, "ls -la")

            // If terminal doesn't have shell integration, advance timer
            if (!terminal.shellIntegration) {
                await vi.advanceTimersByTimeAsync(3000)
            }

            await runPromise

            // Verify that the continue event was emitted
            expect(emitSpy).toHaveBeenCalledWith("continue")
            expect(emitSpy).toHaveBeenCalledWith("completed", expect.any(Object))
        })

        it("should handle a longer running command", async () => {
            // Create a real terminal
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)

            // Spy on emit to verify behavior
            const emitSpy = vi.spyOn(process, "emit")

            // Un-fake timers temporarily for this test since we need real timing
            vi.useRealTimers()

            // Run a command that sleeps for a short period
            await process.run(terminal, "sleep 0.5 && echo 'Done sleeping'")

            // Verify that the continue and completed events were emitted
            expect(emitSpy).toHaveBeenCalledWith("continue")
            expect(emitSpy).toHaveBeenCalledWith("completed", expect.any(Object))

            // Restore fake timers for other tests
            vi.useFakeTimers({ shouldAdvanceTime: true })
        })

        it("should execute a command with arguments", async () => {
            // Create a real VS Code terminal
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)

            // Spy on emit to verify line events
            const emitSpy = vi.spyOn(process, "emit")

            // Run a command that produces predictable output
            const runPromise = process.run(terminal, "echo 'Line 1' 'Line 2'")

            // If terminal doesn't have shell integration, advance timer
            if (!terminal.shellIntegration) {
                await vi.advanceTimersByTimeAsync(3000)
            }

            await runPromise

            // Check that the events were emitted
            expect(emitSpy).toHaveBeenCalledWith("completed", expect.any(Object))
            expect(emitSpy).toHaveBeenCalledWith("continue")
        })

        it("should execute a command with quotes", async () => {
            // Create a real VS Code terminal
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)

            // Spy on emit to verify line events
            const emitSpy = vi.spyOn(process, "emit")

            // Run a command that produces predictable output
            const runPromise = process.run(terminal, "echo \"Line 1\" && echo 'Line 2'")

            // If terminal doesn't have shell integration, advance timer
            if (!terminal.shellIntegration) {
                await vi.advanceTimersByTimeAsync(3000)
            }

            await runPromise

            // Check that the events were emitted
            expect(emitSpy).toHaveBeenCalledWith("completed", expect.any(Object))
            expect(emitSpy).toHaveBeenCalledWith("continue")
        })
    })

    // Test that specifically checks for no shell integration
    it("should handle terminals without shell integration", async () => {
        // Create a real terminal without explicitly providing shell integration
        const terminal = vscode.window.createTerminal({ name: "Test Terminal" })
        createdTerminals.push(terminal)

        // Stub the shellIntegration getter to return undefined for this test
        vi.spyOn(terminal, "shellIntegration", "get").mockReturnValue(undefined)

        // Stub the sendText method to verify it's called
        const sendTextStub = vi.spyOn(terminal, "sendText")

        // Spy on the emit function to verify events
        const emitSpy = vi.spyOn(process, "emit")

        // Run the command - this returns a promise
        const runPromise = process.run(terminal, "test-command")

        // Advance the fake timer by 3 seconds to trigger the setTimeout
        await vi.advanceTimersByTimeAsync(3000)

        // Now wait for the promise to resolve
        await runPromise

        // Check that the correct methods were called and events emitted
        expect(sendTextStub).toHaveBeenCalledWith("test-command", true)
        expect(emitSpy).toHaveBeenCalledWith("completed", expect.any(Object))
        expect(emitSpy).toHaveBeenCalledWith("continue")

        // Capability failure must be published before completion so the manager invalidates the lease first.
        expect(emitSpy).toHaveBeenCalledWith("no_shell_integration")
        const noShellOrder =
            emitSpy.mock.invocationCallOrder[emitSpy.mock.calls.findIndex(([event]) => event === "no_shell_integration")]
        const completedOrder = emitSpy.mock.invocationCallOrder[emitSpy.mock.calls.findIndex(([event]) => event === "completed")]
        expect(noShellOrder).toBeLessThan(completedOrder)
        expect(getLatestTerminalOutput).toHaveBeenCalledTimes(1)
    })

    it("emits a fallback terminal snapshot as individual lines", async () => {
        const terminal = vscode.window.createTerminal({ name: "Fallback Terminal" })
        createdTerminals.push(terminal)
        vi.spyOn(terminal, "shellIntegration", "get").mockReturnValue(undefined)
        getLatestTerminalOutput.mockResolvedValue("prompt> command\r\nfirst\r\nsecond")
        const lines: string[] = []
        process.on("line", (line) => lines.push(line))

        const runPromise = process.run(terminal, "command")
        await vi.advanceTimersByTimeAsync(3000)
        await runPromise

        expect(getLatestTerminalOutput).toHaveBeenCalledTimes(1)
        expect(lines).toEqual([
            "The command's output could not be captured due to some technical issue, however it has been executed successfully. Here's the current terminal's content to help you get the command's output:",
            "",
            "prompt> command",
            "first",
            "second",
        ])
    })

    // The following tests require shell integration and controlled terminal output
    describe("Shell integration tests", () => {
        // We'll mock the terminal run process and TerminalProcess for these tests
        it("should emit completed and continue events when command finishes", async () => {
            // Create a terminal to ensure proper interface, but we'll use mocking under the hood
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)

            // Create a mock implementation of executeCommand
            const mockExecuteCommand = vi.fn().mockReturnValue({
                read: () => createMockStream(["echo test", "test output"]),
            })

            // Create a fake shell integration object
            const mockShellIntegration = {
                executeCommand: mockExecuteCommand,
            }

            // Stub terminal.shellIntegration to return our mock
            vi.spyOn(terminal, "shellIntegration", "get").mockReturnValue(mockShellIntegration)

            // Spy on emit to verify behavior
            const emitSpy = vi.spyOn(process, "emit")

            // Run the command
            await process.run(terminal, "echo test")

            // Verify the executeCommand was called with the right command
            expect(mockExecuteCommand).toHaveBeenCalledWith("echo test")

            // Check that the events were emitted
            expect(emitSpy).toHaveBeenCalledWith("completed", expect.any(Object))
            expect(emitSpy).toHaveBeenCalledWith("continue")
        })

        it("should wait briefly for terminal-end completion details", async () => {
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)
            vi.spyOn(terminal, "shellIntegration", "get").mockReturnValue({
                executeCommand: vi.fn().mockReturnValue({
                    read: () => createMockStream(["echo test", "test output"]),
                }),
            })

            let completedDetails: unknown
            process.once("completed", (details) => {
                completedDetails = details
            })

            const runPromise = process.run(terminal, "echo test")
            setTimeout(() => process.setCompletionDetails({ exitCode: 7 }), 25)
            await vi.advanceTimersByTimeAsync(25)
            await runPromise

            expect(completedDetails).toEqual({ exitCode: 7, signal: null })
        })

        it("should complete on an internal marker without waiting for shell stream closure", async () => {
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)
            const marker = "__DLINE_INTERNAL_COMMAND_EXIT__test-token:7"
            const decoratedMarker = `\x1b[?7l\x1b]0;PowerShell\\${marker}\x1b[?7h`
            vi.spyOn(terminal, "shellIntegration", "get").mockReturnValue({
                executeCommand: vi.fn().mockReturnValue({
                    read: () => ({
                        async *[Symbol.asyncIterator]() {
                            yield "echo test\n"
                            yield "visible output\n"
                            yield `${decoratedMarker}\n`
                            throw new Error("shell stream was read after the internal completion marker")
                        },
                    }),
                }),
            })
            const lines: string[] = []
            let completedDetails: unknown
            process.on("line", (line) => lines.push(line))
            process.once("completed", (details) => {
                completedDetails = details
            })

            const runPromise = process.run(terminal, "echo test")
            await vi.advanceTimersByTimeAsync(1000)
            await expect(runPromise).resolves.toBeUndefined()

            expect(completedDetails).toEqual({ exitCode: 7, signal: null })
            expect(lines).toContain("visible output")
            expect(lines).not.toContain(marker)
            expect(process.getUnretrievedOutput()).not.toContain(marker)
        })

        it("should remove internal completion commands and markers from the terminal snapshot fallback", async () => {
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)
            const token = "fdaa9665-cc3c-48f7-a39f-146197198acb"
            vi.spyOn(terminal, "shellIntegration", "get").mockReturnValue({
                executeCommand: vi.fn().mockReturnValue({
                    read: () => createMockStream([]),
                }),
            })
            getLatestTerminalOutput.mockResolvedValue(
                [
                    `runner$ node command; printf '__DLINE_INTERNAL_COMMAND_EXIT__${token}:%s\\n' "$__dline_exit"`,
                    "WORK_DAILY_COMMAND_START",
                    "WORK_DAILY_COMMAND_END",
                    `__DLINE_INTERNAL_COMMAND_EXIT__${token}:0`,
                ].join("\n"),
            )
            const lines: string[] = []
            process.on("line", (line) => lines.push(line))

            const runPromise = process.run(terminal, "node command")
            await vi.advanceTimersByTimeAsync(100)
            await runPromise

            expect(lines).toContain("WORK_DAILY_COMMAND_START")
            expect(lines).toContain("WORK_DAILY_COMMAND_END")
            expect(lines.join("\n")).not.toContain("__DLINE_INTERNAL_COMMAND_EXIT__")
            expect(lines.join("\n")).not.toContain("printf")
        })

        it("should complete when terminal-end details arrive before the shell stream closes", async () => {
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)
            let resolvePendingRead: ((result: IteratorResult<string>) => void) | undefined
            let readCount = 0
            const streamIterator = {
                next: vi.fn(() => {
                    readCount++
                    if (readCount === 1) return Promise.resolve({ done: false as const, value: "visible output\n" })
                    return new Promise<IteratorResult<string>>((resolve) => {
                        resolvePendingRead = resolve
                    })
                }),
                return: vi.fn(async () => {
                    resolvePendingRead?.({ done: true, value: undefined })
                    return { done: true as const, value: undefined }
                }),
            }
            vi.spyOn(terminal, "shellIntegration", "get").mockReturnValue({
                executeCommand: vi.fn().mockReturnValue({
                    read: () => ({
                        [Symbol.asyncIterator]: () => streamIterator,
                    }),
                }),
            })
            const lines: string[] = []
            let completedDetails: unknown
            process.on("line", (line) => lines.push(line))
            process.once("completed", (details) => {
                completedDetails = details
            })

            const runPromise = process.run(terminal, "echo test")
            await vi.waitFor(() => expect(streamIterator.next).toHaveBeenCalledTimes(2))
            process.setCompletionDetails({ exitCode: 0 })
            await expect(runPromise).resolves.toBeUndefined()

            expect(streamIterator.return).toHaveBeenCalledTimes(1)
            expect(completedDetails).toEqual({ exitCode: 0, signal: null })
            expect(lines).toContain("visible output")
        })
    })

    // Tests with controlled output
    describe("Controlled output tests", () => {
        it("should emit line events for each line of output", async () => {
            // Create a terminal
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)

            // Mock the shell integration with controlled output
            const mockExecuteCommand = vi.fn().mockReturnValue({
                read: () => createMockStream(["test-command", "line1", "line2", "line3"]),
            })

            // Create a mock shell integration object and stub the getter
            vi.spyOn(terminal, "shellIntegration", "get").mockReturnValue({
                executeCommand: mockExecuteCommand,
            })

            const emitSpy = vi.spyOn(process, "emit")

            await process.run(terminal, "test-command")

            // Check that line events were emitted for each line
            expect(emitSpy).toHaveBeenCalledWith("line", "line1", "combined")
            expect(emitSpy).toHaveBeenCalledWith("line", "line2", "combined")
            expect(emitSpy).toHaveBeenCalledWith("line", "line3", "combined")
        })

        it("should properly handle process hot state (e.g. compiling)", async () => {
            // Create a terminal
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)

            // Mock the shell integration
            const mockExecuteCommand = vi.fn().mockReturnValue({
                read: () => createMockStream(["compiling..."]),
            })

            // Create a mock shell integration object and stub the getter
            vi.spyOn(terminal, "shellIntegration", "get").mockReturnValue({
                executeCommand: mockExecuteCommand,
            })

            // Spy on global setTimeout
            const setTimeoutSpy = vi.spyOn(global, "setTimeout")

            await process.run(terminal, "build command")

            // Move time forward enough to schedule
            vi.advanceTimersByTime(100)

            // Expect a 15-second (>= 10000ms) hot timeout, since it saw "compiling"
            const foundCompilingTimeout = (setTimeoutSpy as any).mock.calls.filter((args: any) => args[1] && args[1] >= 10000)
            foundCompilingTimeout.length.should.be.greaterThan(0)
        })

        it("should handle standard commands with normal hot timeout", async () => {
            // Create a terminal
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)

            // Mock the shell integration
            const mockExecuteCommand = vi.fn().mockReturnValue({
                read: () => createMockStream(["some normal output"]),
            })

            // Create a mock shell integration object and stub the getter
            vi.spyOn(terminal, "shellIntegration", "get").mockReturnValue({
                executeCommand: mockExecuteCommand,
            })

            const setTimeoutSpy = vi.spyOn(global, "setTimeout")

            await process.run(terminal, "standard command")
            vi.advanceTimersByTime(100)

            // Expect a short hot timeout (<= 5000)
            const foundNormalTimeout = (setTimeoutSpy as any).mock.calls.filter((args: any) => args[1] && args[1] <= 5000)
            foundNormalTimeout.length.should.be.greaterThan(0)

            // Also check that "completed" eventually emits
            const emitSpy = vi.spyOn(process, "emit")
            await process.run(terminal, "another command")
            expect(emitSpy).toHaveBeenCalledWith("completed", expect.any(Object))
        })

        it("should correctly filter command echoes based on current implementation", async () => {
            // Create a terminal
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)

            // Mock the shell integration
            const mockExecuteCommand = vi.fn().mockReturnValue({
                read: () =>
                    createMockStream([
                        "test-command", // This should be filtered (command contains this exactly)
                        "test command", // This should NOT be filtered (doesn't match exactly)
                        "other output",
                    ]),
            })

            // Create a mock shell integration object and stub the getter
            vi.spyOn(terminal, "shellIntegration", "get").mockReturnValue({
                executeCommand: mockExecuteCommand,
            })

            const emitSpy = vi.spyOn(process, "emit")

            await process.run(terminal, "test-command")

            // Check that "test-command" was filtered out but "test command" was not
            expect(emitSpy).toHaveBeenCalledWith("line", "test command", "combined")
            expect(emitSpy).toHaveBeenCalledWith("line", "other output", "combined")
            // This should never be called because it should be filtered
            expect(emitSpy).not.toHaveBeenCalledWith("line", "test-command", "combined")
        })

        it("should preserve output that is only a substring of the submitted command", async () => {
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)
            const command = 'Write-Output "E2E_VSCODE_POWERSHELL_OK"; Write-Output "done"'
            vi.spyOn(terminal, "shellIntegration", "get").mockReturnValue({
                executeCommand: vi.fn().mockReturnValue({
                    read: () => createMockStream(["E2E_VSCODE_POWERSHELL_OK", "done"]),
                }),
            })
            const lines: string[] = []
            process.on("line", (line) => lines.push(line))

            await process.run(terminal, command)

            expect(lines).toContain("E2E_VSCODE_POWERSHELL_OK")
            expect(lines).toContain("done")
        })

        it("should handle npm run commands", async () => {
            // Create a terminal
            const terminal = TerminalRegistry.createTerminal().terminal
            createdTerminals.push(terminal)

            // Mock the shell integration
            const mockExecuteCommand = vi.fn().mockReturnValue({
                read: () => createMockStream(["npm run build", "> project@1.0.0 build", "> tsc", "files built successfully"]),
            })

            // Create a mock shell integration object and stub the getter
            vi.spyOn(terminal, "shellIntegration", "get").mockReturnValue({
                executeCommand: mockExecuteCommand,
            })

            const emitSpy = vi.spyOn(process, "emit")

            await process.run(terminal, "npm run build")

            // The "npm run build" line should be filtered, but the rest should be emitted
            expect(emitSpy).toHaveBeenCalledWith("line", "> project@1.0.0 build", "combined")
            expect(emitSpy).toHaveBeenCalledWith("line", "> tsc", "combined")
            expect(emitSpy).toHaveBeenCalledWith("line", "files built successfully", "combined")
        })
    })

    // The following tests are shared with the unit tests to ensure consistent behavior
    it("should emit line for remaining buffer when emitRemainingBufferIfListening is called", () => {
        // Access private properties via type assertion
        const processAny = process as any
        processAny.buffer = "test buffer content"
        processAny.isListening = true

        const emitSpy = vi.spyOn(process, "emit")
        processAny.emitRemainingBufferIfListening()
        expect(emitSpy).toHaveBeenCalledWith("line", "test buffer content", "combined")
        processAny.buffer.should.equal("")
    })

    it("should gate shell integration reads until output capacity resumes", async () => {
        process.pauseOutput()
        let released = false
        const waiting = (process as unknown as { waitForOutputCapacity(): Promise<void> }).waitForOutputCapacity().then(() => {
            released = true
        })

        await Promise.resolve()
        expect(released).toBe(false)
        process.resumeOutput()
        await waiting
        expect(released).toBe(true)
    })

    it("should keep emitting output after foreground waiting is released", () => {
        const processAny = process as any
        const lineListener = vi.fn()
        process.on("line", lineListener)

        process.continue()
        processAny.emitIfEol("background output\n")

        expect(lineListener).toHaveBeenCalledWith("background output", "combined")
    })

    it("should dispose the integrated terminal when Ctrl+C does not complete the command", async () => {
        const terminal = TerminalRegistry.createTerminal().terminal
        createdTerminals.push(terminal)
        const sendText = vi.spyOn(terminal, "sendText")
        const dispose = vi.spyOn(terminal, "dispose")
        ;(process as any).terminal = terminal

        const termination = process.terminate()
        expect(sendText).toHaveBeenCalledWith("\u0003", false)
        expect(dispose).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(1000)
        await termination

        expect(dispose).toHaveBeenCalledTimes(1)
        expect(process.getCompletionDetails().signal).toBe("SIGINT")
    })

    it("should latch cancellation while waiting for shell integration and never start later", async () => {
        const terminal = TerminalRegistry.createTerminal().terminal
        createdTerminals.push(terminal)
        const executeCommand = vi.fn().mockReturnValue({ read: () => createMockStream([]) })
        vi.spyOn(terminal, "shellIntegration", "get").mockReturnValue({ executeCommand })
        const completed = vi.fn()
        const continued = vi.fn()
        process.on("completed", completed)
        process.on("continue", continued)
        let startedAt: number | undefined
        void process.started.then((value) => {
            startedAt = value
        })

        await process.terminate()
        await Promise.resolve()
        expect(completed).toHaveBeenCalledTimes(1)
        expect(continued).toHaveBeenCalledTimes(1)
        expect(startedAt).toEqual(expect.any(Number))
        expect(process.waitForShellIntegration).toBe(false)
        expect(process.getCompletionDetails().signal).toBe("SIGINT")

        await process.run(terminal, "must-not-run")

        expect(completed).toHaveBeenCalledTimes(1)
        expect(continued).toHaveBeenCalledTimes(1)
        expect(executeCommand).not.toHaveBeenCalled()
    })

    it("should remove prompt characters from the last line of output", () => {
        const processAny = process as any

        processAny.removeLastLineArtifacts("line 1\nline 2 %").should.equal("line 1\nline 2")
        processAny.removeLastLineArtifacts("line 1\nline 2 $").should.equal("line 1\nline 2")
        processAny.removeLastLineArtifacts("line 1\nline 2 #").should.equal("line 1\nline 2")
        processAny.removeLastLineArtifacts("line 1\nline 2 >").should.equal("line 1\nline 2")
    })

    it("should process buffer and emit lines when newline characters are found", () => {
        const processAny = process as any
        const emitSpy = vi.spyOn(process, "emit")

        processAny.emitIfEol("line 1\nline 2\nline 3")
        expect(emitSpy).toHaveBeenCalledWith("line", "line 1", "combined")
        expect(emitSpy).toHaveBeenCalledWith("line", "line 2", "combined")
        processAny.buffer.should.equal("line 3")

        processAny.emitIfEol(" continued\n")
        expect(emitSpy).toHaveBeenCalledWith("line", "line 3 continued", "combined")
        processAny.buffer.should.equal("")
    })

    // =========================================================================
    // Encoding tests — verify UTF-8, ANSI, and CJK preservation
    // =========================================================================
    describe("Encoding & Unicode preservation", () => {
        it("should preserve CJK characters in removeLastLineArtifacts", () => {
            const processAny = process as any
            const input = "line 1\n文件路径: C:\\用户\\测试.txt"
            processAny.removeLastLineArtifacts(input).should.equal(input)
        })

        it("should preserve CJK in removeLastLineArtifacts with prompt chars", () => {
            const processAny = process as any
            // % is a trailing prompt char and will be removed by removeLastLineArtifacts
            processAny.removeLastLineArtifacts("line1\n成功率: 95%").should.equal("line1\n成功率: 95")
        })

        it("should not corrupt emoji in removeLastLineArtifacts", () => {
            const processAny = process as any
            const input = "Build ✅\nTests ✅✅"
            processAny.removeLastLineArtifacts(input).should.equal(input)
        })

        it("should emit CJK lines correctly through emitIfEol", () => {
            const processAny = process as any
            const emitSpy = vi.spyOn(process, "emit")
            processAny.buffer = ""

            processAny.emitIfEol("中文测试\n日本語テスト\n")
            expect(emitSpy).toHaveBeenCalledWith("line", "中文测试", "combined")
            expect(emitSpy).toHaveBeenCalledWith("line", "日本語テスト", "combined")
        })

        it("should preserve ANSI escape sequences in emitIfEol", () => {
            const processAny = process as any
            const emitSpy = vi.spyOn(process, "emit")
            processAny.buffer = ""

            const lineWithAnsi = "\x1b[32mGREEN\x1b[0m text"
            processAny.emitIfEol(`${lineWithAnsi}\n`)
            expect(emitSpy).toHaveBeenCalledWith("line", lineWithAnsi, "combined")
        })

        it("should preserve mixed ANSI + CJK in emitIfEol", () => {
            const processAny = process as any
            const emitSpy = vi.spyOn(process, "emit")
            processAny.buffer = ""

            const line = "\x1b[32m✓ 成功\x1b[0m \x1b[31m✗ 失败\x1b[0m"
            processAny.emitIfEol(`${line}\n`)
            expect(emitSpy).toHaveBeenCalledWith("line", line, "combined")
        })
    })
})
