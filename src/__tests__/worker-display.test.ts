import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { withWorkerDisplay } from "../test/e2e/utils/worker-display"

vi.mock("node:child_process", async (original) => ({
    ...(await original<typeof import("node:child_process")>()),
    spawn: vi.fn(),
}))

class DisplayProcess extends EventEmitter {
    pid: number | undefined = 123
    exitCode: number | null = null
    signalCode: NodeJS.Signals | null = null
    stdout = new PassThrough()
    stderr = new PassThrough()
    kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
        this.signalCode = signal
        queueMicrotask(() => this.emit("exit", null, signal))
        return true
    })

    ready(number: string): void {
        this.stdout.write(`${number}\n`)
    }
}

function start(server: DisplayProcess): void {
    vi.mocked(spawn).mockReturnValueOnce(server as unknown as ChildProcessWithoutNullStreams)
}

afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
})

describe("worker display isolation", () => {
    it.each([
        ["win32", "1"],
        ["darwin", "1"],
        ["linux", undefined],
    ] as const)("keeps the inherited display on %s with CI=%s", async (platform, ci) => {
        const environment = { CI: ci, DISPLAY: ":99" }
        let display: string | undefined
        await withWorkerDisplay(
            async () => {
                display = environment.DISPLAY
            },
            environment,
            platform,
        )
        expect(display).toBe(":99")
        expect(spawn).not.toHaveBeenCalled()
        expect(environment.DISPLAY).toBe(":99")
    })

    it("applies the acknowledged display only for the worker lifetime", async () => {
        const server = new DisplayProcess()
        start(server)
        const environment = { CI: "1", DISPLAY: ":99" }
        let display: string | undefined
        const running = withWorkerDisplay(
            async () => {
                display = environment.DISPLAY
            },
            environment,
            "linux",
        )
        expect(display).toBeUndefined()
        server.stdout.write("12")
        expect(display).toBeUndefined()
        server.stdout.write("3\n")
        await running
        expect(display).toBe(":123")
        expect(environment.DISPLAY).toBe(":99")
        expect(server.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM")
        expect(server.listenerCount("exit")).toBe(0)
        expect(server.stdout.listenerCount("data")).toBe(0)
    })

    it("restores an absent display and propagates the test failure after cleanup", async () => {
        const server = new DisplayProcess()
        start(server)
        const environment: NodeJS.ProcessEnv = { CI: "1" }
        const failure = new Error("Original test failure")
        const running = withWorkerDisplay(
            async () => {
                throw failure
            },
            environment,
            "linux",
        )
        const rejected = expect(running).rejects.toBe(failure)
        server.ready("8")
        await rejected
        expect(environment).not.toHaveProperty("DISPLAY")
        expect(server.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM")
    })

    it("keeps concurrent worker environments on their independently allocated servers", async () => {
        const first = new DisplayProcess()
        const second = new DisplayProcess()
        start(first)
        start(second)
        const environments = [
            { CI: "1", DISPLAY: ":99" },
            { CI: "1", DISPLAY: ":99" },
        ]
        const observed: Array<string | undefined> = []
        const running = environments.map((environment, index) =>
            withWorkerDisplay(
                async () => {
                    observed[index] = environment.DISPLAY
                },
                environment,
                "linux",
            ),
        )
        second.ready("22")
        first.ready("21")
        await Promise.all(running)
        expect(observed).toEqual([":21", ":22"])
        expect(environments.map((environment) => environment.DISPLAY)).toEqual([":99", ":99"])
        expect(first.kill).toHaveBeenCalledOnce()
        expect(second.kill).toHaveBeenCalledOnce()
    })

    it("rejects a missing executable without starting tests or changing the inherited display", async () => {
        const server = new DisplayProcess()
        server.pid = undefined
        start(server)
        const run = vi.fn(async () => undefined)
        const environment = { CI: "1", DISPLAY: ":99" }
        const running = withWorkerDisplay(run, environment, "linux")
        const failure = new Error("spawn Xvfb ENOENT")
        const rejected = expect(running).rejects.toBe(failure)
        server.emit("error", failure)
        await rejected
        expect(run).not.toHaveBeenCalled()
        expect(environment.DISPLAY).toBe(":99")
        expect(server.kill).not.toHaveBeenCalled()
    })

    it.each(["invalid", "65536"])("rejects an invalid readiness reply %s and closes its server", async (reply) => {
        const server = new DisplayProcess()
        start(server)
        const run = vi.fn(async () => undefined)
        const running = withWorkerDisplay(run, { CI: "1" }, "linux")
        const rejected = expect(running).rejects.toThrow("invalid display number")
        server.ready(reply)
        await rejected
        expect(run).not.toHaveBeenCalled()
        expect(server.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM")
    })

    it("fails closed on exit before readiness", async () => {
        const server = new DisplayProcess()
        start(server)
        const run = vi.fn(async () => undefined)
        const running = withWorkerDisplay(run, { CI: "1" }, "linux")
        const rejected = expect(running).rejects.toThrow("exited before readiness: display unavailable")
        server.stderr.write("display unavailable")
        server.exitCode = 1
        server.emit("exit", 1, null)
        await rejected
        expect(run).not.toHaveBeenCalled()
        expect(server.kill).not.toHaveBeenCalled()
    })

    it("bounds startup waiting and closes a server that never acknowledges readiness", async () => {
        vi.useFakeTimers()
        const server = new DisplayProcess()
        start(server)
        const run = vi.fn(async () => undefined)
        const running = withWorkerDisplay(run, { CI: "1" }, "linux")
        const rejected = expect(running).rejects.toThrow("readiness timed out")
        await vi.advanceTimersByTimeAsync(10_000)
        await rejected
        expect(run).not.toHaveBeenCalled()
        expect(server.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM")
        expect(vi.getTimerCount()).toBe(0)
    })

    it("escalates shutdown when the owned server ignores SIGTERM", async () => {
        vi.useFakeTimers()
        const server = new DisplayProcess()
        server.kill.mockImplementation((signal: NodeJS.Signals = "SIGTERM") => {
            if (signal === "SIGKILL") {
                server.signalCode = signal
                queueMicrotask(() => server.emit("exit", null, signal))
            }
            return true
        })
        start(server)
        const running = withWorkerDisplay(async () => undefined, { CI: "1" }, "linux")
        server.ready("3")
        await vi.advanceTimersByTimeAsync(5_000)
        await running
        expect(server.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"])
        expect(vi.getTimerCount()).toBe(0)
    })
})
