import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import { SynchronousCleanupStack, withSignalSafeCleanup } from "../../scripts/signal-safe-cleanup.mjs"

class FakeSignalProcess extends EventEmitter {
    readonly exitCodes: number[] = []

    exit(code: number): void {
        this.exitCodes.push(code)
    }
}

describe("signal-safe packaging cleanup", () => {
    it("runs deferred cleanup once in reverse order", () => {
        const events: string[] = []
        const cleanups = new SynchronousCleanupStack()
        cleanups.defer(() => events.push("readme"))
        cleanups.defer(() => events.push("package-json"))

        cleanups.cleanup()
        cleanups.cleanup()

        expect(events).toEqual(["package-json", "readme"])
    })

    it("restores every resource when work throws", async () => {
        const events: string[] = []
        await expect(
            withSignalSafeCleanup(async (cleanups) => {
                cleanups.defer(() => events.push("readme"))
                cleanups.defer(() => events.push("package-json"))
                throw new Error("pack failed")
            }),
        ).rejects.toThrow("pack failed")

        expect(events).toEqual(["package-json", "readme"])
    })

    it.each([
        ["SIGINT", 130],
        ["SIGTERM", 143],
    ] as const)("restores every resource before exiting on %s", async (signal, exitCode) => {
        const processRef = new FakeSignalProcess()
        const events: string[] = []

        await withSignalSafeCleanup(
            async (cleanups) => {
                cleanups.defer(() => events.push("readme"))
                cleanups.defer(() => events.push("package-json"))
                processRef.emit(signal)
            },
            { processRef },
        )

        expect(events).toEqual(["package-json", "readme"])
        expect(processRef.exitCodes).toEqual([exitCode])
        expect(processRef.listenerCount("SIGINT")).toBe(0)
        expect(processRef.listenerCount("SIGTERM")).toBe(0)
    })
})
