import { describe, expect, it, vi } from "vitest"
import { startRuntimeTelemetryInBackground } from "../background-activation"
import type { RuntimeTelemetryLifecycle } from "../lifecycle"

function deferred<T>(): {
    readonly promise: Promise<T>
    readonly resolve: (value: T) => void
    readonly reject: (error: unknown) => void
} {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((settle, fail) => {
        resolve = settle
        reject = fail
    })
    return { promise, resolve, reject }
}

describe("startRuntimeTelemetryInBackground", () => {
    it("returns without waiting for telemetry activation", async () => {
        const activation = deferred<RuntimeTelemetryLifecycle>()
        const onStarted = vi.fn()
        const activate = vi.fn(() => activation.promise)

        const result = startRuntimeTelemetryInBackground(
            { dataDir: "unused", telemetrySetting: "enabled" },
            { onStarted },
            activate,
        )

        expect(result).toBeUndefined()
        expect(activate).toHaveBeenCalledOnce()
        expect(onStarted).not.toHaveBeenCalled()

        const lifecycle = {} as RuntimeTelemetryLifecycle
        activation.resolve(lifecycle)
        await activation.promise
        await Promise.resolve()

        expect(onStarted).toHaveBeenCalledWith(lifecycle)
    })

    it("contains activation and observer failures", async () => {
        const activation = deferred<RuntimeTelemetryLifecycle>()
        const onError = vi.fn(() => {
            throw new Error("observer failed")
        })

        expect(() =>
            startRuntimeTelemetryInBackground(
                { dataDir: "unused", telemetrySetting: "enabled" },
                { onError },
                () => activation.promise,
            ),
        ).not.toThrow()

        const failure = new Error("activation failed")
        activation.reject(failure)
        await activation.promise.catch(() => undefined)
        await Promise.resolve()

        expect(onError).toHaveBeenCalledWith(failure)
    })
})
