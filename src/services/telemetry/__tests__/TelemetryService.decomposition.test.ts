import { describe, expect, it, vi } from "vitest"
import type { ITelemetryProvider, TelemetryProperties, TelemetrySettings } from "../providers/ITelemetryProvider"
import { TelemetryProviderRegistry } from "../service/provider-registry"
import { TelemetryService } from "../TelemetryService"

/**
 * Guards the properties the decomposition is supposed to deliver, as distinct
 * from event-by-event parity, which `TelemetryService.test.ts` and
 * `TelemetryService.metrics.test.ts` already cover.
 *
 * Each case corresponds to a defect the previous shape allowed or the split
 * risked introducing: a constructor that could not run without awaiting a host
 * bridge, a `safeCapture` blind to async failures, and — the regression this
 * split had to avoid — activation events discarded because providers had not
 * finished being built.
 */

class RecordingProvider implements ITelemetryProvider {
    readonly name = "RecordingProvider"
    readonly events: Array<{ event: string; properties?: TelemetryProperties; required: boolean }> = []
    readonly counters: Array<{ name: string; value: number; attributes?: TelemetryProperties }> = []
    readonly identified: Array<{ id: string; properties?: TelemetryProperties }> = []
    disposed = false

    log(event: string, properties?: TelemetryProperties): void {
        this.events.push({ event, properties, required: false })
    }
    logRequired(event: string, properties?: TelemetryProperties): void {
        this.events.push({ event, properties, required: true })
    }
    identifyUser(userInfo: { id: string }, properties?: TelemetryProperties): void {
        this.identified.push({ id: userInfo.id, properties })
    }
    isEnabled(): boolean {
        return true
    }
    getSettings(): TelemetrySettings {
        return { hostEnabled: true, level: "all" }
    }
    recordCounter(name: string, value: number, attributes?: TelemetryProperties): void {
        this.counters.push({ name, value, attributes })
    }
    recordHistogram(): void {}
    recordGauge(): void {}
    async forceFlush(): Promise<void> {}
    async dispose(): Promise<void> {
        this.disposed = true
    }

    eventNames(): string[] {
        return this.events.map((entry) => entry.event)
    }
}

class ThrowingProvider implements ITelemetryProvider {
    readonly name = "ThrowingProvider"

    log(): void {
        throw new Error("provider log failed")
    }
    logRequired(): void {
        throw new Error("provider logRequired failed")
    }
    identifyUser(): void {
        throw new Error("provider identify failed")
    }
    isEnabled(): boolean {
        return true
    }
    getSettings(): TelemetrySettings {
        return { hostEnabled: true, level: "all" }
    }
    recordCounter(): void {
        throw new Error("provider counter failed")
    }
    recordHistogram(): void {
        throw new Error("provider histogram failed")
    }
    recordGauge(): void {
        throw new Error("provider gauge failed")
    }
    async forceFlush(): Promise<void> {}
    async dispose(): Promise<void> {}
}

function createService(providers: ITelemetryProvider[]): TelemetryService {
    return new TelemetryService(providers, TelemetryService.initialMetadata())
}

describe("TelemetryService decomposition", () => {
    it("is usable immediately, without awaiting host metadata", () => {
        const provider = new RecordingProvider()

        // Construction alone must produce the session-start event: if this
        // required an await, the activation path would report nothing.
        const service = createService([provider])

        expect(service.isEnabled()).toBe(true)
        expect(provider.eventNames()).toContain("user.telemetry_enabled")
    })

    it("attaches host metadata to events before the host bridge answers", () => {
        const provider = new RecordingProvider()
        const service = createService([provider])
        provider.events.length = 0

        service.captureTaskCreated("task-1", "anthropic")

        const [entry] = provider.events
        expect(entry.event).toBe("task.created")
        // Host identity is unknown until the bridge answers, but the fields are
        // present so downstream schemas do not have to treat them as optional.
        expect(entry.properties).toMatchObject({ ulid: "task-1", platform: "unknown" })
        expect(entry.properties?.extension_version).toBeTypeOf("string")
    })

    it("sends opt-out as a required event so it survives the setting change", () => {
        const provider = new RecordingProvider()
        const service = createService([provider])
        provider.events.length = 0

        service.captureUserOptOut()

        expect(provider.events).toHaveLength(1)
        expect(provider.events[0]).toMatchObject({ event: "user.opt_out", required: true })
    })

    it("isolates provider failures from callers", () => {
        const service = createService([new ThrowingProvider()])

        expect(() => service.captureTaskCreated("task-1")).not.toThrow()
        expect(() => service.captureTokenUsage("task-1", 1, 1, "anthropic", "model")).not.toThrow()
        expect(() => service.captureWorkspaceInitialized(2, ["Git"])).not.toThrow()
    })

    it("keeps delivering to healthy providers when one throws", () => {
        const healthy = new RecordingProvider()
        const service = createService([new ThrowingProvider(), healthy])
        healthy.events.length = 0

        service.captureButtonClick("submit")

        expect(healthy.eventNames()).toEqual(["ui.button_clicked"])
    })

    it("lets safeCapture observe a synchronous failure", () => {
        const service = createService([new RecordingProvider()])
        const failure = vi.fn(() => {
            throw new Error("attribute construction failed")
        })

        // The wrapper exists to protect tool execution from telemetry faults.
        expect(() => service.safeCapture(failure, "test")).not.toThrow()
        expect(failure).toHaveBeenCalledOnce()
    })

    it("catches an async failure instead of leaking an unhandled rejection", async () => {
        const service = createService([new RecordingProvider()])
        const rejection = new Error("async capture failed")
        const unhandled = vi.fn()
        process.on("unhandledRejection", unhandled)

        try {
            service.safeCapture(async () => {
                throw rejection
            }, "test")

            // Let the microtask queue drain so an unattached rejection surfaces.
            await new Promise((resolve) => setTimeout(resolve, 10))
            expect(unhandled).not.toHaveBeenCalled()
        } finally {
            process.off("unhandledRejection", unhandled)
        }
    })

    it("suppresses events for a disabled category without reaching providers", () => {
        const provider = new RecordingProvider()
        const service = createService([provider])
        provider.events.length = 0

        service.setCategoryEnabled("browser", false)

        expect(service.isCategoryEnabled("browser")).toBe(false)
        service.captureBrowserToolStart("task-1", { viewport: { width: 900, height: 600 } } as never)
        service.captureBrowserError("task-1", "launch_error", "boom")

        expect(provider.events).toEqual([])

        // And re-enabling restores delivery, so the gate is a switch rather
        // than a one-way kill.
        service.setCategoryEnabled("browser", true)
        service.captureBrowserToolStart("task-1", { viewport: { width: 900, height: 600 } } as never)
        expect(provider.eventNames()).toEqual(["task.browser_tool_start"])
    })

    it("records terminal exit codes only for standalone terminals", () => {
        const provider = new RecordingProvider()
        const service = createService([provider])
        provider.events.length = 0

        service.captureTerminalExecution(true, "vscode", "shell_integration")
        service.captureTerminalExecution(true, "standalone", "child_process", 0)
        service.captureTerminalExecution(false, "standalone", "child_process_error", 127)
        service.captureTerminalExecution(false, "standalone", "child_process_error", null)
        service.captureTerminalExecution(true, "standalone", "child_process")

        const properties = provider.events.map((entry) => entry.properties)
        // A vscode terminal has no exit code to report.
        expect(properties[0]).not.toHaveProperty("exitCode")
        // Zero is a real exit code and must survive the falsy check.
        expect(properties[1]).toMatchObject({ terminalType: "standalone", exitCode: 0 })
        expect(properties[2]).toMatchObject({ exitCode: 127 })
        // Null and undefined both mean "no exit code was observed".
        expect(properties[3]).not.toHaveProperty("exitCode")
        expect(properties[4]).not.toHaveProperty("exitCode")
    })

    it("adds and removes providers at runtime", async () => {
        const provider = new RecordingProvider()
        const service = createService([])

        service.addProvider(provider)
        expect(service.getProviders()).toHaveLength(1)

        await service.removeProvider(provider.name)
        expect(service.getProviders()).toHaveLength(0)
        await service.dispose()
    })

    it("reports settings from providers, defaulting to off when none exist", () => {
        expect(createService([]).getSettings()).toEqual({ hostEnabled: false, level: "off" })
        expect(createService([new RecordingProvider()]).getSettings()).toEqual({ hostEnabled: true, level: "all" })
    })
})

describe("deferred provider attachment", () => {
    it("replays signals recorded before providers existed, in order", () => {
        const registry = new TelemetryProviderRegistry([], { ready: false })
        const provider = new RecordingProvider()

        registry.logEvent("user.telemetry_enabled", () => ({}), false)
        registry.recordCounter("dline.turns.total", 1, () => ({}))
        registry.logEvent("user.extension_activated", () => ({}), false)
        registry.identifyUser({ id: "user-1" } as never, () => ({}))

        // Nothing can be delivered yet, but nothing is lost either.
        expect(registry.pendingCount).toBe(4)

        registry.add(provider)
        registry.markReady()

        // Order holds across kinds: events and metrics share one queue, so a
        // consumer can still reconstruct the startup sequence.
        expect(provider.eventNames()).toEqual(["user.telemetry_enabled", "user.extension_activated"])
        expect(provider.counters.map((entry) => entry.name)).toEqual(["dline.turns.total"])
        expect(provider.identified.map((entry) => entry.id)).toEqual(["user-1"])
        expect(registry.pendingCount).toBe(0)
    })

    it("resolves properties at delivery time, not at record time", () => {
        const registry = new TelemetryProviderRegistry([], { ready: false })
        const provider = new RecordingProvider()
        let platform = "unknown"

        // Mirrors the real sequence: the signal is recorded before the host
        // bridge answers, and delivered after it does.
        registry.logEvent("user.extension_activated", () => ({ platform }), false)
        platform = "VS Code"

        registry.add(provider)
        registry.markReady()

        expect(provider.events[0].properties).toMatchObject({ platform: "VS Code" })
    })

    it("delivers directly once ready, without buffering", () => {
        const provider = new RecordingProvider()
        const registry = new TelemetryProviderRegistry([provider], { ready: false })

        registry.markReady()
        registry.logEvent("task.created", () => ({ ulid: "task-1" }), false)

        expect(registry.pendingCount).toBe(0)
        expect(provider.eventNames()).toEqual(["task.created"])
    })

    it("bounds what it holds so a factory that never resolves cannot grow memory", () => {
        const registry = new TelemetryProviderRegistry([], { ready: false })

        for (let index = 0; index < 2_000; index++) {
            registry.logEvent(`task.event_${index}`, () => ({}), false)
        }

        expect(registry.pendingCount).toBeLessThan(2_000)
    })

    it("does not deliver to a provider added after disposal", async () => {
        const registry = new TelemetryProviderRegistry([], { ready: false })
        const late = new RecordingProvider()

        await registry.dispose()
        registry.add(late)
        registry.markReady()
        registry.logEvent("task.created", () => ({}), false)

        // The provider is disposed rather than retained, so its sockets and
        // timers are not left with nothing to close them.
        expect(late.eventNames()).toEqual([])
        expect(late.disposed).toBe(true)
        expect(registry.list()).toEqual([])
    })

    it("keeps the receiving set stable while a provider mutates the registry", () => {
        const late = new RecordingProvider()
        const reentrant: ITelemetryProvider = {
            name: "ReentrantProvider",
            log() {
                // A provider that registers another mid-fan-out must not change
                // who receives the signal currently being delivered.
                registry.add(late)
            },
            logRequired() {},
            identifyUser() {},
            isEnabled: () => true,
            getSettings: () => ({ hostEnabled: true, level: "all" }),
            recordCounter() {},
            recordHistogram() {},
            recordGauge() {},
            forceFlush: async () => {},
            dispose: async () => {},
        }
        const registry = new TelemetryProviderRegistry([reentrant])

        registry.logEvent("task.created", () => ({}), false)
        expect(late.eventNames()).toEqual([])

        registry.logEvent("task.completed", () => ({}), false)
        expect(late.eventNames()).toEqual(["task.completed"])
    })
})
