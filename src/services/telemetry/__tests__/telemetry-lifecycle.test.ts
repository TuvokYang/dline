import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { ITelemetryProvider, TelemetryProperties, TelemetrySettings } from "../providers/ITelemetryProvider"
import { TelemetryProviderFactory } from "../TelemetryProviderFactory"

/**
 * The process-wide singleton's lifecycle, as opposed to what the service does
 * once it exists.
 *
 * The property worth pinning is the one shutdown order makes easy to break:
 * teardown disposes telemetry before controllers release their tasks, and a
 * terminating task still reports. If a late call rebuilt the singleton it would
 * attach real providers with nothing left to close them, so the host would keep
 * an exporter's sockets and timers open past shutdown — invisible to every test
 * that only exercises the service directly.
 *
 * The suite setup replaces `@services/telemetry` with stubs so that unrelated
 * tests never construct a real service. That is exactly the module under test
 * here, so the real one is loaded explicitly.
 */

type TelemetryModule = typeof import("../index")

let telemetryModule: TelemetryModule

// A cold load transforms the real provider graph, which can take longer than the default hook timeout.
beforeAll(async () => {
    telemetryModule = await vi.importActual<TelemetryModule>("../index")
}, 60_000)

class SpyProvider implements ITelemetryProvider {
    readonly name = "SpyProvider"
    readonly events: string[] = []
    disposed = false

    log(event: string): void {
        this.events.push(event)
    }
    logRequired(event: string): void {
        this.events.push(event)
    }
    identifyUser(): void {}
    isEnabled(): boolean {
        return true
    }
    getSettings(): TelemetrySettings {
        return { hostEnabled: true, level: "all" }
    }
    recordCounter(_name: string, _value: number, _attributes?: TelemetryProperties): void {}
    recordHistogram(): void {}
    recordGauge(): void {}
    async forceFlush(): Promise<void> {}
    async dispose(): Promise<void> {
        this.disposed = true
    }
}

/** Replaces real provider construction so no test opens a network client. */
function stubProviderFactory(provider: ITelemetryProvider) {
    return vi.spyOn(TelemetryProviderFactory, "createProviders").mockResolvedValue([provider])
}

describe("telemetry service lifecycle", () => {
    afterEach(() => {
        vi.restoreAllMocks()
        telemetryModule.resetTelemetryService()
    })

    it("builds the service lazily, on first use", () => {
        const created = stubProviderFactory(new SpyProvider())

        // Importing the module must not construct anything: module load order
        // across hosts is not something call sites should have to reason about.
        expect(created).not.toHaveBeenCalled()

        telemetryModule.getTelemetryServiceSync()

        expect(created).toHaveBeenCalledOnce()
    })

    it("returns one instance to every caller", () => {
        stubProviderFactory(new SpyProvider())

        expect(telemetryModule.getTelemetryServiceSync()).toBe(telemetryModule.getTelemetryServiceSync())
    })

    it("does not rebuild the service after shutdown", async () => {
        const provider = new SpyProvider()
        const created = stubProviderFactory(provider)

        const before = telemetryModule.getTelemetryServiceSync()
        await telemetryModule.getTelemetryService()
        await telemetryModule.disposeTelemetryService()
        expect(provider.disposed).toBe(true)

        // This is what a task terminating during teardown does.
        const after = telemetryModule.getTelemetryServiceSync()

        expect(after).not.toBe(before)
        // A second construction would attach providers nothing will close.
        expect(created).toHaveBeenCalledOnce()
        expect(after.getProviders()).toEqual([])
    })

    it("keeps reporting inert after shutdown instead of throwing", async () => {
        stubProviderFactory(new SpyProvider())

        await telemetryModule.getTelemetryService()
        await telemetryModule.disposeTelemetryService()

        // A late capture must be a no-op, not a failure inside teardown.
        expect(() => telemetryModule.telemetryService.captureExtensionActivated()).not.toThrow()
    })

    it("allows a fresh service after an explicit reset", async () => {
        const revived = new SpyProvider()
        const created = stubProviderFactory(revived)

        await telemetryModule.getTelemetryService()
        await telemetryModule.disposeTelemetryService()
        telemetryModule.resetTelemetryService()

        const service = await telemetryModule.getTelemetryService()

        // Reset clears the shutdown latch, so construction resumes rather than
        // staying inert. Without it one test file could not exercise the
        // lifecycle twice, and neither could a host that restarts telemetry.
        expect(created).toHaveBeenCalledTimes(2)
        expect(service.getProviders()).toContain(revived)
    })
})
