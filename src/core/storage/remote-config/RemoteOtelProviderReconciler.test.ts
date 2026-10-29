import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryProviderRegistration } from "@/services/telemetry/providers/capabilities"
import type { OpenTelemetryClientValidConfig } from "@/shared/services/config/otel-config"
import {
    organizationMayReceive,
    REMOTE_CONFIG_OTEL_PROVIDER_ID,
    RemoteOtelProviderReconciler,
} from "./RemoteOtelProviderReconciler"

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

function config(endpoint: string): OpenTelemetryClientValidConfig {
    return {
        enabled: true,
        logsExporter: "otlp",
        otlpProtocol: "http/json",
        otlpEndpoint: endpoint,
    }
}

function registration(dispose = vi.fn(async () => undefined)): TelemetryProviderRegistration {
    return {
        kind: "registration",
        base: {
            name: REMOTE_CONFIG_OTEL_PROVIDER_ID,
            isEnabled: () => true,
            getSettings: () => ({ hostEnabled: true, level: "all" }),
            forceFlush: async () => undefined,
            dispose,
        },
        sink: { kind: "remote", origin: "organization", channels: ["usage"] },
        capabilities: [],
    }
}

function telemetry(enabled: () => boolean = () => true) {
    return {
        addProvider: vi.fn(),
        removeProvider: vi.fn(),
        isEnabled: vi.fn(enabled),
    }
}

function options(overrides: Record<string, unknown> = {}) {
    return {
        probe: vi.fn(async () => undefined),
        replay: vi.fn(async () => undefined),
        probeTimeoutMs: 1_000,
        healthyProbeIntervalMs: 100,
        initialBackoffMs: 10,
        maxBackoffMs: 40,
        ...overrides,
    }
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
}

describe("RemoteOtelProviderReconciler", () => {
    beforeEach(() => vi.useFakeTimers())

    afterEach(() => {
        vi.clearAllTimers()
        vi.useRealTimers()
    })

    it("returns immediately while remote provider construction remains pending", async () => {
        const pending = deferred<TelemetryProviderRegistration | undefined>()
        const service = telemetry()
        const injected = options()
        const reconciler = new RemoteOtelProviderReconciler(service, () => pending.promise, injected)

        expect(reconciler.reconcile(config("http://collector-a"))).toBeUndefined()
        expect(service.addProvider).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(0)

        expect(injected.probe).toHaveBeenCalledOnce()
        expect(injected.replay).toHaveBeenCalledOnce()
        expect(service.addProvider).not.toHaveBeenCalled()
        reconciler.clear()
        pending.resolve(undefined)
        await flushMicrotasks()
    })

    it("serializes probes and resumes the newest generation after a stale provider build", async () => {
        const first = deferred<TelemetryProviderRegistration | undefined>()
        const staleDispose = vi.fn(async () => undefined)
        const stale = registration(staleDispose)
        const current = registration()
        const service = telemetry()
        const createProvider = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(current)
        const injected = options()
        const reconciler = new RemoteOtelProviderReconciler(service, createProvider, injected)

        reconciler.reconcile(config("http://collector-old"))
        await vi.advanceTimersByTimeAsync(0)
        expect(createProvider).toHaveBeenCalledOnce()

        reconciler.reconcile(config("http://collector-current"))
        await vi.advanceTimersByTimeAsync(0)
        expect(createProvider).toHaveBeenCalledOnce()

        first.resolve(stale)
        await first.promise
        await flushMicrotasks()
        await vi.advanceTimersByTimeAsync(0)

        expect(staleDispose).toHaveBeenCalledOnce()
        expect(createProvider).toHaveBeenCalledTimes(2)
        expect(createProvider).toHaveBeenLastCalledWith(config("http://collector-current"))
        expect(service.addProvider).toHaveBeenCalledOnce()
        expect(service.addProvider).toHaveBeenCalledWith(current)
    })

    it("suppresses an unavailable route and retries only after exponential backoff", async () => {
        const service = telemetry()
        const remote = registration()
        const probe = vi.fn().mockRejectedValueOnce(new Error("collector unavailable")).mockResolvedValue(undefined)
        const replay = vi.fn(async () => undefined)
        const createProvider = vi.fn(async () => remote)
        const reconciler = new RemoteOtelProviderReconciler(
            service,
            createProvider,
            options({ probe, replay, initialBackoffMs: 10, maxBackoffMs: 40 }),
        )

        reconciler.reconcile(config("http://collector-a"))
        await vi.advanceTimersByTimeAsync(0)

        expect(probe).toHaveBeenCalledOnce()
        expect(replay).not.toHaveBeenCalled()
        expect(createProvider).not.toHaveBeenCalled()
        expect(service.addProvider).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(9)
        expect(probe).toHaveBeenCalledOnce()

        await vi.advanceTimersByTimeAsync(1)
        expect(probe).toHaveBeenCalledTimes(2)
        expect(replay).toHaveBeenCalledOnce()
        expect(service.addProvider).toHaveBeenCalledWith(remote)
    })

    it("detaches an active route when a health probe fails and backs off", async () => {
        const service = telemetry()
        const probe = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("collector disconnected"))
        const reconciler = new RemoteOtelProviderReconciler(
            service,
            async () => registration(),
            options({ probe, healthyProbeIntervalMs: 100, initialBackoffMs: 10 }),
        )

        reconciler.reconcile(config("http://collector-a"))
        await vi.advanceTimersByTimeAsync(0)
        expect(service.addProvider).toHaveBeenCalledOnce()
        service.removeProvider.mockClear()

        await vi.advanceTimersByTimeAsync(100)

        expect(probe).toHaveBeenCalledTimes(2)
        expect(service.removeProvider).toHaveBeenCalledOnce()
        expect(service.removeProvider).toHaveBeenCalledWith(REMOTE_CONFIG_OTEL_PROVIDER_ID)

        await vi.advanceTimersByTimeAsync(9)
        expect(probe).toHaveBeenCalledTimes(2)
    })

    it("does not probe, replay, or construct a route while telemetry consent is disabled", async () => {
        const service = telemetry(() => false)
        const injected = options()
        const createProvider = vi.fn(async () => registration())
        const reconciler = new RemoteOtelProviderReconciler(service, createProvider, injected)

        reconciler.reconcile(config("http://collector-a"))
        await vi.advanceTimersByTimeAsync(1_000)

        expect(injected.probe).not.toHaveBeenCalled()
        expect(injected.replay).not.toHaveBeenCalled()
        expect(createProvider).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
    })

    it("aborts in-flight work and prevents replay or attachment after clear", async () => {
        const pending = deferred<void>()
        let observedSignal: AbortSignal | undefined
        const probe = vi.fn(async (_config: OpenTelemetryClientValidConfig, signal: AbortSignal) => {
            observedSignal = signal
            await pending.promise
        })
        const replay = vi.fn(async () => undefined)
        const service = telemetry()
        const createProvider = vi.fn(async () => registration())
        const reconciler = new RemoteOtelProviderReconciler(service, createProvider, options({ probe, replay }))

        reconciler.reconcile(config("http://collector-a"))
        await vi.advanceTimersByTimeAsync(0)
        expect(observedSignal?.aborted).toBe(false)

        reconciler.clear()
        expect(observedSignal?.aborted).toBe(true)
        pending.resolve(undefined)
        await flushMicrotasks()

        expect(replay).not.toHaveBeenCalled()
        expect(createProvider).not.toHaveBeenCalled()
        expect(service.addProvider).not.toHaveBeenCalled()
    })
})

describe("organization journal replay channel filter", () => {
    const line = (...channels: unknown[]) =>
        JSON.stringify({
            resourceLogs: [
                {
                    scopeLogs: [
                        {
                            logRecords: channels.map((channel) => ({
                                attributes: [{ key: "dline.channel", value: { stringValue: channel } }],
                            })),
                        },
                    ],
                },
            ],
        })

    it("replays only lines whose every record belongs to the usage channel the registration covers", () => {
        expect(organizationMayReceive(line("usage"))).toBe(true)
        expect(organizationMayReceive(line("usage", "usage"))).toBe(true)
        expect(organizationMayReceive(line("error"))).toBe(false)
        expect(organizationMayReceive(line("usage", "runtime"))).toBe(false)
        expect(organizationMayReceive(line(42))).toBe(false)
        expect(organizationMayReceive(JSON.stringify({ resourceLogs: [] }))).toBe(false)
        expect(organizationMayReceive("{partial")).toBe(false)
    })
})
