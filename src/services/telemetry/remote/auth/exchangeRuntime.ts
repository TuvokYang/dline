import type { DeviceCredentialRepository } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import { ExchangeOperationRepository } from "@/core/storage/telemetry-remote/ExchangeOperationRepository"
import { IssueGrantRepository } from "@/core/storage/telemetry-remote/IssueGrantRepository"
import type { OtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { QuarantineObserver } from "@/core/storage/telemetry-remote/quarantine"
import type { IssueExchangeTransport, RecoverableExchangeTransport } from "../contracts/exchangeOperation"
import type { ReportAuthorizationTransport } from "../contracts/reportAuthorization"
import { deviceGrantPortFromRepository } from "./DeviceGrantPort"
import { DeviceTokenBroker } from "./DeviceTokenBroker"
import { RecoverableExchangeCoordinator } from "./RecoverableExchangeCoordinator"
import { RecoverableIssueExchangeCoordinator } from "./RecoverableIssueExchangeCoordinator"
import { ReportAuthorizationCoordinator, type ReportTicketPort } from "./ReportAuthorizationCoordinator"

export interface CreateDeviceTokenBrokerOptions {
    readonly layout: OtelStorageLayout
    /** The machine's credential authority; the broker and the grant coordinator share it. */
    readonly credentials: DeviceCredentialRepository
    readonly transport: RecoverableExchangeTransport
    readonly clientVersion: string
    readonly platform: string
    /** Identity of this process in refresh claims. */
    readonly ownerId?: string
    readonly onQuarantine?: QuarantineObserver
    readonly clock?: () => number
}

/**
 * Compose the one device credential path: a journal-backed `/auth/device/grant`
 * coordinator publishing into the credential repository, behind the
 * machine-wide token broker.
 */
export function createDeviceTokenBroker(options: CreateDeviceTokenBrokerOptions): DeviceTokenBroker {
    const grantClient = new RecoverableExchangeCoordinator({
        port: deviceGrantPortFromRepository(options.credentials),
        repository: new ExchangeOperationRepository(options.layout, { onQuarantine: options.onQuarantine, clock: options.clock }),
        transport: options.transport,
        clientVersion: options.clientVersion,
        platform: options.platform,
        clock: options.clock,
    })
    return new DeviceTokenBroker({
        repository: options.credentials,
        grantClient,
        ownerId: options.ownerId,
        clock: options.clock,
    })
}

export interface CreateReportAuthorizationRuntimeOptions {
    readonly layout: OtelStorageLayout
    readonly transport: ReportAuthorizationTransport & IssueExchangeTransport
    /** The ticket authority; issuance is confirmed only after it published the ticket. */
    readonly tickets: ReportTicketPort
    readonly clientVersion: string
    readonly platform: string
    readonly onQuarantine?: QuarantineObserver
    readonly clock?: () => number
}

export interface ReportAuthorizationRuntime {
    readonly authorizations: ReportAuthorizationCoordinator
    readonly exchange: RecoverableIssueExchangeCoordinator
    readonly grants: IssueGrantRepository
    /** The shared recoverable-operation journal; a full delete purges the ticket's pending intents from it. */
    readonly operations: ExchangeOperationRepository
}

/**
 * Compose the client side of Report Authorization (telemetry-exchange-flow §5):
 * ticket issuance and issue-token exchange over one recoverable journal,
 * without importing support UI or server implementation.
 */
export function createReportAuthorizationRuntime(options: CreateReportAuthorizationRuntimeOptions): ReportAuthorizationRuntime {
    const operations = new ExchangeOperationRepository(options.layout, {
        onQuarantine: options.onQuarantine,
        clock: options.clock,
    })
    const grants = new IssueGrantRepository(options.layout, { onQuarantine: options.onQuarantine, clock: options.clock })
    const shared = {
        repository: operations,
        transport: options.transport,
        clientVersion: options.clientVersion,
        platform: options.platform,
        clock: options.clock,
    }
    return {
        authorizations: new ReportAuthorizationCoordinator({ ...shared, port: options.tickets }),
        exchange: new RecoverableIssueExchangeCoordinator({ ...shared, port: grants }),
        grants,
        operations,
    }
}
