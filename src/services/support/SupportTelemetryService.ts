import { openReportBugIssue } from "@core/reporting/ReportBugIssue"
import type { ReportBugDraft } from "@shared/report-bug"
import { Logger } from "@shared/services/Logger"
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
import type { WireResponse } from "@/services/telemetry/remote/contracts/classification"
import {
    parseReportAuthorizationStatus,
    type ReportAuthorizationState,
    type ReportAuthorizationStatus,
    type ReportIssueState,
    type ReportResolution,
} from "@/services/telemetry/remote/contracts/reportAuthorization"
import {
    parseServiceError,
    type ReportQueryRefusalReason,
    type ServiceError,
    serverWaitMs,
} from "@/services/telemetry/remote/contracts/wire"
import { resolveRemoteTelemetryEndpoint } from "@/services/telemetry/remote/endpoint-selection"
import {
    purgeIssueDiagnosticsOverlay,
    refreshIssueDiagnosticsOverlay,
} from "@/services/telemetry/remote/remoteDiagnosticsRuntime"
import { DlineOtelHttpClient, DlineOtelTransportError } from "@/services/telemetry/remote/transport/DlineOtelHttpClient"

/** Floor of automatic status polling, whatever interval the service asks for. */
const MIN_POLL_INTERVAL_MS = 30_000
/** States in which the temporary telemetry authorization can still change on its own. */
const LIVE_STATES: ReadonlySet<ReportAuthorizationState> = new Set(["awaiting_issue", "pending_approval", "approved"])
/** Status refusals after which the ticket is unusable (telemetry-exchange-flow §5.4). */
const STATUS_DELETE_CODES: ReadonlySet<string> = new Set(["report_authorization_not_found", "device_revoked"])
/** A refusal that named no delay still may not be retried at once (design §12.4). */
const MIN_REFUSAL_WAIT_MS = 5_000

type CaptureSealReason = "revoked" | "expired" | "deleted"

/**
 * How the last query attempt ended, for the settings surface.
 *
 * `idle` is never projected, so a projection without `refresh` is byte for byte
 * the object it always was. `waiting` means the service refused this query and
 * named when asking again is worth trying; `stale` means the query never
 * reached the service, so the shown state is older than the countdown implies.
 */
export type SupportRefreshState = "idle" | "waiting" | "stale"

export interface SupportRefresh {
    readonly state: SupportRefreshState
    /** Local epoch milliseconds; the service's own gate translated onto the local clock. */
    readonly nextQueryAt?: number
    readonly reason?: ReportQueryRefusalReason
}

/**
 * What one status exchange established.
 *
 * `refused` keeps the HTTP answer so the caller can tell a refusal from a
 * refusal to delete, and `unreachable` means the service never answered at all.
 * Neither is a failure of the authorization (telemetry-exchange-flow §5.4).
 */
type StatusQuery =
    | { readonly kind: "answered"; readonly status: ReportAuthorizationStatus; readonly token: StoredDeviceToken }
    | { readonly kind: "refused"; readonly httpStatus: number; readonly error: ServiceError }
    | { readonly kind: "unreachable" }
    /** The device grant is backing off; the query has not been attempted at all. */
    | { readonly kind: "deferred"; readonly retryAt: number }

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
    /** Present only after a refusal or an unreachable service; an ordinary projection omits it. */
    readonly refresh?: SupportRefresh
}

/** A preview could not obtain temporary telemetry authorization; ordinary issue reporting remains available. */
export class SupportAuthorizationError extends Error {
    constructor(
        readonly code: string,
        /** Set only for a deferral: the local epoch milliseconds the device grant asked to be retried at. */
        readonly retryAt?: number,
    ) {
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
    /** Outcome of the last query attempt; `idle` is never projected. */
    private refreshState: SupportRefreshState = "idle"
    /** Local epoch milliseconds before which another automatic query cannot succeed. */
    private nextQueryAt: number | undefined
    private refusalReason: ReportQueryRefusalReason | undefined

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

    /**
     * Issue a ticket for a report that is about to be previewed and return its public code.
     *
     * Issuance happens before the preview renders so the Issue Form button never
     * waits on OTel: a failure here only means the preview offers no telemetry choice.
     */
    async issueAuthorization(): Promise<string> {
        const record = await this.runOperation(() => this.issueTicket())
        return record.publicCode
    }

    /**
     * Open the Issue Form carrying the public code the preview already showed.
     *
     * No network request happens here. When the stored ticket no longer matches
     * the draft (expired, replaced or deleted since the preview), the ordinary
     * form opens without a code instead of a code nobody can resolve.
     */
    async openAuthorizedIssue(draft: ReportBugDraft): Promise<void> {
        const supportCode = await this.availableSupportCode(draft)
        if (!supportCode) {
            await openReportBugIssue(draft.content, draft.environment)
            return
        }
        await openReportBugIssue(draft.content, draft.environment, { supportCode })
        this.startPolling()
    }

    /** Local delete of an authorization the user declined or never submitted; a newer ticket is left alone. */
    async discardAuthorization(publicCode: string): Promise<void> {
        await this.runOperation(async () => {
            const record = (await this.credentials.read()).record
            if (record?.publicCode === publicCode) await this.deleteTicket(record.authorizationCode)
        })
    }

    /**
     * The stored projection; no network.
     *
     * It carries the pending wait as well, because this is the RPC the settings
     * page reads: a refusal recorded by startup or by automatic polling has to
     * be visible without another query.
     */
    async status(): Promise<SupportStatusProjection | undefined> {
        return this.runOperation(() => this.projectStored())
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

    /** Only an unexpired, unlinked authorization can be attached to a new Issue; ticket retention is independent. */
    private async availableSupportCode(draft: ReportBugDraft): Promise<string | undefined> {
        if (!draft.temporaryTelemetryConsent || !draft.supportCode) return undefined
        try {
            const record = await this.runOperation(() => this.currentTicket())
            if (
                record?.publicCode === draft.supportCode &&
                record.state === "awaiting_issue" &&
                record.issueState === "unlinked" &&
                record.authorizationExpiresAt > this.clock()
            ) {
                return record.publicCode
            }
            Logger.error("ReportBug telemetry authorization is no longer available; opening the issue without it")
        } catch (error) {
            Logger.error("ReportBug telemetry authorization could not be checked; opening the issue without it", error)
        }
        return undefined
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
        const outcome = await this.queryTicketStatus(current, signal)
        if (outcome.kind === "refused") {
            const { error } = outcome
            const code = error.code ?? `http_${outcome.httpStatus}`
            if (STATUS_DELETE_CODES.has(code)) {
                await this.deleteTicket(current.authorizationCode)
                return undefined
            }
            // A refusal is "ask again later", not an authorization failure
            // (telemetry-exchange-flow §5.4). The ticket, the token and an active
            // capture all survive it, and the wait is recorded so polling and the
            // settings countdown both describe the same gate.
            if (!isTransientStatus(outcome.httpStatus)) {
                throw new Error(`Report authorization status is unavailable (${code})`)
            }
            this.enterRefreshWait(waitMsForRefusal(error), "waiting", error)
            return this.projectStored()
        }
        if (outcome.kind === "unreachable") {
            this.enterRefreshWait(MIN_REFUSAL_WAIT_MS, "stale")
            return this.projectStored()
        }
        if (outcome.kind === "deferred") {
            // The device grant asked for a later attempt; nothing was refused by
            // the report service, so the projection only gains the wait.
            this.enterRefreshWait(Math.max(MIN_REFUSAL_WAIT_MS, outcome.retryAt - this.clock()), "stale")
            return this.projectStored()
        }
        const updated = await this.credentials.update(current.authorizationCode, (record) => withStatus(record, outcome.status))
        this.refreshState = "idle"
        this.nextQueryAt = undefined
        this.refusalReason = undefined
        // The ticket was replaced or deleted meanwhile; the answer belongs to no stored ticket.
        if (!updated) return this.projectStored()
        if (updated.state === "approved") await this.exchangeApproved(updated, outcome.token, signal)
        else if (updated.state === "revoked" || updated.state === "expired") await this.sealCapture(updated.state)
        return this.projectStored()
    }

    /**
     * One status exchange, including the single token refresh a 401 earns.
     *
     * A transport fault is not a failure of the authorization either: the
     * service never saw the query, so the answer is "unknown", not "gone".
     */
    private async queryTicketStatus(current: IssueCredentialRecord, signal?: AbortSignal): Promise<StatusQuery> {
        try {
            let token = await this.productionToken(undefined, signal)
            let response = await this.transport.queryReportAuthorization(current.authorizationCode, token.accessToken, signal)
            if (response.status === 401) {
                token = await this.productionToken(token.accessToken, signal)
                response = await this.transport.queryReportAuthorization(current.authorizationCode, token.accessToken, signal)
            }
            return this.readStatusAnswer(response, token, signal)
        } catch (error) {
            if (error instanceof DlineOtelTransportError) {
                // An aborted query is this process stopping, not the service answering.
                if (error.failure === "aborted") throw error
                return { kind: "unreachable" }
            }
            // A device token the broker could not refresh yet is the same kind of
            // answer: the service was never asked, so nothing was lost. Only a
            // device the service actually refused stays a real failure.
            if (error instanceof SupportAuthorizationError && error.retryAt !== undefined) {
                return { kind: "deferred", retryAt: error.retryAt }
            }
            throw error
        }
    }

    private readStatusAnswer(response: WireResponse, token: StoredDeviceToken, signal?: AbortSignal): StatusQuery {
        if (response.status !== 200) {
            return {
                kind: "refused",
                httpStatus: response.status,
                error: parseServiceError(response.json, response.retryAfter, this.clock()),
            }
        }
        const status = parseReportAuthorizationStatus(response.json)
        // A 200 this client cannot read is a broken contract, not a wait: it stays a failure.
        if (!status) throw new Error("Report authorization status response is malformed")
        void signal
        return { kind: "answered", status, token }
    }

    /** Record the gate a refusal named, so polling honours it instead of hammering the service. */
    private enterRefreshWait(waitMs: number, state: SupportRefreshState = "waiting", error?: ServiceError): void {
        this.nextQueryAt = this.clock() + waitMs
        this.refreshState = state
        this.refusalReason = error?.reason
    }

    /** Local milliseconds until another query can succeed; `0` when nothing is pending. */
    private pendingWaitMs(): number {
        return this.nextQueryAt === undefined ? 0 : Math.max(0, this.nextQueryAt - this.clock())
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
        return record ? { ...project(record), ...this.refreshProjection() } : undefined
    }

    /** The wait the surface still has to observe, omitting `idle` so an ordinary projection is unchanged. */
    private refreshProjection(): { refresh?: SupportRefresh } {
        if (this.refreshState === "idle") return {}
        return {
            refresh: {
                state: this.refreshState,
                ...(this.nextQueryAt === undefined ? {} : { nextQueryAt: this.nextQueryAt }),
                ...(this.refusalReason === undefined ? {} : { reason: this.refusalReason }),
            },
        }
    }

    private async productionToken(rejectedAccessToken?: string, signal?: AbortSignal): Promise<StoredDeviceToken> {
        const acquisition = await this.deviceTokens.acquire("production", { rejectedAccessToken, signal })
        if (acquisition.status !== "ready") {
            // A deferral is the broker's own wait, not a refusal: carry its
            // deadline so a query can report it instead of failing.
            const retryAt = acquisition.status === "deferred" ? acquisition.retryAt : undefined
            throw new SupportAuthorizationError(`production_token_${acquisition.status}`, retryAt)
        }
        return acquisition.token
    }

    private isLive(record: IssueCredentialRecord): boolean {
        return LIVE_STATES.has(record.state) && record.authorizationExpiresAt > this.clock()
    }

    /**
     * Poll at the service's interval while the authorization is live (§5.4).
     *
     * The service's `poll_after_ms` only schedules the next attempt; a refusal
     * extends it instead of ending the loop, because ending it would leave a
     * live authorization unobserved until the next manual click.
     */
    private startPolling(): void {
        this.stopPolling("support_poll_replaced")
        const controller = new AbortController()
        this.polling = controller
        void (async () => {
            while (!controller.signal.aborted) {
                const record = (await this.credentials.read()).record
                if (!record || !this.isLive(record)) return
                await wait(Math.max(MIN_POLL_INTERVAL_MS, record.pollAfterMs, this.pendingWaitMs()), controller.signal)
                // A manual query or an earlier refusal may have recorded a later
                // gate while this timer slept; sleeping again keeps the loop from
                // querying ahead of the wait it just learned about.
                const remaining = this.pendingWaitMs()
                if (remaining > 0) {
                    await wait(remaining, controller.signal)
                    continue
                }
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

export function configureSupportTelemetryService(options: SupportTelemetryServiceOptions): SupportTelemetryService | undefined {
    const target = resolveRemoteTelemetryEndpoint({
        ...process.env,
        DLINE_OTEL_ENDPOINT: options.otelEndpoint ?? process.env.DLINE_OTEL_ENDPOINT,
    })
    if (!target) return undefined
    configured ??= new SupportTelemetryService({ ...options, otelEndpoint: target.endpoint })
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

/** Rate limits and upstream faults mean "retry later", so they never surface as failures. */
function isTransientStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500
}

/**
 * How long to wait before asking again.
 *
 * The service's own elapsed measurement wins, then its absolute body delay; a
 * refusal that stated nothing falls back to the floor, because a zero wait
 * would turn "not now" into an immediate retry.
 */
function waitMsForRefusal(error: ServiceError): number {
    return Math.max(MIN_REFUSAL_WAIT_MS, serverWaitMs(error) ?? 0)
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
