import { randomUUID } from "node:crypto"
import type { ExchangeOperationRepository } from "@/core/storage/telemetry-remote/ExchangeOperationRepository"
import type { WireResponse } from "../contracts/classification"
import {
    ExchangeOperationConflictError,
    ExchangeOperationExpiredError,
    type IssueExchangeReference,
    type IssueExchangeRequest,
    type IssueExchangeTransport,
} from "../contracts/exchangeOperation"
import { type AtomicIssueGrant, parseAtomicIssueGrant } from "../contracts/issueGrant"
import { parseServiceError } from "../contracts/wire"
import type { IssueGrantPort } from "./IssueGrantPort"

const BASE64URL_43_PATTERN = /^[A-Za-z0-9_-]{43}$/
const ISSUE_COMPONENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/
const MAX_DEVICE_ID_LENGTH = 128
const MAX_CLIENT_FIELD_LENGTH = 64

export type IssueExchangeResult =
    | { readonly status: "ready"; readonly grant: AtomicIssueGrant }
    | { readonly status: "pending"; readonly code: string; readonly retryAfterMs?: number }
    | { readonly status: "retry"; readonly code: string; readonly retryAfterMs?: number }
    | { readonly status: "refresh_device"; readonly code: string }
    | { readonly status: "stopped"; readonly code: string }

export interface RecoverableIssueExchangeInput {
    readonly deviceId: string
    readonly deviceAccessToken: string
    readonly issue: IssueExchangeReference
    readonly pairingSecret: string
    readonly authorizationRevision: number
}

export interface RecoverableIssueExchangeCoordinatorOptions {
    readonly port: IssueGrantPort
    readonly repository: ExchangeOperationRepository
    readonly transport: IssueExchangeTransport
    readonly clientVersion: string
    readonly platform: string
    readonly clock?: () => number
    readonly requestId?: () => string
}

/** Recoverable issue-token exchange. Authorization remains outside this client adapter. */
export class RecoverableIssueExchangeCoordinator {
    private readonly clock: () => number
    private readonly requestId: () => string
    private readonly inflight = new Map<string, Promise<IssueExchangeResult>>()

    constructor(private readonly options: RecoverableIssueExchangeCoordinatorOptions) {
        this.clock = options.clock ?? Date.now
        this.requestId = options.requestId ?? randomUUID
    }

    async exchange(input: RecoverableIssueExchangeInput, signal?: AbortSignal): Promise<IssueExchangeResult> {
        validateInput(input)
        const active = await this.options.port.readActive(this.clock(), input.authorizationRevision)
        if (active) {
            await this.options.repository.completeAll("issue.exchange")
            return { status: "ready", grant: active }
        }
        const key = inflightKey(input)
        const shared = this.inflight.get(key)
        if (shared) return shared
        const running = this.recoverOrRequest(input, signal).finally(() => {
            if (this.inflight.get(key) === running) this.inflight.delete(key)
        })
        this.inflight.set(key, running)
        return running
    }

    private async recoverOrRequest(
        input: RecoverableIssueExchangeInput,
        signal: AbortSignal | undefined,
    ): Promise<IssueExchangeResult> {
        const proposed = buildRequest(input, this.requestId(), this.options.clientVersion, this.options.platform)
        let prepared: Awaited<ReturnType<ExchangeOperationRepository["prepare"]>>
        try {
            prepared = await this.options.repository.prepare({
                principal: input.deviceId,
                receiptSecret: input.pairingSecret,
                request: proposed,
            })
        } catch (error) {
            if (error instanceof ExchangeOperationExpiredError) {
                await this.options.repository.complete(input.deviceId, "issue.exchange")
            }
            throw error
        }
        const request = buildRequest(input, prepared.intent.requestId, this.options.clientVersion, this.options.platform)
        if (prepared.response) {
            const outcome = this.interpret(prepared.intent.requestId, prepared.response)
            if (outcome.status !== "ready") {
                await this.options.repository.clearReceipt(prepared.intent)
                return outcome
            }
            return this.publish(input.deviceId, prepared.intent.requestId, outcome.grant)
        }

        let response: WireResponse
        try {
            response = await this.options.transport.requestRecoverableIssueExchange(request, input.deviceAccessToken, signal)
        } catch (error) {
            if (signal?.aborted) throw error
            return { status: "retry", code: "transport_unknown" }
        }
        const outcome = this.interpret(prepared.intent.requestId, response)
        if (outcome.status !== "ready") {
            const reason = outcome.status === "stopped" ? clearReason(outcome.code) : undefined
            if (reason) await this.options.port.clear(reason)
            if ((response.status === 409 || response.status === 410) && isExpiredCode(outcome.code)) {
                await this.options.repository.complete(input.deviceId, "issue.exchange", prepared.intent.requestId)
                throw new ExchangeOperationExpiredError()
            }
            return outcome
        }
        try {
            await this.options.repository.storeReceipt(prepared.intent, input.pairingSecret, response)
        } catch (error) {
            const active = await this.options.port.readActive(this.clock(), input.authorizationRevision)
            if (active) return { status: "ready", grant: active }
            throw error
        }
        return this.publish(input.deviceId, prepared.intent.requestId, outcome.grant)
    }

    private interpret(requestId: string, response: WireResponse): IssueExchangeResult {
        if (response.status === 200) {
            if (!isRecord(response.json) || response.json.request_id !== requestId) {
                return { status: "stopped", code: "malformed_issue_grant" }
            }
            const grant = parseAtomicIssueGrant(response.json)
            if (!grant || grant.expiresAt <= this.clock()) return { status: "stopped", code: "malformed_issue_grant" }
            return { status: "ready", grant }
        }
        const error = parseServiceError(response.json, response.retryAfter, this.clock())
        const code = error.code ?? `http_${response.status}`
        if (response.status === 409 && isConflictCode(code)) throw new ExchangeOperationConflictError()
        if ((response.status === 409 || response.status === 410) && isExpiredCode(code)) {
            return { status: "stopped", code: "exchange_operation_expired" }
        }
        if (response.status === 202 || response.status === 404) {
            return { status: "pending", code, ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) }
        }
        if (response.status === 401) return { status: "refresh_device", code }
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
            return { status: "retry", code, ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) }
        }
        return { status: "stopped", code }
    }

    private async publish(deviceId: string, requestId: string, grant: AtomicIssueGrant): Promise<IssueExchangeResult> {
        await this.options.port.publish(grant)
        const active = await this.options.port.readActive(this.clock(), grant.authorizationRevision)
        if (!active) return { status: "retry", code: "issue_grant_publication_incomplete" }
        await this.options.repository.complete(deviceId, "issue.exchange", requestId)
        return { status: "ready", grant: active }
    }
}

function buildRequest(
    input: RecoverableIssueExchangeInput,
    requestId: string,
    clientVersion = "",
    platform = "",
): IssueExchangeRequest {
    return {
        operation: "issue.exchange",
        request_id: requestId,
        issue: { ...input.issue },
        pairing_secret: input.pairingSecret,
        client_version: boundClientField(clientVersion),
        platform: boundClientField(platform),
    }
}

function validateInput(input: RecoverableIssueExchangeInput): void {
    if (input.deviceId.length < 16 || input.deviceId.length > MAX_DEVICE_ID_LENGTH) {
        throw new Error("Issue exchange device identity is invalid")
    }
    if (!BASE64URL_43_PATTERN.test(input.deviceAccessToken)) throw new Error("Issue exchange device token is invalid")
    if (!BASE64URL_43_PATTERN.test(input.pairingSecret)) throw new Error("Issue exchange pairing secret is invalid")
    if (
        !ISSUE_COMPONENT_PATTERN.test(input.issue.owner) ||
        !ISSUE_COMPONENT_PATTERN.test(input.issue.repo) ||
        !Number.isSafeInteger(input.issue.number) ||
        input.issue.number <= 0
    ) {
        throw new Error("Issue exchange issue identity is invalid")
    }
    if (!Number.isSafeInteger(input.authorizationRevision) || input.authorizationRevision <= 0) {
        throw new Error("Issue exchange authorization revision is invalid")
    }
}

function inflightKey(input: RecoverableIssueExchangeInput): string {
    return `${input.deviceId}\0${input.issue.owner.toLowerCase()}/${input.issue.repo.toLowerCase()}#${input.issue.number}\0${input.authorizationRevision}\0${input.pairingSecret}`
}

function boundClientField(value: string): string {
    const trimmed = value.trim().slice(0, MAX_CLIENT_FIELD_LENGTH)
    if (!trimmed) throw new Error("Issue exchange client fields must not be empty")
    return trimmed
}

function isConflictCode(code: string): boolean {
    return code === "exchange_operation_conflict" || code === "request_id_conflict"
}

function isExpiredCode(code: string): boolean {
    return code === "exchange_operation_expired" || code === "request_id_expired"
}

function clearReason(code: string): Parameters<IssueGrantPort["clear"]>[0] | undefined {
    if (code === "authorization_expired") return "expired"
    if (code === "authorization_revision_stale") return "revision_changed"
    if (code === "authorization_deleted") return "deleted"
    if (code === "authorization_inactive" || code === "authorization_revoked") return "revoked"
    return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
