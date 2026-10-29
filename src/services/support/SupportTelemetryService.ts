import { openReportBugIssue } from "@core/reporting/ReportBugIssue"
import type { ReportBugDraft } from "@shared/report-bug"
import { DeviceCredentialRepository, type StoredDeviceToken } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import { type IssueCredentialRecord, IssueCredentialRepository } from "@/core/storage/telemetry-remote/IssueCredentialRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { DeviceTokenBroker } from "@/services/telemetry/remote/auth/DeviceTokenBroker"
import {
    createDeviceTokenBroker,
    createReportAuthorizationRuntime,
    type ReportAuthorizationRuntime,
} from "@/services/telemetry/remote/auth/exchangeRuntime"
import { ISSUE_EXCHANGE_DELETE_CODES } from "@/services/telemetry/remote/auth/RecoverableIssueExchangeCoordinator"
import type { PublishedReportTicket } from "@/services/telemetry/remote/auth/ReportAuthorizationCoordinator"
import {
    parseReportAuthorizationStatus,
    type ReportAuthorizationState,
    type ReportAuthorizationStatus,
    type ReportIssueState,
    type ReportResolution,
} from "@/services/telemetry/remote/contracts/reportAuthorization"
import { parseServiceError } from "@/services/telemetry/remote/contracts/wire"
import {
    purgeIssueDiagnosticsOverlay,
    refreshIssueDiagnosticsOverlay,
} from "@/services/telemetry/remote/remoteDiagnosticsRuntime"
import { DlineOtelHttpClient } from "@/services/telemetry/remote/transport/DlineOtelHttpClient"

/** Floor of automatic status polling, whatever interval the service asks for. */
const MIN_POLL_INTERVAL_MS = 30_000
/** States in which the temporary telemetry authorization can still change on its own. */
const LIVE_STATES: ReadonlySet<ReportAuthorizationState> = new Set(["awaiting_issue", "pending_approval", "approved"])
/** Status refusals after which the ticket is unusable (telemetry-exchange-flow §5.4). */
const STATUS_DELETE_CODES: ReadonlySet<string> = new Set(["report_authorization_not_found", "device_revoked"])

type CaptureSealReason = "revoked" | "expired" | "deleted"

export interface SupportTelemetryServiceOptions {
    readonly dataDir: string
    readonly clientVersion: string
    readonly platform: string
    /** Loopback override of the OTel origin for the local contract smoke. */
    readonly otelEndpoint?: string
    readonly clock?: () => number
}

/** Safe Settings projection. It carries neither the authorization code nor any Issue identity. */
export interface SupportStatusProjection {
    readonly publicCode: string
    readonly state: ReportAuthorizationState
    readonly authorizationExpiresAt: number
    readonly captureExpiresAt?: number
    readonly issueState: ReportIssueState
    readonly resolution: ReportResolution
}

/** A ReportBug with temporary telemetry could not obtain its authorization; no Issue was opened. */
export class SupportAuthorizationError extends Error {
    constructor(readonly code: string) {
        super(`Temporary support telemetry could not be authorized (${code})`)
        this.name = "SupportAuthorizationError"
    }
}

/**
 * Client owner of Report Authorization (telemetry-exchange-flow §5, §7).
 *
 * OTel issues the ticket and links the GitHub Issue to it; this service only
 * puts the derived public code into the Issue Form, reads the ticket state and
 * exchanges an approved revision for the issue-only token. Every seal is
 * local: nothing here asks OTel or GitHub to revoke. Private credentials never
 * leave the repositories behind this service.
 */
export class SupportTelemetryService {
    private readonly clock: () => number
    private readonly credentials: IssueCredentialRepository
    private readonly deviceTokens: DeviceTokenBroker
    private readonly transport: DlineOtelHttpClient
    private readonly runtime: ReportAuthorizationRuntime
    private polling: AbortController | undefined
    private operationTail: Promise<unknown> = Promise.resolve()

    constructor(options: SupportTelemetryServiceOptions) {
        this.clock = options.clock ?? Date.now
        const layout = resolveOtelStorageLayout(options.dataDir)
        this.credentials = new IssueCredentialRepository(layout, { clock: this.clock })
        this.transport = new DlineOtelHttpClient({ clientVersion: options.clientVersion, endpoint: options.otelEndpoint })
        this.deviceTokens = createDeviceTokenBroker({
            layout,
            credentials: new DeviceCredentialRepository(layout),
            transport: this.transport,
            clientVersion: options.clientVersion,
            platform: options.platform,
            clock: options.clock,
        })
        this.runtime = createReportAuthorizationRuntime({
            layout,
            transport: this.transport,
            tickets: { publish: (ticket) => this.installTicket(ticket) },
            clientVersion: options.clientVersion,
            platform: options.platform,
            clock: options.clock,
        })
    }

    /** Issue a ticket, then open the Issue Form carrying its public code; nothing opens when issuance fails. */
    async createAuthorizationAndOpenIssue(draft: ReportBugDraft): Promise<SupportStatusProjection> {
        if (!draft.temporaryTelemetryConsent) throw new Error("Temporary telemetry was not consented to")
        const record = await this.runOperation(() => this.issueTicket())
        await openReportBugIssue(draft.content, draft.environment, { supportCode: record.publicCode })
        this.startPolling()
        return project(record)
    }

    /** The stored projection; no network. */
    async status(): Promise<SupportStatusProjection | undefined> {
        return this.runOperation(async () => {
            const record = await this.currentTicket()
            return record ? project(record) : undefined
        })
    }

    async checkNow(signal?: AbortSignal): Promise<SupportStatusProjection | undefined> {
        return this.runOperation(() => this.refreshStatus(signal))
    }

    /** Local full delete (§7): capture seal, then the ticket and its pending operations. */
    async deleteAndRevoke(): Promise<void> {
        // Abort first so an in-flight status query does not hold the queue.
        this.stopPolling("support_deleted")
        await this.runOperation(() => this.deleteTicket())
    }

    /** Startup: refresh the ticket once and keep polling while its authorization is live. */
    async resume(): Promise<void> {
        await this.checkNow().catch(() => undefined)
        const record = (await this.credentials.read()).record
        if (record && this.isLive(record)) this.startPolling()
    }

    dispose(): void {
        this.stopPolling("support_disposed")
    }

    private async issueTicket(): Promise<IssueCredentialRecord> {
        let token = await this.productionToken()
        let result = await this.runtime.authorizations.authorize({
            deviceId: token.deviceId,
            deviceAccessToken: token.accessToken,
        })
        if (result.status === "refresh_device") {
            token = await this.productionToken(token.accessToken)
            result = await this.runtime.authorizations.authorize({
                deviceId: token.deviceId,
                deviceAccessToken: token.accessToken,
            })
        }
        if (result.status !== "issued") throw new SupportAuthorizationError(result.code)
        return ticketRecord(result.ticket)
    }

    /** Ticket publication of the recoverable issuance: a new report ends the previous ticket's capture locally. */
    private async installTicket(ticket: PublishedReportTicket): Promise<void> {
        await this.sealCapture("deleted")
        await this.credentials.replace(ticketRecord(ticket))
    }

    private async refreshStatus(signal?: AbortSignal): Promise<SupportStatusProjection | undefined> {
        const current = await this.currentTicket()
        if (!current) return undefined
        let token = await this.productionToken(undefined, signal)
        let response = await this.transport.queryReportAuthorization(current.authorizationCode, token.accessToken, signal)
        if (response.status === 401) {
            token = await this.productionToken(token.accessToken, signal)
            response = await this.transport.queryReportAuthorization(current.authorizationCode, token.accessToken, signal)
        }
        if (response.status !== 200) {
            const code = parseServiceError(response.json, response.retryAfter, this.clock()).code ?? `http_${response.status}`
            if (STATUS_DELETE_CODES.has(code)) {
                await this.deleteTicket(current.authorizationCode)
                return undefined
            }
            throw new Error(`Report authorization status is unavailable (${code})`)
        }
        const status = parseReportAuthorizationStatus(response.json)
        if (!status) throw new Error("Report authorization status response is malformed")
        const updated = await this.credentials.update(current.authorizationCode, (record) => withStatus(record, status))
        // The ticket was replaced or deleted meanwhile; the answer belongs to no stored ticket.
        if (!updated) return this.projectStored()
        if (updated.state === "approved") await this.exchangeApproved(updated, token, signal)
        else if (updated.state === "revoked" || updated.state === "expired") await this.sealCapture(updated.state)
        return this.projectStored()
    }

    private async exchangeApproved(record: IssueCredentialRecord, token: StoredDeviceToken, signal?: AbortSignal): Promise<void> {
        const input = { authorizationCode: record.authorizationCode, authorizationRevision: record.revision }
        let result = await this.runtime.exchange.exchange(
            { ...input, deviceId: token.deviceId, deviceAccessToken: token.accessToken },
            signal,
        )
        if (result.status === "refresh_device") {
            const refreshed = await this.productionToken(token.accessToken, signal)
            result = await this.runtime.exchange.exchange(
                { ...input, deviceId: refreshed.deviceId, deviceAccessToken: refreshed.accessToken },
                signal,
            )
        }
        if (result.status === "ready") {
            await refreshIssueDiagnosticsOverlay()
            return
        }
        if (result.status !== "stopped") return // pending or unknown: the next status query tries again
        if (ISSUE_EXCHANGE_DELETE_CODES.has(result.code)) await this.deleteTicket(record.authorizationCode)
        else if (result.code === "authorization_revoked") await this.sealCapture("revoked")
        else if (result.code === "authorization_expired") await this.sealCapture("expired")
    }

    /** Capture seal (§7): stop intake, abort in-flight issue-only work, purge its queue and token; keep the ticket. */
    private async sealCapture(reason: CaptureSealReason): Promise<void> {
        await purgeIssueDiagnosticsOverlay(reason)
        // The overlay runs only while remote diagnostics do; the token goes regardless.
        await this.runtime.grants.clear(reason)
    }

    /** Full delete (§7). With a code, only that ticket is deleted, so a late refusal never removes a newer one. */
    private async deleteTicket(authorizationCode?: string): Promise<void> {
        this.stopPolling("support_deleted")
        await this.sealCapture("deleted")
        await this.credentials.clear(authorizationCode)
        await this.runtime.operations.completeAll("report.authorize")
        await this.runtime.operations.completeAll("issue.exchange")
    }

    /** The stored ticket, deleted once OTel no longer answers for it. */
    private async currentTicket(): Promise<IssueCredentialRecord | undefined> {
        const record = (await this.credentials.read()).record
        if (!record || record.ticketExpiresAt > this.clock()) return record
        await this.deleteTicket(record.authorizationCode)
        return undefined
    }

    private async projectStored(): Promise<SupportStatusProjection | undefined> {
        const record = (await this.credentials.read()).record
        return record ? project(record) : undefined
    }

    private async productionToken(rejectedAccessToken?: string, signal?: AbortSignal): Promise<StoredDeviceToken> {
        const acquisition = await this.deviceTokens.acquire("production", { rejectedAccessToken, signal })
        if (acquisition.status !== "ready") throw new SupportAuthorizationError(`production_token_${acquisition.status}`)
        return acquisition.token
    }

    private isLive(record: IssueCredentialRecord): boolean {
        return LIVE_STATES.has(record.state) && record.authorizationExpiresAt > this.clock()
    }

    /** Poll at the service's interval while the authorization is live (§5.4); after that only on demand. */
    private startPolling(): void {
        this.stopPolling("support_poll_replaced")
        const controller = new AbortController()
        this.polling = controller
        void (async () => {
            while (!controller.signal.aborted) {
                const record = (await this.credentials.read()).record
                if (!record || !this.isLive(record)) return
                await wait(Math.max(MIN_POLL_INTERVAL_MS, record.pollAfterMs), controller.signal)
                await this.checkNow(controller.signal).catch(() => undefined)
            }
        })()
            .catch(() => undefined)
            .finally(() => {
                if (this.polling === controller) this.polling = undefined
            })
    }

    private stopPolling(reason: string): void {
        this.polling?.abort(reason)
        this.polling = undefined
    }

    private runOperation<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationTail.then(operation, operation)
        this.operationTail = result.catch(() => undefined)
        return result
    }
}

let configured: SupportTelemetryService | undefined

export function configureSupportTelemetryService(options: SupportTelemetryServiceOptions): SupportTelemetryService {
    configured ??= new SupportTelemetryService(options)
    void configured.resume().catch(() => undefined)
    return configured
}

export function getSupportTelemetryService(): SupportTelemetryService | undefined {
    return configured
}

function ticketRecord(ticket: PublishedReportTicket): IssueCredentialRecord {
    return {
        authorizationCode: ticket.authorizationCode,
        publicCode: ticket.publicCode,
        state: ticket.state,
        revision: 0,
        authorizationExpiresAt: ticket.authorizationExpiresAt,
        ticketExpiresAt: ticket.ticketExpiresAt,
        issueState: "unlinked",
        resolution: { state: "none" },
        pollAfterMs: ticket.pollAfterMs,
    }
}

function withStatus(record: IssueCredentialRecord, status: ReportAuthorizationStatus): IssueCredentialRecord {
    return {
        authorizationCode: record.authorizationCode,
        publicCode: record.publicCode,
        state: status.state,
        revision: status.revision,
        authorizationExpiresAt: status.authorizationExpiresAt,
        ...(status.captureExpiresAt === undefined ? {} : { captureExpiresAt: status.captureExpiresAt }),
        ticketExpiresAt: status.ticketExpiresAt,
        issueState: status.issueState,
        resolution: status.resolution,
        pollAfterMs: status.pollAfterMs,
    }
}

function project(record: IssueCredentialRecord): SupportStatusProjection {
    return {
        publicCode: record.publicCode,
        state: record.state,
        authorizationExpiresAt: record.authorizationExpiresAt,
        ...(record.captureExpiresAt === undefined ? {} : { captureExpiresAt: record.captureExpiresAt }),
        issueState: record.issueState,
        resolution: { ...record.resolution },
    }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason)
        const timer = setTimeout(resolve, milliseconds)
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer)
                reject(signal.reason)
            },
            { once: true },
        )
    })
}
