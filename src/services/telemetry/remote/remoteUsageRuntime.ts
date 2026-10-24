import { randomUUID } from "node:crypto"
import { ModelRegistry } from "@/core/model-registry/ModelRegistry"
import { DeviceCredentialRepository } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import { ExchangeOperationRepository } from "@/core/storage/telemetry-remote/ExchangeOperationRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { LocalUsagePolicyInputs } from "@/core/storage/telemetry-remote/RemotePolicyRepository"
import { RemotePolicyRepository } from "@/core/storage/telemetry-remote/RemotePolicyRepository"
import { UsageObservationSpool } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import { UsageOutboxRepository } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import { installTaskUsageAccountingSink } from "@/core/task/observability/task-usage-accounting"
import { projectProviderUsageModelId } from "@/core/task/performance/provider-request-round-port"
import { deviceGrantPortFromRepository } from "./auth/DeviceGrantPort"
import { DeviceGrantPortRegistry } from "./auth/DeviceGrantPortRegistry"
import { DeviceTokenBroker } from "./auth/DeviceTokenBroker"
import { installRecoverableExchange } from "./auth/exchangeRuntime"
import { UsageGrantBootstrap } from "./auth/UsageGrantBootstrap"
import { estimateUsageWriteRowsV4, sanitizeUsageClient, type UsageClientWire } from "./contracts/usageBody"
import { DlineOtelHttpClient } from "./transport/DlineOtelHttpClient"
import { RemoteUsageCoordinator } from "./usage/RemoteUsageCoordinator"
import { UsageDeliveryWorker } from "./usage/UsageDeliveryWorker"
import type { RemoteUsageLog } from "./usage/usageCycleLog"

export interface RemoteUsageRuntimeOptions {
    /** `StorageContext.dataDir`; every remote telemetry file lives below it. */
    readonly dataDir: string
    readonly readPolicyInputs: () => Promise<LocalUsagePolicyInputs>
    /** The one version this host reports: user agent, device exchange and `client.version` of every batch. */
    readonly clientVersion: string
    readonly platform: string
    /** The rest of the `client` section of every batch; a value the service would refuse is left out. */
    readonly client: { readonly [K in Exclude<keyof UsageClientWire, "version">]?: unknown }
    /** Service origin; defaults to `https://otel.dline.cc`. Loopback HTTP is allowed for the contract smoke. */
    readonly endpoint?: string
    readonly log?: RemoteUsageLog
}

let coordinator: RemoteUsageCoordinator | undefined
let tokenBroker: DeviceTokenBroker | undefined
let releaseTaskUsageAccounting: (() => void) | undefined
const reportingListeners = new Set<() => void>()

/** Compose and start remote usage reporting for this extension host; a second call is ignored. */
export async function startRemoteUsage(options: RemoteUsageRuntimeOptions): Promise<void> {
    if (coordinator) return
    const client = sanitizeUsageClient({ ...options.client, version: options.clientVersion })
    if (!client) {
        // Every batch states the version its user agent names; without a valid one no batch is valid.
        options.log?.("warn", "[RemoteUsage] not started: the extension version is not a valid client version")
        return
    }
    const layout = resolveOtelStorageLayout(options.dataDir)
    // One identity per extension host: it names the observation shard and the sender lease owner.
    const ownerId = `${process.pid}-${randomUUID().slice(0, 8)}`
    // A quarantine resets that document's state; the usual cause is another Dline build writing a
    // version this one cannot read, and without this line the reset would look like nothing happened.
    const onQuarantine = (documentName: string) =>
        options.log?.(
            "warn",
            `[RemoteUsage] ${documentName} could not be read (damaged, or written by an incompatible Dline build) and was moved to quarantine; its state starts over`,
        )
    const transport = new DlineOtelHttpClient({ clientVersion: client.version, endpoint: options.endpoint })
    const credentials = new DeviceCredentialRepository(layout, { onQuarantine })
    const outbox = new UsageOutboxRepository(layout, {
        onQuarantine,
        // A hand-over is routine every turn; a takeover means another build kept the lease past its turn.
        onSenderTurn: (event) =>
            event.kind === "yielded"
                ? options.log?.("debug", "[RemoteUsage] sender turn over; the lease goes to the next waiting window")
                : options.log?.(
                      "info",
                      `[RemoteUsage] took the sender lease (generation ${event.generation}) from a window that kept it past its turn`,
                  ),
    })
    const spool = new UsageObservationSpool(layout, ownerId)
    const grantPort = deviceGrantPortFromRepository(credentials)
    const bootstrap = new UsageGrantBootstrap({
        port: grantPort,
        transport,
        clientVersion: options.clientVersion,
        platform: options.platform,
    })
    const grantRegistry = new DeviceGrantPortRegistry(grantPort, bootstrap)
    installRecoverableExchange({
        registry: grantRegistry,
        expectedBootstrap: bootstrap,
        repository: new ExchangeOperationRepository(layout, { onQuarantine }),
        transport,
        clientVersion: options.clientVersion,
        platform: options.platform,
    })
    const tokens = new DeviceTokenBroker({
        repository: credentials,
        transport,
        clientVersion: options.clientVersion,
        platform: options.platform,
        ownerId,
        grantClient: grantRegistry,
    })
    const worker = new UsageDeliveryWorker({
        outbox,
        spool,
        tokens,
        transport,
        client,
        ownerId,
        readAttemptValidation: async () => {
            const grant = await credentials.readActiveDeviceGrant(Date.now(), "usage")
            return grant ? { contract: grant.usageContract, estimateWriteRows: estimateUsageWriteRowsV4 } : undefined
        },
    })
    const started = new RemoteUsageCoordinator({
        policy: new RemotePolicyRepository(layout, { onQuarantine }),
        credentials,
        outbox,
        spool,
        worker,
        readPolicyInputs: options.readPolicyInputs,
        log: options.log,
        onReportingChanged: notifyReportingListeners,
    })
    coordinator = started
    tokenBroker = tokens
    releaseTaskUsageAccounting = installTaskUsageAccountingSink({
        currentPolicyGeneration: () => started.activePolicyGeneration,
        projectModelId: (provider, wireModelId) =>
            projectProviderUsageModelId(ModelRegistry.getInstance(), provider, wireModelId),
        recordFinalizedAttempt: (attempt) => started.recordFinalizedAttempt(attempt),
    })
    options.log?.("debug", `[RemoteUsage] starting in ${ownerId}, reporting to ${transport.origin}`)
    await started.start()
    started.recordSessionStarted()
}

/**
 * Whether this extension host may report usage now. Services that ride on the
 * usage consent, such as the feature rollout, take part only while it holds.
 * It is `false` until startup has resolved the policy.
 */
export function usageReportingAllowed(): boolean {
    return coordinator?.reportingAllowed === true
}

/**
 * The device id the usage service issued, for services that ride on the usage
 * consent, or `undefined` while this device may not report usage or has not
 * been enrolled yet. It names the same device as the usage it reports. Only the
 * id leaves: the bearer token is a usage write credential and is sent to the
 * usage service alone.
 */
export async function acquireUsageDeviceId(signal?: AbortSignal): Promise<string | undefined> {
    const running = coordinator
    const tokens = tokenBroker
    if (!running?.reportingAllowed || !tokens) return undefined
    const acquisition = await tokens.acquire("usage", { signal })
    return acquisition.status === "ready" ? acquisition.token.deviceId : undefined
}

/**
 * Called whenever {@link usageReportingAllowed} changes: at startup, after a
 * consent or organization change, or when a delivery cycle finds a different
 * policy. Returns the unsubscribe function.
 */
export function onUsageReportingChanged(listener: () => void): () => void {
    reportingListeners.add(listener)
    return () => reportingListeners.delete(listener)
}

/** Re-resolve the policy after a consent, organization or host telemetry change. */
export async function refreshRemoteUsagePolicy(): Promise<void> {
    await coordinator?.refresh()
}

function notifyReportingListeners(): void {
    for (const listener of reportingListeners) listener()
}

/** Stop intake and delivery and hand the sender lease back; bounded, safe to call twice. */
export async function stopRemoteUsage(): Promise<void> {
    const running = coordinator
    releaseTaskUsageAccounting?.()
    releaseTaskUsageAccounting = undefined
    coordinator = undefined
    tokenBroker = undefined
    await running?.dispose()
}
