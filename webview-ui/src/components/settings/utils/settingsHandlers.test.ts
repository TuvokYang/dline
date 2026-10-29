import { describe, expect, it, vi } from "vitest"
import { SettingsRequestTracker } from "./settingsRequestTracker"

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, reject, resolve }
}

describe("SettingsRequestTracker", () => {
    it("waits for every in-flight Settings RPC before reporting a failure", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
        const tracker = new SettingsRequestTracker()
        const first = deferred<unknown>()
        const second = deferred<unknown>()
        void tracker.track(["global:chatInputSendShortcut"], first.promise, "Failed to update settings:").catch(() => undefined)
        void tracker
            .track(["global:terminalOutputLineLimit"], second.promise, "Failed to update settings:")
            .catch(() => undefined)

        let settled = false
        const flushPromise = tracker.flush().finally(() => {
            settled = true
        })
        first.reject(new Error("shortcut write failed"))
        await Promise.resolve()
        expect(settled).toBe(false)

        second.resolve(undefined)
        await expect(flushPromise).rejects.toThrow("shortcut write failed")
        expect(settled).toBe(true)
        consoleError.mockRestore()
    })

    it("serializes overlapping requests for the same setting key", async () => {
        const tracker = new SettingsRequestTracker()
        const first = deferred<unknown>()
        const starts: string[] = []

        const firstRequest = tracker.trackQueued(
            ["task:task-1:actModeReasoningOverrideEffort"],
            () => {
                starts.push("first")
                return first.promise
            },
            "Failed to update task settings:",
        )
        const secondRequest = tracker.trackQueued(
            ["task:task-1:actModeReasoningOverrideEffort"],
            async () => {
                starts.push("second")
            },
            "Failed to update task settings:",
        )

        await Promise.resolve()
        expect(starts).toEqual(["first"])
        first.resolve(undefined)
        await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([undefined, undefined])
        expect(starts).toEqual(["first", "second"])
    })

    it("allows requests for independent setting keys to run concurrently", async () => {
        const tracker = new SettingsRequestTracker()
        const first = deferred<unknown>()
        const second = deferred<unknown>()
        const starts: string[] = []

        const firstRequest = tracker.trackQueued(
            ["task:task-1:thinking"],
            () => {
                starts.push("thinking")
                return first.promise
            },
            "Failed to update task settings:",
        )
        const secondRequest = tracker.trackQueued(
            ["task:task-1:tier"],
            () => {
                starts.push("tier")
                return second.promise
            },
            "Failed to update task settings:",
        )

        await Promise.resolve()
        expect(starts).toEqual(["thinking", "tier"])
        first.resolve(undefined)
        second.resolve(undefined)
        await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([undefined, undefined])
    })

    it("clears a field failure only after a newer request for that field succeeds", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
        const tracker = new SettingsRequestTracker()
        const requestKey = "global:chatInputSendShortcut"
        const failed = deferred<unknown>()
        void tracker.track([requestKey], failed.promise, "Failed to update settings:").catch(() => undefined)

        failed.reject(new Error("first write failed"))
        await expect(tracker.flush()).rejects.toThrow("first write failed")

        await tracker.track([requestKey], Promise.resolve(undefined), "Failed to update settings:")
        await expect(tracker.flush()).resolves.toBeUndefined()
        consoleError.mockRestore()
    })
})
