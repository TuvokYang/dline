import { randomUUID } from "node:crypto"
import path from "node:path"
import { DeviceCredentialRepository } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import { DiagnosticOutboxRepository } from "@/core/storage/telemetry-remote/DiagnosticOutboxRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { TelemetryProviderInput } from "../providers/capabilities"
import type { TelemetrySettings } from "../providers/ITelemetryProvider"
import { createDeviceTokenBroker } from "./auth/exchangeRuntime"
import { OTLP_ADMISSION } from "./contracts/otlpProduction"
import { DiagnosticDeliveryWorker } from "./diagnostics/DiagnosticDeliveryWorker"
import {
    aggregateDiagnostics,
    type DiagnosticRecord,
    type DiagnosticResource,
    encodeDiagnosticLogs,
    toDiagnosticRecord,
} from "./diagnostics/diagnosticRecord"
import { IssueDiagnosticsOverlay } from "./diagnostics/IssueDiagnosticsOverlay"
import { ProductionSignalChannels } from "./productionSignalChannels"
import { DlineOtelHttpClient } from "./transport/DlineOtelHttpClient"

/** Records gathered in memory are written to the shared outbox this often. */
export const DIAGNOSTICS_FLUSH_INTERVAL_MS = 5_000
/** One delivery attempt this often; the outbox decides whether anything is due. */
export const DIAGNOSTICS_DELIVERY_INTERVAL_MS = 20_000
/** Metrics close one delta window this often (TADR §7.2). */
export const METRICS_EXPORT_INTERVAL_MS = OTLP_ADMISSION.metricsIntervalMs
/** Bound on distinct records held in memory between flushes; repeats of one merge and never count. */
const MAX_BUFFERED_RECORDS = 500

export interface RemoteDiagnosticsRuntimeOptions {
    /** `StorageContext.dataDir`; every remote telemetry file lives below it. */
    readonly dataDir: string
    /** The one version this host reports: user agent, device exchange and the logs resource `service.version`. */
    readonly clientVersion: string
    readonly platform: string
    /** `process.arch`; the resource reports it as the semconv `host.arch`. */
    readonly arch?: string
    /** Which build this is and which editor hosts it, for the logs resource. */
    readonly releaseChannel?: DiagnosticResource["releaseChannel"]
    readonly hostEditor?: DiagnosticResource["hostEditor"]
    /** A development build; the logs resource then carries `dline.is_dev`. */
    readonly isDev?: boolean
    /** Whether error reporting may leave the machine now: consent, organization and host level. */
    readonly allowed: () => boolean
    /** The host telemetry settings, used by the shared policy for severity filtering. */
    readonly hostSettings: () => TelemetrySettings
    /** Registers the provider with the canonical telemetry pipeline. */
    readonly addProvider: (provider: TelemetryProviderInput) => void
    readonly endpoint?: string
    readonly log?: (message: string) => void
}

interface RunningDiagnostics {
    readonly outbox: DiagnosticOutboxRepository
    readonly credentials: DeviceCredentialRepository
    readonly worker: DiagnosticDeliveryWorker
    /** The production Metrics and Traces channels. */
    readonly signals: ProductionSignalChannels
    readonly overlay: IssueDiagnosticsOverlay
    readonly allowed: () => boolean
    readonly timers: ReturnType<typeof setInterval>[]
    readonly abort: AbortController
    buffer: DiagnosticRecord[]
    /** Records the full buffer could not take since the last flush, reported as dropped. */
    bufferDropped: number
    delivering: Promise<void> | undefined
    /** Set once withdrawn consent has removed the waiting records and the token. */
    withdrawn: boolean
}

let running: RunningDiagnostics | undefined

/**
 * Compose and start error and runtime diagnostics for this extension host; a
 * second call is ignored. Records reach the service through a machine-wide
 * outbox with its own production token, apart from usage reporting.
 */
export function startRemoteDiagnostics(options: RemoteDiagnosticsRuntimeOptions): void {
    if (running) return
    const layout = resolveOtelStorageLayout(options.dataDir)
    const owner = `${process.pid}-${randomUUID().slice(0, 8)}`
    const transport = new DlineOtelHttpClient({ clientVersion: options.clientVersion, endpoint: options.endpoint })
    const credentials = new DeviceCredentialRepository(layout)
    const resource: DiagnosticResource = {
        clientVersion: options.clientVersion,
        platform: options.platform,
        ...(options.arch ? { arch: options.arch } : {}),
        ...(options.releaseChannel ? { releaseChannel: options.releaseChannel } : {}),
        ...(options.hostEditor ? { hostEditor: options.hostEditor } : {}),
        ...(options.isDev ? { isDev: true } : {}),
    }
    const outbox = new DiagnosticOutboxRepository(diagnosticOutboxPath(options.dataDir), {
        encode: (records, dropped) => encodeDiagnosticLogs(records, resource, dropped),
        quarantineDir: layout.remoteQuarantineDir,
    })
    const tokens = createDeviceTokenBroker({
        layout,
        credentials,
        transport,
        clientVersion: options.clientVersion,
        platform: options.platform,
        ownerId: owner,
    })
    const worker = new DiagnosticDeliveryWorker({
        outbox,
        tokens,
        send: (delivery, signal) => transport.sendLogs(delivery, signal),
        owner,
        label: "diagnostics",
        log: options.log,
    })
    const overlay = new IssueDiagnosticsOverlay({ layout, resource, transport, allowed: options.allowed })
    const signals = new ProductionSignalChannels({
        remoteDir: layout.remoteDir,
        resource,
        tokens,
        transport,
        owner,
        allowed: options.allowed,
        log: options.log,
    })
    const state: RunningDiagnostics = {
        outbox,
        credentials,
        worker,
        signals,
        overlay,
        allowed: options.allowed,
        timers: [],
        abort: new AbortController(),
        buffer: [],
        bufferDropped: 0,
        delivering: undefined,
        withdrawn: false,
    }
    running = state
    signals.sessionStarted()
    options.addProvider({
        kind: "registration",
        base: {
            name: "dline-remote-diagnostics",
            isEnabled: options.allowed,
            getSettings: options.hostSettings,
            forceFlush: async () => {
                await flush(state)
                await state.signals.flush()
                await state.overlay.flush()
            },
            dispose: async () => undefined,
        },
        sink: { kind: "remote", origin: "user", channels: ["error", "runtime"] },
        capabilities: [
            {
                kind: "journal",
                append: (signal) => {
                    state.overlay.append(signal)
                    state.signals.observe(signal)
                    const record = toDiagnosticRecord(signal, Date.now())
                    if (!record || !state.allowed()) return
                    // A storm of one failure stays one record; the outbox applies the device limits.
                    const room = () => state.buffer.length < MAX_BUFFERED_RECORDS
                    const merged = aggregateDiagnostics(state.buffer, [record], room)
                    state.buffer = merged.records
                    state.bufferDropped += merged.refused
                    state.signals.recordDropped("logs", merged.refused)
                },
            },
            {
                kind: "trace",
                // The production span names the identity; the issue overlay mirrors it.
                startSpan: (spanOptions) =>
                    state.signals.startSpan(spanOptions, (identity) =>
                        state.overlay.startSpan({ ...spanOptions, spanContext: identity }),
                    ),
            },
        ],
    })
    const every = (intervalMs: number, work: () => Promise<void>) => {
        const timer = setInterval(() => {
            void work().catch((error: unknown) => options.log?.(`[RemoteDiagnostics] ${describe(error)}`))
        }, intervalMs)
        timer.unref?.()
        state.timers.push(timer)
    }
    every(DIAGNOSTICS_FLUSH_INTERVAL_MS, async () => {
        await flush(state)
        await state.signals.flush()
        await state.overlay.flush()
    })
    every(METRICS_EXPORT_INTERVAL_MS, () => state.signals.exportMetrics())
    every(DIAGNOSTICS_DELIVERY_INTERVAL_MS, async () => {
        await deliver(state)
        await state.overlay.deliver()
    })
    void state.overlay.refresh().catch((error: unknown) => options.log?.(`[RemoteDiagnostics] ${describe(error)}`))
}

/**
 * Re-check whether diagnostics may leave the machine. When they may not, the
 * records waiting here and in the shared outbox are deleted, and so is the
 * production token; the usage token is left alone.
 */
export async function refreshRemoteDiagnostics(): Promise<void> {
    if (!running) return
    await reconcileConsent(running)
    await running.overlay.refresh()
}

/** Re-read the owner-only approved grant after status/exchange publication. */
export async function refreshIssueDiagnosticsOverlay(): Promise<void> {
    await running?.overlay.refresh()
}

/** Local-first terminal boundary used before issue token removal or remote revoke. */
export async function purgeIssueDiagnosticsOverlay(
    reason: "revoked" | "expired" | "revision_changed" | "deleted",
): Promise<void> {
    await running?.overlay.deactivate(reason)
}

/** Stop the timers and write what was gathered; bounded, safe to call twice. */
export async function stopRemoteDiagnostics(): Promise<void> {
    const state = running
    if (!state) return
    running = undefined
    for (const timer of state.timers) clearInterval(timer)
    state.abort.abort()
    await state.overlay.stop()
    await flush(state).catch(() => undefined)
    await state.signals.flush().catch(() => undefined)
    // The open window is closed into the outbox, so the next start sends it.
    await state.signals.exportMetrics().catch(() => undefined)
}

async function flush(state: RunningDiagnostics): Promise<void> {
    if (state.buffer.length === 0 && state.bufferDropped === 0) return
    const records = state.buffer
    const dropped = state.bufferDropped
    state.buffer = []
    state.bufferDropped = 0
    if (!state.allowed()) return
    await state.outbox.append(records, Date.now(), dropped)
}

/** The shared outbox of this data root; tests read it through the same path. */
export function diagnosticOutboxPath(dataDir: string): string {
    return path.join(diagnosticsDir(dataDir), "outbox.json")
}

function diagnosticsDir(dataDir: string): string {
    return path.join(resolveOtelStorageLayout(dataDir).remoteDir, "diagnostics")
}

/**
 * Every delivery round re-checks consent too, so a change that arrives without a
 * refresh call, such as organization policy, still withdraws what is waiting.
 */
function deliver(state: RunningDiagnostics): Promise<void> {
    state.delivering ??= (async () => {
        if (!(await reconcileConsent(state))) return
        await state.worker.deliverOnce(state.abort.signal)
        await state.signals.deliver(state.abort.signal)
    })().finally(() => {
        state.delivering = undefined
    })
    return state.delivering
}

/** Returns whether diagnostics may be sent; withdraws waiting data once when not. */
async function reconcileConsent(state: RunningDiagnostics): Promise<boolean> {
    if (state.allowed()) {
        state.withdrawn = false
        return true
    }
    if (state.withdrawn) return false
    state.buffer = []
    state.bufferDropped = 0
    await Promise.all([state.outbox.clear(), state.signals.clear()])
    await state.credentials.clearTokens(["production"])
    state.withdrawn = true
    return false
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
