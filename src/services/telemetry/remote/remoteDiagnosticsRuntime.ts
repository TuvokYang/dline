import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import path from "node:path"
import { backupPathOf } from "@shared/storage/atomic-file"
import { DeviceCredentialRepository } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import { DiagnosticOutboxRepository } from "@/core/storage/telemetry-remote/DiagnosticOutboxRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { TelemetryProviderInput } from "../providers/capabilities"
import type { TelemetrySettings } from "../providers/ITelemetryProvider"
import { DeviceTokenBroker } from "./auth/DeviceTokenBroker"
import { DiagnosticDeliveryWorker } from "./diagnostics/DiagnosticDeliveryWorker"
import {
    aggregateDiagnostics,
    type DiagnosticRecord,
    type DiagnosticResource,
    encodeDiagnosticLogs,
    toDiagnosticRecord,
} from "./diagnostics/diagnosticRecord"
import { DlineOtelHttpClient } from "./transport/DlineOtelHttpClient"

/** Records gathered in memory are written to the shared outbox this often. */
export const DIAGNOSTICS_FLUSH_INTERVAL_MS = 5_000
/** One delivery attempt this often; the outbox decides whether anything is due. */
export const DIAGNOSTICS_DELIVERY_INTERVAL_MS = 20_000
/** Bound on distinct records held in memory between flushes; repeats of one merge and never count. */
const MAX_BUFFERED_RECORDS = 500

export interface RemoteDiagnosticsRuntimeOptions {
    /** `StorageContext.dataDir`; every remote telemetry file lives below it. */
    readonly dataDir: string
    /** The one version this host reports: user agent, device exchange and the logs resource `service.version`. */
    readonly clientVersion: string
    readonly platform: string
    /** Which build this is and which editor hosts it, for the logs resource. */
    readonly releaseChannel?: DiagnosticResource["releaseChannel"]
    readonly hostEditor?: DiagnosticResource["hostEditor"]
    /** A development build, so the service can keep its records out of the statistics. */
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
    readonly allowed: () => boolean
    readonly timers: ReturnType<typeof setInterval>[]
    readonly abort: AbortController
    /** Where builds before the stable name queued their records; absorbed into the outbox and removed. */
    readonly legacyOutboxPath: string
    /** The running retirement of that queue; shutdown waits for it so no lock outlives the window. */
    retiring?: Promise<void>
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
        ...(options.releaseChannel ? { releaseChannel: options.releaseChannel } : {}),
        ...(options.hostEditor ? { hostEditor: options.hostEditor } : {}),
        ...(options.isDev ? { isDev: true } : {}),
    }
    const outbox = new DiagnosticOutboxRepository(diagnosticOutboxPath(options.dataDir), {
        encode: (records, dropped) => encodeDiagnosticLogs(records, resource, dropped),
    })
    const tokens = new DeviceTokenBroker({
        repository: credentials,
        transport,
        clientVersion: options.clientVersion,
        platform: options.platform,
        ownerId: owner,
    })
    const worker = new DiagnosticDeliveryWorker({ outbox, tokens, transport, owner, log: options.log })
    const state: RunningDiagnostics = {
        outbox,
        credentials,
        worker,
        allowed: options.allowed,
        timers: [],
        abort: new AbortController(),
        legacyOutboxPath: legacyDiagnosticOutboxPath(options.dataDir),
        buffer: [],
        bufferDropped: 0,
        delivering: undefined,
        withdrawn: false,
    }
    running = state
    void removeLegacyOutbox(state).catch((error: unknown) => options.log?.(`[RemoteDiagnostics] ${describe(error)}`))
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
                    // A storm of one failure stays one record; the outbox applies the device limits.
                    const room = () => state.buffer.length < MAX_BUFFERED_RECORDS
                    const merged = aggregateDiagnostics(state.buffer, [record], room)
                    state.buffer = merged.records
                    state.bufferDropped += merged.refused
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
    await state.retiring?.catch(() => undefined)
    await flush(state).catch(() => undefined)
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

/** The name 0.11 builds before the stable name used; it is only ever read to move its records over. */
export function legacyDiagnosticOutboxPath(dataDir: string): string {
    return path.join(diagnosticsDir(dataDir), "outbox-v2.json")
}

function diagnosticsDir(dataDir: string): string {
    return path.join(resolveOtelStorageLayout(dataDir).remoteDir, "diagnostics")
}

/**
 * Retire the earlier queue: its records move into the outbox while reporting is
 * allowed, and are deleted with it once reporting is withdrawn. A window of an
 * earlier build that still runs keeps sending from it; the next start moves
 * what it leaves.
 */
function removeLegacyOutbox(state: RunningDiagnostics): Promise<void> {
    const retiring = state.allowed()
        ? state.outbox.absorb(state.legacyOutboxPath, Date.now())
        : Promise.all([
              rm(state.legacyOutboxPath, { force: true }),
              rm(backupPathOf(state.legacyOutboxPath), { force: true }),
          ]).then(() => undefined)
    state.retiring = retiring
    return retiring
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
    state.bufferDropped = 0
    // An absorb started while reporting was allowed would write the earlier queue's records back after the clear.
    await state.retiring?.catch(() => undefined)
    await Promise.all([state.outbox.clear(), removeLegacyOutbox(state)])
    await state.credentials.clearTokens(["production"])
    state.withdrawn = true
    return false
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
