/**
 * Report Authorization wire contract (telemetry-exchange-flow §5.2 and §5.4).
 *
 * OTel issues the authorization ticket and owns the GitHub Issue association.
 * The parsers read only the fields declared here, so a status projection can
 * never carry the Issue repository, number, title or link onward even if a
 * response contained them.
 */

import type { WireResponse } from "./classification"
import { boundExchangeClientField, type ExchangeOperationRequest, validateExchangeRequestId } from "./exchangeOperation"
import { isAuthorizationCode } from "./supportCode"

export const REPORT_AUTHORIZATION_STATES = ["awaiting_issue", "pending_approval", "approved", "revoked", "expired"] as const
export type ReportAuthorizationState = (typeof REPORT_AUTHORIZATION_STATES)[number]

export const REPORT_ISSUE_STATES = ["unlinked", "open", "closed"] as const
export type ReportIssueState = (typeof REPORT_ISSUE_STATES)[number]

export const REPORT_RESOLUTION_STATES = ["none", "investigating", "fixed", "wont_fix", "duplicate", "not_reproducible"] as const
export type ReportResolutionState = (typeof REPORT_RESOLUTION_STATES)[number]

const MAX_FIXED_IN_VERSION_LENGTH = 64
const MAX_RESOLUTION_SUMMARY_LENGTH = 500

/** Server-maintained outcome of the reported Issue; the client only displays it. */
export interface ReportResolution {
    readonly state: ReportResolutionState
    readonly fixedInVersion?: string
    readonly summary?: string
}

/** `/auth/report-authorizations` body; consent is part of the canonical bytes so it is replayed exactly. */
export interface ReportAuthorizeRequest extends ExchangeOperationRequest {
    readonly operation: "report.authorize"
    readonly temporary_telemetry_consent: true
    readonly client_version: string
    readonly platform: string
}

/** A freshly issued ticket (§5.2); the public code is derived locally, never read from the response. */
export interface IssuedReportAuthorization {
    readonly authorizationCode: string
    readonly state: "awaiting_issue"
    readonly authorizationExpiresAt: number
    readonly ticketExpiresAt: number
    readonly pollAfterMs: number
}

/** Current ticket state (§5.4). */
export interface ReportAuthorizationStatus {
    readonly state: ReportAuthorizationState
    readonly revision: number
    readonly authorizationExpiresAt: number
    /** Present only while approved. */
    readonly captureExpiresAt?: number
    readonly ticketExpiresAt: number
    readonly issueState: ReportIssueState
    readonly resolution: ReportResolution
    readonly pollAfterMs: number
}

/** Transport of the two ticket endpoints; both carry the issuing device's production token. */
export interface ReportAuthorizationTransport {
    requestReportAuthorization(
        request: ReportAuthorizeRequest,
        deviceAccessToken: string,
        signal?: AbortSignal,
    ): Promise<WireResponse>
    queryReportAuthorization(authorizationCode: string, deviceAccessToken: string, signal?: AbortSignal): Promise<WireResponse>
}

export function buildReportAuthorizeRequest(requestId: string, clientVersion: string, platform: string): ReportAuthorizeRequest {
    validateExchangeRequestId(requestId)
    return {
        operation: "report.authorize",
        request_id: requestId,
        temporary_telemetry_consent: true,
        client_version: boundExchangeClientField(clientVersion),
        platform: boundExchangeClientField(platform),
    }
}

export function parseIssuedReportAuthorization(value: unknown, requestId: string): IssuedReportAuthorization | undefined {
    if (!isRecord(value) || value.ok !== true || value.request_id !== requestId) return undefined
    const { authorization_code: authorizationCode, state, poll_after_ms: pollAfterMs } = value
    const authorizationExpiresAt = value.authorization_expires_at
    const ticketExpiresAt = value.ticket_expires_at
    if (!isAuthorizationCode(authorizationCode) || state !== "awaiting_issue") return undefined
    if (!isTimestamp(authorizationExpiresAt) || !isTimestamp(ticketExpiresAt) || ticketExpiresAt < authorizationExpiresAt) {
        return undefined
    }
    if (!isNonNegativeInteger(pollAfterMs)) return undefined
    return { authorizationCode, state, authorizationExpiresAt, ticketExpiresAt, pollAfterMs }
}

export function parseReportAuthorizationStatus(value: unknown): ReportAuthorizationStatus | undefined {
    if (!isRecord(value) || value.ok !== true) return undefined
    const state = oneOf(value.state, REPORT_AUTHORIZATION_STATES)
    const issueState = oneOf(value.issue_state, REPORT_ISSUE_STATES)
    const resolution = parseReportResolution(value.resolution)
    const revision = value.authorization_revision
    const authorizationExpiresAt = value.authorization_expires_at
    const ticketExpiresAt = value.ticket_expires_at
    const pollAfterMs = value.poll_after_ms
    if (!state || !issueState || !resolution || !isNonNegativeInteger(revision) || !isNonNegativeInteger(pollAfterMs)) {
        return undefined
    }
    if (!isTimestamp(authorizationExpiresAt) || !isTimestamp(ticketExpiresAt) || ticketExpiresAt < authorizationExpiresAt) {
        return undefined
    }
    if (state !== "approved") {
        return { state, revision, authorizationExpiresAt, ticketExpiresAt, issueState, resolution, pollAfterMs }
    }
    const captureExpiresAt = value.capture_expires_at
    if (revision === 0 || !isTimestamp(captureExpiresAt) || captureExpiresAt > authorizationExpiresAt) return undefined
    return { state, revision, authorizationExpiresAt, captureExpiresAt, ticketExpiresAt, issueState, resolution, pollAfterMs }
}

/** Wire form shared by the status response and the owner-only ticket store. */
export function serializeReportResolution(resolution: ReportResolution): Record<string, string> {
    return {
        state: resolution.state,
        ...(resolution.fixedInVersion === undefined ? {} : { fixed_in_version: resolution.fixedInVersion }),
        ...(resolution.summary === undefined ? {} : { summary: resolution.summary }),
    }
}

export function parseReportResolution(value: unknown): ReportResolution | undefined {
    if (!isRecord(value)) return undefined
    const state = oneOf(value.state, REPORT_RESOLUTION_STATES)
    const fixedInVersion = optionalText(value.fixed_in_version, MAX_FIXED_IN_VERSION_LENGTH)
    const summary = optionalText(value.summary, MAX_RESOLUTION_SUMMARY_LENGTH)
    if (!state || fixedInVersion === false || summary === false) return undefined
    return {
        state,
        ...(fixedInVersion === undefined ? {} : { fixedInVersion }),
        ...(summary === undefined ? {} : { summary }),
    }
}

/** `undefined` when absent or null, `false` when present but not a bounded non-empty string. */
function optionalText(value: unknown, maxLength: number): string | undefined | false {
    if (value === undefined || value === null) return undefined
    if (typeof value !== "string") return false
    const trimmed = value.trim()
    return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : false
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
    return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

function isTimestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
