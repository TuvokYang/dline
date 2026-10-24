import { ExchangeOperationRepository } from "@/core/storage/telemetry-remote/ExchangeOperationRepository"
import { IssueGrantRepository } from "@/core/storage/telemetry-remote/IssueGrantRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { QuarantineObserver } from "@/core/storage/telemetry-remote/quarantine"
import type { RecoverableExchangeTransport } from "../contracts/exchangeOperation"
import { DlineOtelHttpClient } from "../transport/DlineOtelHttpClient"
import type { DeviceGrantClient } from "./DeviceGrantPort"
import type { DeviceGrantPortRegistry } from "./DeviceGrantPortRegistry"
import { RecoverableExchangeCoordinator } from "./RecoverableExchangeCoordinator"
import { RecoverableIssueExchangeCoordinator } from "./RecoverableIssueExchangeCoordinator"

export interface InstallRecoverableExchangeOptions {
    readonly registry: DeviceGrantPortRegistry
    readonly expectedBootstrap: DeviceGrantClient
    readonly repository: ExchangeOperationRepository
    readonly transport: RecoverableExchangeTransport
    readonly clientVersion: string
    readonly platform: string
}

/**
 * Atomically replace the Phase-U bootstrap without replacing its credential port.
 * A stale composition owner cannot overwrite a coordinator installed later.
 */
export function installRecoverableExchange(options: InstallRecoverableExchangeOptions): RecoverableExchangeCoordinator {
    const coordinator = new RecoverableExchangeCoordinator({
        port: options.registry.port,
        repository: options.repository,
        transport: options.transport,
        clientVersion: options.clientVersion,
        platform: options.platform,
    })
    if (!options.registry.adopt(options.expectedBootstrap, coordinator)) {
        throw new Error("Device grant acquisition owner changed before recoverable exchange adoption")
    }
    return coordinator
}

export interface CreateRecoverableIssueExchangeOptions {
    readonly dataDir: string
    readonly clientVersion: string
    readonly platform: string
    readonly endpoint?: string
    readonly onQuarantine?: QuarantineObserver
}

export interface RecoverableIssueExchangeRuntime {
    readonly coordinator: RecoverableIssueExchangeCoordinator
    readonly grants: IssueGrantRepository
}

/** Compose the client-only issue exchange boundary without importing support UI or server implementation. */
export function createRecoverableIssueExchangeRuntime(
    options: CreateRecoverableIssueExchangeOptions,
): RecoverableIssueExchangeRuntime {
    const layout = resolveOtelStorageLayout(options.dataDir)
    const operations = new ExchangeOperationRepository(layout, { onQuarantine: options.onQuarantine })
    const grants = new IssueGrantRepository(layout, { onQuarantine: options.onQuarantine })
    const transport = new DlineOtelHttpClient({ clientVersion: options.clientVersion, endpoint: options.endpoint })
    return {
        coordinator: new RecoverableIssueExchangeCoordinator({
            port: grants,
            repository: operations,
            transport,
            clientVersion: options.clientVersion,
            platform: options.platform,
        }),
        grants,
    }
}
