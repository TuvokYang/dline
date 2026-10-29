import { afterEach, describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"
import { EXTENSION_BUNDLE_PATTERN, registerExtensionReloadWatcher } from "./ExtensionReloadWatcher"

type UriListener = (uri: vscode.Uri) => void

class FakeWatcher {
    private readonly createListeners = new Set<UriListener>()
    private readonly changeListeners = new Set<UriListener>()
    readonly dispose = vi.fn(() => {
        this.createListeners.clear()
        this.changeListeners.clear()
    })

    onDidCreate(listener: UriListener): vscode.Disposable {
        this.createListeners.add(listener)
        return { dispose: () => this.createListeners.delete(listener) }
    }

    onDidChange(listener: UriListener): vscode.Disposable {
        this.changeListeners.add(listener)
        return { dispose: () => this.changeListeners.delete(listener) }
    }

    emitCreate(fsPath = "E:\\workspace\\dline\\dist\\extension.js"): void {
        for (const listener of this.createListeners) listener({ fsPath } as vscode.Uri)
    }

    emitChange(fsPath = "E:\\workspace\\dline\\dist\\extension.js"): void {
        for (const listener of this.changeListeners) listener({ fsPath } as vscode.Uri)
    }
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

function createHarness(reloadWindow: () => PromiseLike<void> | void = vi.fn(async () => undefined)) {
    const watcher = new FakeWatcher()
    const createFileSystemWatcher = vi.fn(() => watcher as unknown as vscode.FileSystemWatcher)
    const subscriptions: vscode.Disposable[] = []
    const log = vi.fn()
    const logError = vi.fn()
    const registration = registerExtensionReloadWatcher({ subscriptions }, "E:\\workspace\\dline", {
        createFileSystemWatcher,
        reloadWindow,
        log,
        logError,
        debounceMs: 300,
    })

    return { createFileSystemWatcher, log, logError, registration, reloadWindow, subscriptions, watcher }
}

afterEach(() => {
    vi.useRealTimers()
})

describe("registerExtensionReloadWatcher", () => {
    it("watches only the compiled extension bundle and ignores delete events", () => {
        const harness = createHarness()

        expect(EXTENSION_BUNDLE_PATTERN).toBe("dist/extension.js")
        expect(harness.createFileSystemWatcher).toHaveBeenCalledTimes(1)
        expect(harness.createFileSystemWatcher).toHaveBeenCalledWith(
            "E:\\workspace\\dline",
            EXTENSION_BUNDLE_PATTERN,
            false,
            false,
            true,
        )
        expect(harness.subscriptions).toEqual([harness.registration])
    })

    it("coalesces create and change events into one reload", async () => {
        vi.useFakeTimers()
        const harness = createHarness()

        harness.watcher.emitCreate()
        await vi.advanceTimersByTimeAsync(200)
        harness.watcher.emitChange()
        await vi.advanceTimersByTimeAsync(299)
        expect(harness.reloadWindow).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(1)
        expect(harness.reloadWindow).toHaveBeenCalledTimes(1)
        expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("dist\\extension.js"))
    })

    it("does not start another reload while the first reload is in flight", async () => {
        vi.useFakeTimers()
        const pendingReload = deferred<void>()
        const reloadWindow = vi.fn(() => pendingReload.promise)
        const harness = createHarness(reloadWindow)

        harness.watcher.emitChange()
        await vi.advanceTimersByTimeAsync(300)
        expect(reloadWindow).toHaveBeenCalledTimes(1)

        harness.watcher.emitChange()
        await vi.advanceTimersByTimeAsync(300)
        expect(reloadWindow).toHaveBeenCalledTimes(1)

        pendingReload.resolve()
        await pendingReload.promise
    })

    it("cancels a pending reload and disposes the watcher", async () => {
        vi.useFakeTimers()
        const harness = createHarness()

        harness.watcher.emitChange()
        harness.registration.dispose()
        await vi.advanceTimersByTimeAsync(300)

        expect(harness.reloadWindow).not.toHaveBeenCalled()
        expect(harness.watcher.dispose).toHaveBeenCalledTimes(1)
    })

    it("logs a rejected reload and allows a later retry", async () => {
        vi.useFakeTimers()
        const reloadWindow = vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(new Error("reload failed"))
            .mockResolvedValueOnce(undefined)
        const harness = createHarness(reloadWindow)

        harness.watcher.emitChange()
        await vi.advanceTimersByTimeAsync(300)
        await Promise.resolve()
        expect(harness.logError).toHaveBeenCalledTimes(1)

        harness.watcher.emitChange()
        await vi.advanceTimersByTimeAsync(300)
        expect(reloadWindow).toHaveBeenCalledTimes(2)
    })
})
