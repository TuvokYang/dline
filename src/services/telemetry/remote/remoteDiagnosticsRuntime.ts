import { randomUUID } from "node:crypto"
import path from "node:path"
import { DeviceCredentialRepository } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import { DiagnosticOutboxRepository } from "@/core/storage/telemetry-remote/DiagnosticOutboxRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { TelemetryProviderInput } from "../providers/capabilities"
import type { TelemetrySettings } from "../providers/ITelemetryProvider"
import { DeviceTokenBroker } from "./auth/DeviceTokenBroker"
import { DiagnosticDeliveryWorker } from "./diagnostics/DiagnosticDeliveryWorker"
import { type DiagnosticRecord, type DiagnosticResource, toDiagnosticRecord } from "./diagnostics/diagnosticRecord"
import { DlineOtelHttpClient } from "./transport/DlineOtelHttpClient"

/** Records gathered in memory are written to the shared outbox this often. */
export const DIAGNOSTICS_FLUSH_INTERVAL_MS = 5_000
/** One delivery attempt this often; the outbox decides whether anything is due. */
export const DIAGNOSTICS_DELIVERY_INTERVAL_MS = 20_000
/** Bound on records held in memory between flushes. */
const MAX_BUFFERED_RECORDS = 500

export interface RemoteDiagnosticsRuntimeOptions {
    /** `StorageContext.dataDir`; every remote telemetry file lives below it. */
    readonly dataDir: string
    readonly clientVersion: string
    readonly platform: string
    /** Which build this is and which editor hosts it, for the logs resource. */
    readonly releaseChannel?: DiagnosticResource["releaseChannel"]
    readonly hostEditor?: string
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
    readonly allowed: () => boolean
    readonly timers: ReturnType<typeof setInterval>[]
    readonly abort: AbortController
    buffer: DiagnosticRecord[]
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
    const transport = new DlineOtelHttpClient({ endpoint: options.endpoint })
    const credentials = new DeviceCredentialRepository(layout)
    const outbox = new DiagnosticOutboxRepository(path.join(layout.remoteDir, "diagnostics", "outbox.json"))
    const tokens = new DeviceTokenBroker({
        repository: credentials,
        transport,
        clientVersion: options.clientVersion,
        platform: options.platform,
        ownerId: owner,
    })
    const worker = new DiagnosticDeliveryWorker({
        outbox,
        tokens,
        transport,
        owner,
        resource: {
            clientVersion: options.clientVersion,
            platform: options.platform,
            ...(options.releaseChannel ? { releaseChannel: options.releaseChannel } : {}),
            ...(options.hostEditor ? { hostEditor: options.hostEditor } : {}),
        },
        log: options.log,
    })
    const state: RunningDiagnostics = {
        outbox,
        credentials,
        worker,
        allowed: options.allowed,
        timers: [],
        abort: new AbortController(),
        buffer: [],
        delivering: undefined,
        withdrawn: false,
    }
    running = state
    options.addProvider({
        kind: "registration",
        base: {
            name: "dline-remote-diagnostics",
            isEnabled: options.allowed,
            getSettings: options.hostSettings,
            forceFlush: () => flush(state),
            dispose: async () => undefined,
        },
        sink: { kind: "remote", origin: "user", channels: ["error", "runtime"] },
        capabilities: [
            {
                kind: "journal",
                append: (signal) => {
                    const record = toDiagnosticRecord(signal, Date.now())
                    if (!record || !state.allowed()) return
                    if (state.buffer.length >= MAX_BUFFERED_RECORDS) state.buffer.shift()
                    state.buffer.push(record)
                },
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
    every(DIAGNOSTICS_FLUSH_INTERVAL_MS, () => flush(state))
    every(DIAGNOSTICS_DELIVERY_INTERVAL_MS, () => deliver(state))
}

/**
 * Re-check whether diagnostics may leave the machine. When they may not, the
 * records waiting here and in the shared outbox are deleted, and so is the
 * production token; the usage token is left alone.
 */
export async function refreshRemoteDiagnostics(): Promise<void> {
    if (running) await reconcileConsent(running)
}

/** Stop the timers and write what was gathered; bounded, safe to call twice. */
export async function stopRemoteDiagnostics(): Promise<void> {
    const state = running
    if (!state) return
    running = undefined
    for (const timer of state.timers) clearInterval(timer)
    state.abort.abort()
    await flush(state).catch(() => undefined)
}

async function flush(state: RunningDiagnostics): Promise<void> {
    if (state.buffer.length === 0) return
    const records = state.buffer
    state.buffer = []
    if (!state.allowed()) return
    await state.outbox.append(records)
}

/**
 * Every delivery round re-checks consent too, so a change that arrives without a
 * refresh call, such as organization policy, still withdraws what is waiting.
 */
function deliver(state: RunningDiagnostics): Promise<void> {
    state.delivering ??= (async () => {
        if (await reconcileConsent(state)) await state.worker.deliverOnce(state.abort.signal)
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
    await state.outbox.clear()
    await state.credentials.clearTokens(["production"])
    state.withdrawn = true
    return false
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
