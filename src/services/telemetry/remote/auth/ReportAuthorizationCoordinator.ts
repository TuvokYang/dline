import { randomUUID } from "node:crypto"
import type {
    ExchangeOperationRepository,
    PreparedExchangeOperation,
} from "@/core/storage/telemetry-remote/ExchangeOperationRepository"
import type { WireResponse } from "../contracts/classification"
import { isDeviceId } from "../contracts/deviceGrant"
import { ExchangeOperationConflictError, ExchangeOperationExpiredError } from "../contracts/exchangeOperation"
import {
    buildReportAuthorizeRequest,
    type IssuedReportAuthorization,
    parseIssuedReportAuthorization,
    type ReportAuthorizationTransport,
} from "../contracts/reportAuthorization"
import { deriveSupportCode } from "../contracts/supportCode"
import { parseServiceError } from "../contracts/wire"

const OPERATION = "report.authorize"
const BASE64URL_43_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** An issued ticket with the public code derived from its authorization code. */
export interface PublishedReportTicket extends IssuedReportAuthorization {
    readonly publicCode: string
}

/** Stable ticket authority; issuance is confirmed only after this publication succeeded. */
export interface ReportTicketPort {
    publish(ticket: PublishedReportTicket): Promise<void>
}

export interface ReportAuthorizationInput {
    readonly deviceId: string
    readonly deviceAccessToken: string
}

export type ReportAuthorizationResult =
    | { readonly status: "issued"; readonly ticket: PublishedReportTicket }
    /** The device token was rejected; the same operation is replayed after a refresh. */
    | { readonly status: "refresh_device"; readonly code: string }
    /** Outcome unknown; the next attempt replays the same request ID and bytes. */
    | { readonly status: "retry"; readonly code: string; readonly retryAfterMs?: number }
    /** No ticket was issued; a later attempt starts a new operation. */
    | { readonly status: "stopped"; readonly code: string; readonly retryAfterMs?: number }

export interface ReportAuthorizationCoordinatorOptions {
    readonly port: ReportTicketPort
    readonly repository: ExchangeOperationRepository
    readonly transport: ReportAuthorizationTransport
    readonly clientVersion: string
    readonly platform: string
    readonly clock?: () => number
    readonly requestId?: () => string
}

/**
 * Recoverable `report.authorize` (telemetry-exchange-flow §3, §5.2).
 *
 * The response carries the authorization code, so it is sealed in the local
 * journal before the ticket is published, and the intent is completed only
 * after publication. The receipt key is the device token that authenticated
 * the request: after a token refresh the receipt is unreadable, and the
 * journal then replays the same identity, which OTel answers with the same
 * ticket from its own encrypted replay.
 */
export class ReportAuthorizationCoordinator {
    private readonly clock: () => number
    private readonly requestId: () => string

    constructor(private readonly options: ReportAuthorizationCoordinatorOptions) {
        this.clock = options.clock ?? Date.now
        this.requestId = options.requestId ?? randomUUID
    }

    async authorize(input: ReportAuthorizationInput, signal?: AbortSignal): Promise<ReportAuthorizationResult> {
        if (!isDeviceId(input.deviceId)) throw new Error("Report authorization device identity is invalid")
        if (!BASE64URL_43_PATTERN.test(input.deviceAccessToken)) throw new Error("Report authorization device token is invalid")
        const prepared = await this.prepare(input)
        if (prepared.response) return this.settle(input, prepared, prepared.response, true)
        const request = this.request(prepared.intent.requestId)
        let response: WireResponse
        try {
            response = await this.options.transport.requestReportAuthorization(request, input.deviceAccessToken, signal)
        } catch (error) {
            if (signal?.aborted) throw error
            return { status: "retry", code: "transport_unknown" }
        }
        return this.settle(input, prepared, response, false)
    }

    /** Resume the pending operation, or start a fresh one when its local identity conflicts or expired. */
    private async prepare(input: ReportAuthorizationInput): Promise<PreparedExchangeOperation> {
        const prepare = () =>
            this.options.repository.prepare({
                principal: input.deviceId,
                receiptSecret: input.deviceAccessToken,
                request: this.request(this.requestId()),
            })
        try {
            return await prepare()
        } catch (error) {
            if (!(error instanceof ExchangeOperationConflictError) && !(error instanceof ExchangeOperationExpiredError)) {
                throw error
            }
            await this.options.repository.complete(input.deviceId, OPERATION)
            return prepare()
        }
    }

    private async settle(
        input: ReportAuthorizationInput,
        prepared: PreparedExchangeOperation,
        response: WireResponse,
        fromReceipt: boolean,
    ): Promise<ReportAuthorizationResult> {
        const requestId = prepared.intent.requestId
        if (response.status === 200) {
            const issued = parseIssuedReportAuthorization(response.json, requestId)
            if (!issued) {
                await this.options.repository.complete(input.deviceId, OPERATION, requestId)
                return { status: "stopped", code: "malformed_report_authorization" }
            }
            if (!fromReceipt) await this.options.repository.storeReceipt(prepared.intent, input.deviceAccessToken, response)
            const ticket: PublishedReportTicket = { ...issued, publicCode: deriveSupportCode(issued.authorizationCode) }
            await this.options.port.publish(ticket)
            await this.options.repository.complete(input.deviceId, OPERATION, requestId)
            return { status: "issued", ticket }
        }
        const error = parseServiceError(response.json, response.retryAfter, this.clock())
        const code = error.code ?? `http_${response.status}`
        const retryAfter = error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }
        if (response.status === 401) return { status: "refresh_device", code }
        if (response.status === 408 || response.status >= 500) return { status: "retry", code, ...retryAfter }
        // Every other answer issued no ticket and is not replayed: a refusal or a broken replay
        // identity (409 request_id_*) is final for these bytes, and a rate limit applies to the
        // next new operation.
        await this.options.repository.complete(input.deviceId, OPERATION, requestId)
        return { status: "stopped", code, ...retryAfter }
    }

    private request(requestId: string) {
        return buildReportAuthorizeRequest(requestId, this.options.clientVersion, this.options.platform)
    }
}
