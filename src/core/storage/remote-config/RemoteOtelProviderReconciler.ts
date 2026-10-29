import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { getDlineDataDir } from "@/core/storage/disk"
import { telemetryService } from "@/services/telemetry"
import type { TelemetryProviderRegistration } from "@/services/telemetry/providers/capabilities"
import { adaptLegacyTelemetryProvider } from "@/services/telemetry/providers/LegacyTelemetryProviderAdapter"
import { OpenTelemetryClientProvider } from "@/services/telemetry/providers/opentelemetry/OpenTelemetryClientProvider"
import { OpenTelemetryTelemetryProvider } from "@/services/telemetry/providers/opentelemetry/OpenTelemetryTelemetryProvider"
import type { TelemetryService } from "@/services/telemetry/TelemetryService"
import { fetch } from "@/shared/net"
import type { OpenTelemetryClientValidConfig } from "@/shared/services/config/otel-config"
import { Logger } from "@/shared/services/Logger"
import { readJsonWithBackup, writeJsonAtomic } from "@/shared/storage/atomic-file"

export const REMOTE_CONFIG_OTEL_PROVIDER_ID = "OpenTelemetryRemoteConfiguredProvider"

const PROBE_TIMEOUT_MS = 3_000
const HEALTHY_PROBE_INTERVAL_MS = 15_000
const INITIAL_BACKOFF_MS = 5_000
const MAX_BACKOFF_MS = 5 * 60_000
const MAX_REPLAY_RECORDS = 32

type TelemetryProviderPort = Pick<TelemetryService, "addProvider" | "removeProvider" | "isEnabled">
type TelemetryProviderSource = TelemetryProviderPort | (() => TelemetryProviderPort)
type RemoteOtelProviderFactory = (config: OpenTelemetryClientValidConfig) => Promise<TelemetryProviderRegistration | undefined>
type RemoteOtelProbe = (config: OpenTelemetryClientValidConfig, signal: AbortSignal) => Promise<void>
type RemoteOtelReplay = (config: OpenTelemetryClientValidConfig, signal: AbortSignal) => Promise<void>

export interface RemoteOtelProviderReconcilerOptions {
    readonly probe?: RemoteOtelProbe
    readonly replay?: RemoteOtelReplay
    readonly probeTimeoutMs?: number
    readonly healthyProbeIntervalMs?: number
    readonly initialBackoffMs?: number
    readonly maxBackoffMs?: number
}

/** Supervises the optional organization collector without joining it to product work. */
export class RemoteOtelProviderReconciler {
    private generation = 0
    private timer: ReturnType<typeof setTimeout> | undefined
    private inFlight: Promise<void> | undefined
    private abort: AbortController | undefined
    private config: OpenTelemetryClientValidConfig | undefined
    private backoffMs: number
    private routeAttached = false
    private readonly probe: RemoteOtelProbe
    private readonly replay: RemoteOtelReplay
    private readonly probeTimeoutMs: number
    private readonly healthyProbeIntervalMs: number
    private readonly initialBackoffMs: number
    private readonly maxBackoffMs: number

    constructor(
        private readonly telemetrySource: TelemetryProviderSource,
        private readonly createProvider: RemoteOtelProviderFactory = createRemoteOtelProvider,
        options: RemoteOtelProviderReconcilerOptions = {},
    ) {
        this.probe = options.probe ?? probeRemoteCollector
        this.replay = options.replay ?? replayLocalJournal
        this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS
        this.healthyProbeIntervalMs = options.healthyProbeIntervalMs ?? HEALTHY_PROBE_INTERVAL_MS
        this.initialBackoffMs = options.initialBackoffMs ?? INITIAL_BACKOFF_MS
        this.backoffMs = this.initialBackoffMs
        this.maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS
    }

    reconcile(config: OpenTelemetryClientValidConfig | undefined): void {
        this.stopCurrentRoute()
        this.config = config
        this.backoffMs = this.initialBackoffMs
        const generation = ++this.generation
        if (!config || !this.telemetry().isEnabled()) return
        this.schedule(0, generation)
    }

    clear(): void {
        this.config = undefined
        this.stopCurrentRoute()
        this.generation++
    }

    private schedule(delayMs: number, generation: number): void {
        this.timer = setTimeout(() => {
            this.timer = undefined
            void this.runProbe(generation)
        }, delayMs)
        this.timer.unref?.()
    }

    private runProbe(generation: number): Promise<void> {
        if (this.inFlight) {
            return this.inFlight.finally(() => {
                if (generation === this.generation && this.config && !this.timer && this.telemetry().isEnabled()) {
                    this.schedule(0, generation)
                }
            })
        }
        const config = this.config
        if (!config || generation !== this.generation) return Promise.resolve()
        if (!this.telemetry().isEnabled()) {
            this.detachRoute()
            return Promise.resolve()
        }
        const abort = new AbortController()
        this.abort = abort
        const timeout = setTimeout(() => abort.abort(), this.probeTimeoutMs)
        timeout.unref?.()
        this.inFlight = (async () => {
            try {
                await this.probe(config, abort.signal)
                if (generation !== this.generation || abort.signal.aborted || !this.telemetry().isEnabled()) return
                await this.replay(config, abort.signal)
                if (generation !== this.generation || abort.signal.aborted || !this.telemetry().isEnabled()) return
                if (!this.routeAttached) {
                    const registration = await this.createProvider(config)
                    if (!registration || generation !== this.generation || !this.telemetry().isEnabled()) {
                        await registration?.base.dispose().catch(() => undefined)
                        return
                    }
                    this.telemetry().addProvider(registration)
                    this.routeAttached = true
                }
                this.backoffMs = this.initialBackoffMs
                this.schedule(this.healthyProbeIntervalMs, generation)
            } catch (error) {
                if (generation !== this.generation) return
                this.detachRoute()
                Logger.warn("[RemoteConfig] OTEL collector unavailable; remote route suppressed", error)
                const delay = this.backoffMs
                this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs)
                this.schedule(delay, generation)
            } finally {
                clearTimeout(timeout)
                if (this.abort === abort) this.abort = undefined
                this.inFlight = undefined
            }
        })()
        return this.inFlight
    }

    private stopCurrentRoute(): void {
        if (this.timer) clearTimeout(this.timer)
        this.timer = undefined
        this.abort?.abort()
        this.abort = undefined
        this.detachRoute()
    }

    private detachRoute(): void {
        this.telemetry().removeProvider(REMOTE_CONFIG_OTEL_PROVIDER_ID)
        this.routeAttached = false
    }

    private telemetry(): TelemetryProviderPort {
        return typeof this.telemetrySource === "function" ? this.telemetrySource() : this.telemetrySource
    }
}

async function createRemoteOtelProvider(
    config: OpenTelemetryClientValidConfig,
): Promise<TelemetryProviderRegistration | undefined> {
    const client = new OpenTelemetryClientProvider(config)
    if (!client.meterProvider && !client.loggerProvider) {
        await client.dispose()
        return undefined
    }
    try {
        const provider = await new OpenTelemetryTelemetryProvider(client.meterProvider, client.loggerProvider, {
            name: REMOTE_CONFIG_OTEL_PROVIDER_ID,
            owner: client,
        }).initialize()
        return adaptLegacyTelemetryProvider(provider, {
            sink: { kind: "remote", origin: "organization", channels: ["usage"] },
        })
    } catch (error) {
        await client.dispose().catch(() => undefined)
        throw error
    }
}

async function probeRemoteCollector(config: OpenTelemetryClientValidConfig, signal: AbortSignal): Promise<void> {
    const endpoint = signalEndpoint(config, "usage")
    if (!endpoint || !isHttpProtocol(config)) return
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(config.otlpHeaders ?? {}) },
        body: JSON.stringify({ resourceLogs: [] }),
        signal,
    })
    await response.body?.cancel().catch(() => undefined)
    if (response.status >= 500) throw new Error(`Collector probe failed with HTTP ${response.status}`)
}

async function replayLocalJournal(config: OpenTelemetryClientValidConfig, signal: AbortSignal): Promise<void> {
    if (!isHttpProtocol(config)) return
    const directory = join(getDlineDataDir(), "telemetry", "sessions")
    let files: string[]
    try {
        files = (await readdir(directory)).filter((file) => /^(usage|metrics|traces)-.+\.jsonl$/.test(file)).sort()
    } catch {
        return
    }
    const cursorPath = join(getDlineDataDir(), "telemetry", "remote-replay-state.json")
    const cursorRead = await readJsonWithBackup(cursorPath, parseReplayCursor).catch(() => ({ status: "missing" }) as const)
    const cursor: Record<string, number> =
        cursorRead.status === "primary" || cursorRead.status === "backup" ? { ...cursorRead.value } : {}
    // A line of another channel is passed over, never sent: its cursor still advances.
    const pending: Array<{ cursorKey: string; next: number; endpoint: string; payload: string | undefined }> = []
    for (const file of files) {
        const kind = file.startsWith("metrics-") ? "metrics" : file.startsWith("traces-") ? "traces" : "usage"
        const endpoint = signalEndpoint(config, kind)
        if (!endpoint) continue
        const cursorKey = `${endpointFingerprint(endpoint)}:${file}`
        const lines = (await readFile(join(directory, file), "utf8")).split("\n").filter(Boolean)
        const start = Math.min(cursor[cursorKey] ?? 0, lines.length)
        for (let index = start; index < lines.length && pending.length < MAX_REPLAY_RECORDS; index++) {
            const payload = organizationMayReceive(lines[index]) ? lines[index] : undefined
            pending.push({ cursorKey, next: index + 1, endpoint, payload })
        }
        if (pending.length >= MAX_REPLAY_RECORDS) break
    }
    for (const record of pending) {
        if (record.payload !== undefined) {
            const response = await fetch(record.endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", ...(config.otlpHeaders ?? {}) },
                body: record.payload,
                signal,
            })
            await response.body?.cancel().catch(() => undefined)
            if (!response.ok) throw new Error(`Collector replay failed with HTTP ${response.status}`)
        }
        cursor[record.cursorKey] = record.next
    }
    if (pending.length > 0) await writeJsonAtomic(cursorPath, cursor)
}

/**
 * The organization collector is registered for the usage channel only, yet the
 * journal's usage file also holds error and runtime records, and its metrics
 * and traces files hold runtime signals. A journal line is replayed only when
 * every record in it names a channel the registration covers.
 */
const ORGANIZATION_REPLAY_CHANNELS: ReadonlySet<string> = new Set(["usage"])

export function organizationMayReceive(payload: string): boolean {
    let parsed: unknown
    try {
        parsed = JSON.parse(payload)
    } catch {
        return false
    }
    const channels = new Set<string>()
    collectChannels(parsed, channels)
    return channels.size > 0 && [...channels].every((channel) => ORGANIZATION_REPLAY_CHANNELS.has(channel))
}

function collectChannels(value: unknown, into: Set<string>): void {
    if (Array.isArray(value)) {
        for (const entry of value) collectChannels(entry, into)
        return
    }
    if (!value || typeof value !== "object") return
    const record = value as Record<string, unknown>
    if (record.key === "dline.channel") {
        const channel = (record.value as { stringValue?: unknown } | undefined)?.stringValue
        // A channel attribute that is not a string cannot be checked, so the line is not replayed.
        into.add(typeof channel === "string" ? channel : "")
    }
    for (const entry of Object.values(record)) collectChannels(entry, into)
}

function parseReplayCursor(value: unknown): Record<string, number> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid OTEL replay cursor")
    return Object.fromEntries(
        Object.entries(value).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isInteger(entry[1]) && entry[1] >= 0,
        ),
    )
}

function endpointFingerprint(endpoint: string): string {
    return createHash("sha256").update(endpoint).digest("hex")
}

function isHttpProtocol(config: OpenTelemetryClientValidConfig): boolean {
    return (config.otlpProtocol ?? "grpc").startsWith("http/")
}

function signalEndpoint(config: OpenTelemetryClientValidConfig, kind: "usage" | "metrics" | "traces"): string | undefined {
    const explicit = kind === "metrics" ? config.otlpMetricsEndpoint : kind === "traces" ? undefined : config.otlpLogsEndpoint
    const base = explicit ?? config.otlpEndpoint
    if (!base) return undefined
    const suffix = kind === "metrics" ? "/v1/metrics" : kind === "traces" ? "/v1/traces" : "/v1/logs"
    return base.endsWith(suffix) ? base : `${base.replace(/\/$/, "")}${suffix}`
}

export const remoteOtelProviderReconciler = new RemoteOtelProviderReconciler(() => telemetryService)
