import { createHash } from "node:crypto"
import { stableJsonStringify } from "@shared/stable-json"
import type { WireResponse } from "./classification"

export const EXCHANGE_OPERATION_SCHEMA_VERSION = 1
export const EXCHANGE_OPERATION_TTL_MS = 24 * 60 * 60_000

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
const OPERATIONS = ["device.grant", "issue.exchange"] as const

export type ExchangeOperation = (typeof OPERATIONS)[number]

/** Shared identity fields carried by every recoverable exchange request. */
export interface ExchangeOperationRequest {
    readonly operation: ExchangeOperation
    readonly request_id: string
}

/** Transport-only boundary; response publication belongs to the operation coordinator. */
export interface RecoverableExchangeTransport {
    requestRecoverableDeviceOrIssueExchange(
        request: ExchangeOperationRequest & object,
        signal?: AbortSignal,
    ): Promise<WireResponse>
}

export interface IssueExchangeReference {
    readonly owner: string
    readonly repo: string
    readonly number: number
}

export interface IssueExchangeRequest extends ExchangeOperationRequest {
    readonly operation: "issue.exchange"
    readonly issue: IssueExchangeReference
    readonly pairing_secret: string
    readonly client_version: string
    readonly platform: string
}

/** Issue exchange carries the current device bearer only at send time; it is not part of the canonical body. */
export interface IssueExchangeTransport {
    requestRecoverableIssueExchange(
        request: IssueExchangeRequest,
        deviceAccessToken: string,
        signal?: AbortSignal,
    ): Promise<WireResponse>
}

/** Persisted identity of one request whose outcome may be unknown after a crash or timeout. */
export interface ExchangeOperationIntent {
    readonly operation: ExchangeOperation
    readonly requestId: string
    readonly principalHash: string
    readonly bodyHash: string
    readonly createdAt: number
    readonly expiresAt: number
}

export class ExchangeOperationConflictError extends Error {
    readonly code = "exchange_operation_conflict"

    constructor() {
        super("The pending exchange operation has a different canonical request body")
        this.name = "ExchangeOperationConflictError"
    }
}

export class ExchangeOperationExpiredError extends Error {
    readonly code = "exchange_operation_expired"

    constructor() {
        super("The pending exchange operation identity has expired")
        this.name = "ExchangeOperationExpiredError"
    }
}

/**
 * Hash the final exchange wire body independently from its replay identity.
 *
 * `request_id` is excluded because it selects the idempotency record; every
 * other final wire field, including `operation`, participates in the hash.
 */
export function hashCanonicalExchangeBody(request: ExchangeOperationRequest & object): string {
    validateExchangeOperation(request.operation)
    validateExchangeRequestId(request.request_id)
    const canonicalBody = { ...(request as unknown as Record<string, unknown>) }
    delete canonicalBody.request_id
    return sha256Domain("dline.exchange.body.v1", stableJsonStringify(canonicalBody))
}

/** Privacy-safe principal projection used only to find this machine's pending operation. */
export function hashExchangePrincipal(principal: string): string {
    if (principal.length < 16 || principal.length > 512) throw new Error("Exchange principal is invalid")
    return sha256Domain("dline.exchange.principal.v1", principal)
}

/** Stable map key. It intentionally contains neither the raw principal nor the request body. */
export function exchangeOperationKey(principalHash: string, operation: ExchangeOperation): string {
    if (!HASH_PATTERN.test(principalHash)) throw new Error("Exchange principal hash is invalid")
    validateExchangeOperation(operation)
    return sha256Domain("dline.exchange.intent.v1", `${principalHash}\0${operation}`)
}

export function validateExchangeIntent(intent: ExchangeOperationIntent): ExchangeOperationIntent {
    validateExchangeOperation(intent.operation)
    validateExchangeRequestId(intent.requestId)
    if (!HASH_PATTERN.test(intent.principalHash) || !HASH_PATTERN.test(intent.bodyHash)) {
        throw new Error("Exchange operation hashes are invalid")
    }
    if (
        !isTimestamp(intent.createdAt) ||
        !isTimestamp(intent.expiresAt) ||
        intent.expiresAt - intent.createdAt !== EXCHANGE_OPERATION_TTL_MS
    ) {
        throw new Error("Exchange operation lifetime is invalid")
    }
    return { ...intent }
}

export function validateExchangeRequestId(requestId: string): void {
    if (!UUID_PATTERN.test(requestId)) throw new Error("Exchange request ID must be a UUID")
}

export function isExchangeOperation(value: unknown): value is ExchangeOperation {
    return typeof value === "string" && (OPERATIONS as readonly string[]).includes(value)
}

function validateExchangeOperation(operation: unknown): asserts operation is ExchangeOperation {
    if (!isExchangeOperation(operation)) throw new Error("Exchange operation is invalid")
}

function sha256Domain(domain: string, value: string): string {
    return `sha256:${createHash("sha256").update(domain, "utf8").update("\0", "utf8").update(value, "utf8").digest("hex")}`
}

function isTimestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
