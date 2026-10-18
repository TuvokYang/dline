import { randomUUID } from "node:crypto"
import { DeviceCredentialRepository } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { LocalUsagePolicyInputs } from "@/core/storage/telemetry-remote/RemotePolicyRepository"
import { RemotePolicyRepository } from "@/core/storage/telemetry-remote/RemotePolicyRepository"
import { SEALED_SHARD_SETTLE_MS, UsageObservationSpool } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import { UsageOutboxRepository } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import type { UsageSettlementPort } from "@/core/task/telemetry/UsageSettlement"
import { DeviceTokenBroker } from "./auth/DeviceTokenBroker"
import { isAllowedUsageAttribute, type UsageAttributeKey } from "./contracts/wire"
import { DlineOtelHttpClient } from "./transport/DlineOtelHttpClient"
import { RemoteUsageCoordinator, USAGE_CYCLE_INTERVAL_MS } from "./usage/RemoteUsageCoordinator"
import { type UsageAttributes, UsageDeliveryWorker } from "./usage/UsageDeliveryWorker"
import type { RemoteUsageLog } from "./usage/usageCycleLog"

/**
 * How long after a minute ends its observations may still arrive: an append is
 * sealed by the next cycle, settles, and is folded by the cycle after that.
 */
export const USAGE_BATCH_SETTLE_MS = 2 * USAGE_CYCLE_INTERVAL_MS + SEALED_SHARD_SETTLE_MS + 5_000

export interface RemoteUsageRuntimeOptions {
    /** `StorageContext.dataDir`; every remote telemetry file lives below it. */
    readonly dataDir: string
    readonly readPolicyInputs: () => Promise<LocalUsagePolicyInputs>
    readonly clientVersion: string
    readonly platform: string
    readonly attributes: Readonly<Partial<Record<UsageAttributeKey, string | boolean | undefined>>>
    /** Service origin; defaults to `https://otel.dline.cc`. Loopback HTTP is allowed for the contract smoke. */
    readonly endpoint?: string
    readonly log?: RemoteUsageLog
}

let coordinator: RemoteUsageCoordinator | undefined

/**
 * Settlement port handed to every Task. It forwards to the coordinator of this
 * extension host when one runs, so Tasks created before startup finished, or
 * after shutdown began, simply record nothing remotely.
 */
export const remoteUsageSettlement: UsageSettlementPort = {
    record: (settlement) => coordinator?.record(settlement),
}

/** Compose and start remote usage reporting for this extension host; a second call is ignored. */
export async function startRemoteUsage(options: RemoteUsageRuntimeOptions): Promise<void> {
    if (coordinator) return
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
    const transport = new DlineOtelHttpClient({ endpoint: options.endpoint })
    const credentials = new DeviceCredentialRepository(layout, { onQuarantine })
    const outbox = new UsageOutboxRepository(layout, { onQuarantine })
    const spool = new UsageObservationSpool(layout, ownerId)
    const tokens = new DeviceTokenBroker({
        repository: credentials,
        transport,
        clientVersion: options.clientVersion,
        platform: options.platform,
        ownerId,
    })
    const worker = new UsageDeliveryWorker({
        outbox,
        spool,
        tokens,
        transport,
        attributes: allowedAttributes(options.attributes),
        ownerId,
        batchSettleMs: USAGE_BATCH_SETTLE_MS,
    })
    const started = new RemoteUsageCoordinator({
        policy: new RemotePolicyRepository(layout, { onQuarantine }),
        credentials,
        outbox,
        spool,
        worker,
        readPolicyInputs: options.readPolicyInputs,
        log: options.log,
    })
    coordinator = started
    options.log?.("debug", `[RemoteUsage] starting in ${ownerId}, reporting to ${transport.origin}`)
    await started.start()
}

/** Re-resolve the policy after a consent, organization or host telemetry change. */
export function refreshRemoteUsagePolicy(): Promise<void> {
    return coordinator?.refresh() ?? Promise.resolve()
}

/** Stop intake and delivery and hand the sender lease back; bounded, safe to call twice. */
export async function stopRemoteUsage(): Promise<void> {
    const running = coordinator
    coordinator = undefined
    await running?.dispose()
}

/** Drop any attribute the server would refuse, so one odd host value cannot reject every batch. */
function allowedAttributes(attributes: RemoteUsageRuntimeOptions["attributes"]): UsageAttributes {
    const allowed: Partial<Record<UsageAttributeKey, string | boolean>> = {}
    for (const [key, value] of Object.entries(attributes) as [UsageAttributeKey, string | boolean | undefined][]) {
        if (value !== undefined && isAllowedUsageAttribute(key, value)) allowed[key] = value
    }
    return allowed
}
