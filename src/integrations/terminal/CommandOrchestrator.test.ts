import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { DlineRuntimeFileManager } from "@services/runtime-files"
import { EventEmitter } from "events"
import { afterEach, describe, it, vi } from "vitest"
import { Logger } from "@/shared/services/Logger"
import { orchestrateCommandExecution } from "./CommandOrchestrator"
import { EXPLICIT_BACKGROUND_START_WINDOW_MS } from "./constants"
import type {
    CommandExecutorCallbacks,
    ITerminalManager,
    ITerminalProcess,
    OrchestrationResult,
    TerminalCompletionDetails,
    TerminalOutputLine,
    TerminalProcessEvents,
    TerminalProcessResultPromise,
} from "./types"

class FakeTerminalProcess extends EventEmitter<TerminalProcessEvents> implements ITerminalProcess {
    isHot = false
    waitForShellIntegration = false
    readonly terminate = vi.fn(async () => undefined)
    readonly pauseOutput = vi.fn()
    readonly resumeOutput = vi.fn()
    readonly started: Promise<number>
    private readonly promise: Promise<void>
    private resolvePromise!: () => void
    private rejectPromise!: (error: Error) => void
    private resolveStarted!: (startedAt: number) => void

    constructor(deferStart = false) {
        super()
        this.started = new Promise<number>((resolve) => {
            this.resolveStarted = resolve
        })
        this.promise = new Promise<void>((resolve, reject) => {
            this.resolvePromise = resolve
            this.rejectPromise = reject
        })
        if (!deferStart) this.markStarted()
    }

    markStarted(): void {
        this.resolveStarted(Date.now())
    }

    continue(): void {
        this.emit("continue")
        this.resolvePromise()
    }

    getUnretrievedOutput(): string {
        return ""
    }

    getCompletionDetails(): TerminalCompletionDetails {
        return {}
    }

    emitOutput(line: string, stream: "stdout" | "stderr" | "combined"): void {
        this.emit("line", line, stream)
    }

    complete(details?: TerminalCompletionDetails): void {
        this.emit("completed", details)
        this.emit("continue")
        this.resolvePromise()
    }

    fail(error: Error): void {
        this.emit("error", error)
        this.rejectPromise(error)
    }

    asResultPromise(): TerminalProcessResultPromise {
        const processWithPromise = this as unknown as FakeTerminalProcess & Partial<TerminalProcessResultPromise>
        processWithPromise.then = this.promise.then.bind(this.promise)
        processWithPromise.catch = this.promise.catch.bind(this.promise)
        processWithPromise.finally = this.promise.finally.bind(this.promise)
        return processWithPromise as TerminalProcessResultPromise
    }
}

function createCallbacks(messages: Array<Record<string, unknown>> = []): CommandExecutorCallbacks {
    return {
        say: async () => undefined,
        ask: async () => ({ response: "messageResponse" }),
        updateBackgroundCommandState: () => {},
        updateClineMessage: async (index, updates) => {
            Object.assign(messages[index], updates)
        },
        getClineMessages: () => messages,
        addToUserMessageContent: () => {},
    }
}

function createTerminalManager(outputLineLimit = 500): ITerminalManager {
    return {
        getConfiguration: () => ({
            shellIntegrationTimeout: 4000,
            terminalReuseEnabled: true,
            terminalOutputLineLimit: outputLineLimit,
            defaultTerminalProfile: "default",
        }),
        processOutput: (outputLines: string[]) => outputLines.join("\n"),
    } as ITerminalManager
}

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe("CommandOrchestrator background transitions", () => {
    it("returns stable tracking metadata without retaining a foreground completion timer", async () => {
        vi.useFakeTimers()
        const process = new FakeTerminalProcess()
        const onOutputLine = vi.fn()
        const onProceedWhileRunning = vi.fn(() => ({
            backgroundCommandId: "background-1",
            logFilePath: "C:\\Temp\\background-1.log",
        }))

        const execution = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), createCallbacks(), {
            command: "long-running-command",
            onOutputLine,
            onProceedWhileRunning,
            startInBackground: true,
        })
        // A command that starts silently is handed off once the start window passes.
        await vi.advanceTimersByTimeAsync(EXPLICIT_BACKGROUND_START_WINDOW_MS)
        const result = await execution

        assert.equal(result.completed, false)
        assert.equal(result.backgroundCommandId, "background-1")
        assert.equal(result.logFilePath, "C:\\Temp\\background-1.log")
        assert.equal(onProceedWhileRunning.mock.calls.length, 1)
        assert.equal(vi.getTimerCount(), 0)

        process.emit("line", "background output", "combined")
        await Promise.resolve()
        await Promise.resolve()
        assert.equal(onOutputLine.mock.calls.length, 0)
    })

    it("hands an explicit background command off at its first output, carrying that output", async () => {
        vi.useFakeTimers()
        const process = new FakeTerminalProcess()
        const onProceedWhileRunning = vi.fn((_existingOutput: TerminalOutputLine[]) => ({
            backgroundCommandId: "background-first-output",
            logFilePath: "C:\\Temp\\background-first-output.log",
        }))
        const execution = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), createCallbacks(), {
            command: "server --watch",
            onProceedWhileRunning,
            startInBackground: true,
        })

        await vi.advanceTimersByTimeAsync(EXPLICIT_BACKGROUND_START_WINDOW_MS / 2)
        // Spawning alone does not report the command as running.
        assert.equal(onProceedWhileRunning.mock.calls.length, 0)
        process.emit("line", "listening on 5173", "combined")
        await vi.advanceTimersByTimeAsync(0)
        const result = await execution

        assert.equal(result.backgroundCommandId, "background-first-output")
        const handedOff = onProceedWhileRunning.mock.calls[0]?.[0] ?? []
        assert.ok(handedOff.some((entry) => entry.line === "listening on 5173"))
    })

    it("includes output emitted immediately before the automatic handoff", async () => {
        vi.useFakeTimers()
        const process = new FakeTerminalProcess()
        const onProceedWhileRunning = vi.fn((_existingOutput: TerminalOutputLine[]) => ({
            backgroundCommandId: "background-tail",
            logFilePath: "C:\\Temp\\background-tail.log",
        }))
        const execution = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), createCallbacks(), {
            command: "slow-output-command",
            onProceedWhileRunning,
            timeoutSeconds: 60,
        })

        process.emit("line", "first", "combined")
        await vi.advanceTimersByTimeAsync(9_999)
        process.emit("line", "tail", "combined")
        await vi.advanceTimersByTimeAsync(1)
        if (onProceedWhileRunning.mock.calls.length === 0) {
            process.complete({ exitCode: 0, signal: null })
        }
        const result = await execution

        assert.equal(onProceedWhileRunning.mock.calls.length, 1)
        assert.deepEqual(onProceedWhileRunning.mock.calls[0]?.[0], [
            { line: "first", stream: "combined" },
            { line: "tail", stream: "combined" },
        ])
        assert.match(result.result as string, /C:\\Temp\\background-tail\.log/)
        assert.doesNotMatch(result.result as string, /Output so far|\[C\] first|\[C\] tail/)
    })

    it("hands a still-running command to the background tracker after 10 seconds without reporting a timeout", async () => {
        vi.useFakeTimers()
        const process = new FakeTerminalProcess()
        const onOutputLine = vi.fn()
        const onProceedWhileRunning = vi.fn(() => ({
            backgroundCommandId: "background-timeout",
            logFilePath: "C:\\Temp\\background-timeout.log",
        }))
        const execution = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), createCallbacks(), {
            command: "slow-command",
            onOutputLine,
            onProceedWhileRunning,
            timeoutSeconds: 60,
        })

        await vi.advanceTimersByTimeAsync(10_000)
        const handedOffAtTenSeconds = onProceedWhileRunning.mock.calls.length
        if (handedOffAtTenSeconds === 0) {
            process.complete({ exitCode: 0, signal: null })
        }
        const result = await execution

        assert.equal(result.completed, false)
        assert.equal(result.backgroundCommandId, "background-timeout")
        assert.equal(result.logFilePath, "C:\\Temp\\background-timeout.log")
        assert.match(result.result as string, /still running after 10 seconds/i)
        assert.match(result.result as string, /available only in a later model request/i)
        assert.doesNotMatch(result.result as string, /timed out/i)
        assert.equal(handedOffAtTenSeconds, 1)
        assert.equal(vi.getTimerCount(), 0)

        process.emit("line", "background output", "combined")
        await Promise.resolve()
        await Promise.resolve()
        assert.equal(onOutputLine.mock.calls.length, 0)
    })

    it("terminates the process when background tracking cannot be established", async () => {
        vi.useFakeTimers()
        const process = new FakeTerminalProcess()
        const onProceedWhileRunning = vi.fn(() => {
            throw new Error("background log unavailable")
        })
        const execution = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), createCallbacks(), {
            command: "untrackable-command",
            onProceedWhileRunning,
            timeoutSeconds: 60,
        })
        const rejected = assert.rejects(
            execution,
            /Background handoff failed\. Termination was requested to prevent an untracked process/,
        )

        await vi.advanceTimersByTimeAsync(10_000)
        await rejected

        assert.equal(onProceedWhileRunning.mock.calls.length, 1)
        assert.equal(process.pauseOutput.mock.calls.length, 1)
        assert.equal(process.resumeOutput.mock.calls.length, 0)
        assert.equal(process.terminate.mock.calls.length, 1)
        assert.equal(vi.getTimerCount(), 0)
    })

    it("uses the configured handoff seconds for automatic background handoff", async () => {
        vi.useFakeTimers()
        const process = new FakeTerminalProcess()
        const onProceedWhileRunning = vi.fn(() => ({
            backgroundCommandId: "background-configured",
            logFilePath: "C:\\Temp\\background-configured.log",
        }))
        const execution = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), createCallbacks(), {
            command: "slow-command",
            handoffSeconds: 3,
            onProceedWhileRunning,
            timeoutSeconds: 60,
        })

        await vi.advanceTimersByTimeAsync(2_999)
        const handedOffBeforeThreeSeconds = onProceedWhileRunning.mock.calls.length
        await vi.advanceTimersByTimeAsync(1)
        if (onProceedWhileRunning.mock.calls.length === 0) {
            process.complete({ exitCode: 0, signal: null })
        }
        const result = await execution

        assert.equal(handedOffBeforeThreeSeconds, 0)
        assert.equal(result.completed, false)
        assert.equal(result.backgroundCommandId, "background-configured")
        assert.match(result.result as string, /still running after 3 seconds/i)
        assert.match(result.result as string, /available only in a later model request/i)
    })

    it("notifies the UI and moves a synchronous command to background on external request", async () => {
        vi.useFakeTimers()
        const process = new FakeTerminalProcess()
        const onHandoffAvailable = vi.fn()
        const onProceedWhileRunning = vi.fn(() => ({
            backgroundCommandId: "background-manual",
            logFilePath: "C:\\Temp\\background-manual.log",
        }))
        let resolveHandoff!: () => void
        const handoffRequest = {
            promise: new Promise<void>((resolve) => {
                resolveHandoff = resolve
            }),
            resolve: () => resolveHandoff(),
        }
        const execution = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), createCallbacks(), {
            command: "sync-command",
            handoffSeconds: 10,
            handoffRequest,
            onHandoffAvailable,
            onProceedWhileRunning,
            synchronous: true,
            timeoutSeconds: 60,
        })

        await vi.advanceTimersByTimeAsync(10_000)
        assert.equal(onHandoffAvailable.mock.calls.length, 1)
        assert.equal(onProceedWhileRunning.mock.calls.length, 0)
        handoffRequest.resolve()
        const result = await execution

        assert.equal(result.completed, false)
        assert.equal(result.backgroundCommandId, "background-manual")
        assert.match(result.result as string, /Command is running in the background/i)
        assert.match(result.result as string, /available only in a later model request/i)
    })

    it("kills a synchronous command at its absolute timeout and returns its existing log path", async () => {
        vi.useFakeTimers()
        const process = new FakeTerminalProcess()
        const onProceedWhileRunning = vi.fn(() => ({ backgroundCommandId: "unexpected-background" }))
        const onTimeout = vi.fn()
        const activityId = "command_timeout_log_contract"
        const expectedLogPath = DlineRuntimeFileManager.createTempFilePath(activityId)
        const execution = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(1), createCallbacks(), {
            activityId,
            command: "blocking-command",
            onProceedWhileRunning,
            onTimeout,
            synchronous: true,
            timeoutSeconds: 60,
        })

        process.emitOutput("first line before timeout", "stdout")
        process.emitOutput("second line before timeout", "stderr")

        try {
            await vi.advanceTimersByTimeAsync(10_000)
            assert.equal(onProceedWhileRunning.mock.calls.length, 0)
            assert.equal(process.terminate.mock.calls.length, 0)

            await vi.advanceTimersByTimeAsync(50_000)
            const result = await execution

            assert.equal(onProceedWhileRunning.mock.calls.length, 0)
            assert.equal(onTimeout.mock.calls.length, 1)
            assert.equal(process.terminate.mock.calls.length, 1)
            assert.equal(result.timedOut, true)
            assert.match(result.result as string, /60-second timeout/i)
            assert.equal(result.logFilePath, expectedLogPath)
            assert.equal((result.result as string).split("\n").at(-1), `Full output saved to: ${expectedLogPath}`)
        } finally {
            await fs.rm(expectedLogPath, { force: true })
        }
    })

    it.each([0, -1, -2])("keeps a synchronous command with timeout %s alive until it completes", async (timeoutSeconds) => {
        vi.useFakeTimers()
        const process = new FakeTerminalProcess()
        const onTimeout = vi.fn()
        const execution = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), createCallbacks(), {
            command: "unbounded-command",
            onTimeout,
            synchronous: true,
            timeoutSeconds,
        })

        await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
        assert.equal(process.terminate.mock.calls.length, 0)
        assert.equal(onTimeout.mock.calls.length, 0)

        process.complete({ exitCode: 0, signal: null })
        const result = await execution
        assert.equal(result.completed, true)
        assert.equal(result.exitCode, 0)
    })

    it("starts the absolute timeout only after the process launch signal", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(0)
        const process = new FakeTerminalProcess(true)
        const execution = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), createCallbacks(), {
            command: "delayed-launch-command",
            synchronous: true,
            timeoutSeconds: 60,
        })

        await vi.advanceTimersByTimeAsync(60_000)
        assert.equal(process.terminate.mock.calls.length, 0)

        process.markStarted()
        await vi.advanceTimersByTimeAsync(59_999)
        assert.equal(process.terminate.mock.calls.length, 0)

        await vi.advanceTimersByTimeAsync(1)
        const result = await execution
        assert.equal(process.terminate.mock.calls.length, 1)
        assert.equal(result.timedOut, true)
    })

    it("kills a default command when its timeout is shorter than the 10-second handoff", async () => {
        vi.useFakeTimers()
        const process = new FakeTerminalProcess()
        const onProceedWhileRunning = vi.fn(() => ({ backgroundCommandId: "unexpected-background" }))
        const execution = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), createCallbacks(), {
            command: "short-deadline-command",
            onProceedWhileRunning,
            timeoutSeconds: 5,
        })

        await vi.advanceTimersByTimeAsync(5_000)
        const result = await execution

        assert.equal(onProceedWhileRunning.mock.calls.length, 0)
        assert.equal(process.terminate.mock.calls.length, 1)
        assert.equal(result.timedOut, true)
    })
})

describe("CommandOrchestrator exit status messaging", () => {
    it("does not report expected task abort as a terminal finalization error", async () => {
        const process = new FakeTerminalProcess()
        const callbacks = createCallbacks()
        callbacks.say = vi.fn(async (_type, _text, _images, _files, partial) => {
            if (partial === false) throw new Error("Dline instance aborted")
            return 321
        })
        const errorSpy = vi.spyOn(Logger, "error").mockImplementation(() => undefined)
        const execution = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), callbacks, {
            command: "cancelled-during-finalization",
        })

        process.emitOutput("visible partial", "stdout")
        process.complete({ exitCode: undefined, signal: null })

        await assert.rejects(execution, /Dline instance aborted/)
        assert.equal(
            errorSpy.mock.calls.filter(([message]) => String(message).includes("Failed to finalize terminal output")).length,
            0,
        )
    })

    it("limits foreground results and saves the complete ordered output", async () => {
        const process = new FakeTerminalProcess()
        const orchestrationPromise = orchestrateCommandExecution(
            process.asResultPromise(),
            createTerminalManager(4),
            createCallbacks(),
            { command: "mixed-output", activityId: "command_limit" },
        )

        process.emitOutput("one", "stdout")
        process.emitOutput("two", "stderr")
        process.emitOutput("three", "stdout")
        process.emitOutput("four", "stderr")
        process.emitOutput("five", "stdout")
        process.emitOutput("six", "stderr")
        process.complete({ exitCode: 0, signal: null })
        const result = await orchestrationPromise

        try {
            assert.equal(result.outputEntries.length, 4)
            assert.match(result.result as string, /2 lines written to/)
            assert.ok(result.logFilePath)
            assert.equal(
                await fs.readFile(result.logFilePath, "utf8"),
                "[O] one\n[E] two\n[O] three\n[E] four\n[O] five\n[E] six\n",
            )
        } finally {
            if (result.logFilePath) await fs.rm(result.logFilePath, { force: true })
        }
    })

    it("frames a 401-line unreachable-object burst without a durable switch message", async () => {
        vi.useFakeTimers()
        const process = new FakeTerminalProcess()
        const callbacks = createCallbacks()
        const say = vi.spyOn(callbacks, "say").mockResolvedValue(321)
        const orchestrationPromise = orchestrateCommandExecution(
            process.asResultPromise(),
            createTerminalManager(400),
            callbacks,
            { command: "synthetic-unreachable-fixture", activityId: "command_401_fixture" },
        )

        for (let index = 0; index < 401; index++) {
            process.emitOutput(`unreachable commit ${index.toString(16).padStart(40, "0")}`, "stdout")
        }
        await vi.advanceTimersByTimeAsync(20)
        expect(say.mock.calls.length).toBeGreaterThan(0)
        expect(say.mock.calls.every((call) => call[4] === true)).toBe(true)

        process.complete({ exitCode: 0, signal: null })
        const result = await orchestrationPromise
        try {
            expect(result.logFilePath).toBeTruthy()
            expect((await fs.readFile(result.logFilePath as string, "utf8")).trim().split("\n")).toHaveLength(401)
            expect(say.mock.calls.at(-1)?.[4]).toBe(false)
        } finally {
            if (result.logFilePath) await fs.rm(result.logFilePath, { force: true })
        }
    })

    it("publishes the owned log path when a foreground command switches to file retention", async () => {
        const process = new FakeTerminalProcess()
        const onLogFileCreated = vi.fn()
        const orchestrationPromise = orchestrateCommandExecution(
            process.asResultPromise(),
            createTerminalManager(1),
            createCallbacks(),
            { command: "large-output", activityId: "command_foreground_log_link", onLogFileCreated },
        )

        process.emitOutput("first", "stdout")
        process.emitOutput("second", "stdout")
        process.complete({ exitCode: 0, signal: null })
        const result = await orchestrationPromise

        try {
            assert.ok(result.logFilePath)
            assert.deepEqual(onLogFileCreated.mock.calls, [[result.logFilePath]])
        } finally {
            if (result.logFilePath) await fs.rm(result.logFilePath, { force: true })
        }
    })

    it("collects stdout and stderr separately in the final tool result", async () => {
        const process = new FakeTerminalProcess()
        const orchestrationPromise = orchestrateCommandExecution(
            process.asResultPromise(),
            createTerminalManager(),
            createCallbacks(),
            { command: "mixed-output" },
        )

        process.emitOutput("normal output", "stdout")
        process.emitOutput("error output", "stderr")
        process.complete({ exitCode: 1, signal: null })
        const result = await orchestrationPromise

        assert.deepEqual(result.stdoutLines, ["normal output"])
        assert.deepEqual(result.stderrLines, ["error output"])
        assert.deepEqual(result.outputLines, ["normal output", "error output"])
        assert.match(result.result as string, /\[O\] normal output\n\[E\] error output/)
        assert.doesNotMatch(result.result as string, /\nOutput:\n/)
    })

    it("reports non-zero exit codes with the existing log path on its own result line", async () => {
        const process = new FakeTerminalProcess()
        const activityId = "command_failed_log_contract"
        const expectedLogPath = DlineRuntimeFileManager.createTempFilePath(activityId)
        const orchestrationPromise = orchestrateCommandExecution(
            process.asResultPromise(),
            createTerminalManager(1),
            createCallbacks(),
            { activityId, command: "false" },
        )

        process.emitOutput("failure detail one", "stderr")
        process.emitOutput("failure detail two", "stderr")
        process.complete({ exitCode: 2, signal: null })
        const result: OrchestrationResult = await orchestrationPromise

        try {
            assert.equal(result.completed, true)
            assert.equal(result.exitCode, 2)
            assert.match(result.result as string, /^Command failed with exit code 2\./)
            assert.equal(result.logFilePath, expectedLogPath)
            assert.equal((result.result as string).split("\n").at(-1), `Full output saved to: ${expectedLogPath}`)
        } finally {
            await fs.rm(expectedLogPath, { force: true })
        }
    })

    it("marks an approved command with a non-zero exit code as failed", async () => {
        const process = new FakeTerminalProcess()
        const messages: Array<Record<string, unknown>> = [{ ask: "command", ts: 100, commandStatus: "pending" }]
        const orchestrationPromise = orchestrateCommandExecution(
            process.asResultPromise(),
            createTerminalManager(),
            createCallbacks(messages),
            { command: "false", commandTs: 100 },
        )
        await vi.waitFor(() => {
            assert.equal(messages[0]?.commandStatus, "running")
        })

        process.complete({ exitCode: 2, signal: null })
        await orchestrationPromise
        await vi.waitFor(() => {
            assert.notEqual(messages[0]?.commandStatus, "running")
        })

        assert.equal(messages[0]?.commandStatus, "failed")
        assert.equal(messages[0]?.exitCode, 2)
    })

    it("does not report success when completion has no exit code", async () => {
        const process = new FakeTerminalProcess()
        const messages: Array<Record<string, unknown>> = [{ ask: "command", ts: 200, commandStatus: "pending" }]
        const orchestrationPromise = orchestrateCommandExecution(
            process.asResultPromise(),
            createTerminalManager(),
            createCallbacks(messages),
            { command: "unknown", commandTs: 200 },
        )
        await vi.waitFor(() => {
            assert.equal(messages[0]?.commandStatus, "running")
        })

        process.complete({ exitCode: undefined, signal: null })
        const result = await orchestrationPromise
        await vi.waitFor(() => {
            assert.equal(messages[0]?.commandStatus, "failed")
        })

        assert.match(result.result as string, /could not be verified/)
    })

    it("reports termination signals even when an exit code is present", async () => {
        const process = new FakeTerminalProcess()
        const orchestrationPromise = orchestrateCommandExecution(
            process.asResultPromise(),
            createTerminalManager(),
            createCallbacks(),
            { command: "interrupted" },
        )

        process.complete({ exitCode: 0, signal: "SIGINT" })
        const result: OrchestrationResult = await orchestrationPromise

        assert.equal(result.signal, "SIGINT")
        assert.match(result.result as string, /^Command terminated by signal SIGINT\./)
    })

    it("reports successful command completion with explicit exit code", async () => {
        const process = new FakeTerminalProcess()
        const orchestrationPromise = orchestrateCommandExecution(
            process.asResultPromise(),
            createTerminalManager(),
            createCallbacks(),
            { command: "echo ok" },
        )

        process.complete({ exitCode: 0, signal: null })
        const result: OrchestrationResult = await orchestrationPromise

        assert.equal(result.completed, true)
        assert.equal(result.exitCode, 0)
        assert.match(result.result as string, /^Command executed successfully \(exit code 0\)\./)
    })
})
