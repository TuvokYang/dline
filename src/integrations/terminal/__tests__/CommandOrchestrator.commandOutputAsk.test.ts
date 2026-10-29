import assert from "node:assert/strict"
import { EventEmitter } from "events"
import { describe, it, vi } from "vitest"
import { orchestrateCommandExecution } from "../CommandOrchestrator"
import type {
    CommandExecutorCallbacks,
    ITerminalManager,
    ITerminalProcess,
    TerminalCompletionDetails,
    TerminalProcessEvents,
    TerminalProcessResultPromise,
} from "../types"

class FakeTerminalProcess extends EventEmitter<TerminalProcessEvents> implements ITerminalProcess {
    isHot = false
    waitForShellIntegration = false
    private readonly promise: Promise<void>
    private resolvePromise!: () => void

    constructor() {
        super()
        this.promise = new Promise<void>((resolve) => {
            this.resolvePromise = resolve
        })
    }

    continue(): void {
        this.emit("continue")
    }

    getUnretrievedOutput(): string {
        return ""
    }

    getCompletionDetails(): TerminalCompletionDetails {
        return {}
    }

    complete(details?: TerminalCompletionDetails): void {
        this.emit("completed", details)
        this.resolvePromise()
    }

    asResultPromise(): TerminalProcessResultPromise {
        const result = this as unknown as FakeTerminalProcess & Partial<TerminalProcessResultPromise>
        result.then = this.promise.then.bind(this.promise)
        result.catch = this.promise.catch.bind(this.promise)
        result.finally = this.promise.finally.bind(this.promise)
        return result as TerminalProcessResultPromise
    }
}

function createCallbacks() {
    const say = vi.fn(async () => 321)
    const ask = vi.fn(async () => ({ response: "messageResponse" as const }))
    const callbacks: CommandExecutorCallbacks = {
        say,
        ask,
        updateBackgroundCommandState: () => {},
        updateClineMessage: async () => {},
        getClineMessages: () => [],
        addToUserMessageContent: () => {},
    }
    return { ask, callbacks, say }
}

const manager = { processOutput: (lines: string[]) => lines.join("\n") } as ITerminalManager

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error("Condition not met before timeout")
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

describe("CommandOrchestrator live command output", () => {
    it("publishes output before completion without opening an ask", async () => {
        const process = new FakeTerminalProcess()
        const { ask, callbacks, say } = createCallbacks()
        let settled = false
        const execution = orchestrateCommandExecution(process.asResultPromise(), manager, callbacks, {
            command: "long-running",
            commandTs: 100,
        }).then((result) => {
            settled = true
            return result
        })

        process.emit("line", "first line", "combined")
        await waitFor(() => say.mock.calls.length > 0)
        assert.equal(settled, false)
        assert.equal(ask.mock.calls.length, 0)
        assert.deepEqual(say.mock.calls[0], ["command_output", "first line", undefined, undefined, true, undefined, 100])
        process.complete({ exitCode: 0, signal: null })
        await execution
    })

    it("updates one cumulative partial message and finalizes it", async () => {
        const process = new FakeTerminalProcess()
        const { callbacks, say } = createCallbacks()
        const execution = orchestrateCommandExecution(process.asResultPromise(), manager, callbacks, { command: "stream" })

        process.emit("line", "one", "combined")
        await waitFor(() => say.mock.calls.length >= 1)
        process.emit("line", "two", "combined")
        await waitFor(() => say.mock.calls.length >= 2)
        const calls = say.mock.calls as unknown as unknown[][]
        assert.equal(calls[1]?.[1], "one\ntwo")
        assert.equal(calls[1]?.[5], 321)
        process.complete({ exitCode: 0, signal: null })
        await execution

        const final = calls.at(-1)
        assert.equal(final?.[1], "one\ntwo")
        assert.equal(final?.[4], false)
        assert.equal(final?.[5], 321)
    })

    it("drains queued tail output before returning", async () => {
        const process = new FakeTerminalProcess()
        const { callbacks } = createCallbacks()
        const execution = orchestrateCommandExecution(process.asResultPromise(), manager, callbacks, { command: "tail" })

        process.emit("line", "tail line", "combined")
        process.complete({ exitCode: 0, signal: null })
        const result = await execution
        assert.deepEqual(result.outputLines, ["tail line"])
        assert.match(result.result as string, /tail line/)
    })
})
