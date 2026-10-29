import { randomUUID } from "node:crypto"
import type {
    ExchangeOperationRepository,
    PreparedExchangeOperation,
} from "@/core/storage/telemetry-remote/ExchangeOperationRepository"
import { EDGE_BLOCKED, type WireResponse } from "../contracts/classification"
import { type AtomicDeviceGrant, type DeviceGrantProfile, parseAtomicDeviceGrant } from "../contracts/deviceGrant"
import {
    boundExchangeClientField,
    ExchangeOperationConflictError,
    ExchangeOperationExpiredError,
    type RecoverableExchangeTransport,
} from "../contracts/exchangeOperation"
import { USAGE_SCHEMA_VERSION } from "../contracts/usageBodySchema"
import { parseServiceError } from "../contracts/wire"
import {
    type DeviceGrantAttempt,
    type DeviceGrantClient,
    type DeviceGrantPort,
    DeviceGrantRefusalError,
    type DeviceGrantRequest,
    type EnsureDeviceGrantOptions,
} from "./DeviceGrantPort"

const OPERATION = "device.grant"
const BASE64URL_43_PATTERN = /^[A-Za-z0-9_-]{43}$/
const REVOKED_CREDENTIAL_CODES = new Set(["device_revoked", "device_credential_revoked"])
const REPLAY_IDENTITY_CODES = new Set([
    "exchange_operation_conflict",
    "request_id_conflict",
    "exchange_operation_expired",
    "request_id_expired",
])
const DEFERRED: DeviceGrantAttempt = { kind: "deferred" }

export interface RecoverableExchangeCoordinatorOptions {
    readonly port: DeviceGrantPort
    readonly repository: ExchangeOperationRepository
    readonly transport: RecoverableExchangeTransport
    readonly clientVersion: string
    readonly platform: string
    readonly clock?: () => number
    readonly requestId?: () => string
}

/** How one `/auth/device/grant` response settles its operation. */
type GrantResponseOutcome =
    | { readonly kind: "granted"; readonly grant: AtomicDeviceGrant }
    /** The service may have committed: keep the intent and replay the same request ID and bytes later. */
    | { readonly kind: "unknown"; readonly retryAfterMs?: number }
    /** The replay identity is in conflict or expired: drop the intent, never resend the old bytes. */
    | { readonly kind: "abandon" }

/**
 * The only device-credential issuer client (`POST /auth/device/grant`).
 *
 * Every profile has its own operation: the intent is durable before transport,
 * the encrypted response is durable before credential publication, and only
 * {@link DeviceGrantPort} publishes the token together with its capability.
 * Unknown outcomes replay the same request identity and bytes; an identity that
 * can no longer be replayed byte for byte is dropped, and the next acquisition
 * starts a new operation (telemetry-exchange-flow §3, §5.3).
 */
export class RecoverableExchangeCoordinator implements DeviceGrantClient {
    private readonly clock: () => number
    private readonly requestId: () => string
    private readonly inflight = new Map<DeviceGrantProfile, Promise<DeviceGrantAttempt>>()

    constructor(private readonly options: RecoverableExchangeCoordinatorOptions) {
        this.clock = options.clock ?? Date.now
        this.requestId = options.requestId ?? randomUUID
    }

    readActiveGrant(profile: DeviceGrantProfile, now: number): Promise<AtomicDeviceGrant | null> {
        return this.options.port.readActive(profile, now)
    }

    async ensureActiveGrant(
        profile: DeviceGrantProfile,
        deviceSecret: string,
        options: EnsureDeviceGrantOptions = {},
    ): Promise<DeviceGrantAttempt> {
        if (!BASE64URL_43_PATTERN.test(deviceSecret)) {
            throw new Error("Device secret must be 32 random bytes encoded as base64url")
        }
        const principal = grantPrincipal(profile, deviceSecret)
        const active = await this.options.port.readActive(profile, this.clock())
        if (active && active.accessToken !== options.rejectedAccessToken) {
            // A published grant makes an intent left behind by a crash before completion obsolete.
            await this.options.repository.complete(principal, OPERATION)
            return { kind: "granted", grant: active }
        }
        const shared = this.inflight.get(profile)
        if (shared) return shared
        const running = this.recoverOrRequest(profile, deviceSecret, principal, options).finally(() => {
            if (this.inflight.get(profile) === running) this.inflight.delete(profile)
        })
        this.inflight.set(profile, running)
        return running
    }

    private async recoverOrRequest(
        profile: DeviceGrantProfile,
        deviceSecret: string,
        principal: string,
        options: EnsureDeviceGrantOptions,
    ): Promise<DeviceGrantAttempt> {
        let prepared = await this.prepare(profile, deviceSecret, principal)
        if (prepared.response) {
            const recovered = this.recoveredGrant(profile, prepared, options.rejectedAccessToken)
            if (recovered) return this.publishGrant(profile, deviceSecret, prepared.intent.requestId, recovered)
            // The sealed response can no longer be published (expired, rejected or from an older
            // contract): the operation is over, so a new one starts instead of replaying it.
            await this.options.repository.complete(principal, OPERATION, prepared.intent.requestId)
            prepared = await this.prepare(profile, deviceSecret, principal)
        }

        const requestId = prepared.intent.requestId
        let response: WireResponse
        try {
            response = await this.options.transport.requestRecoverableDeviceOrIssueExchange(
                this.buildRequest(profile, deviceSecret, requestId),
                options.signal,
            )
        } catch (error) {
            if (options.signal?.aborted) throw error
            return DEFERRED
        }
        const outcome = await this.settleResponse(profile, principal, requestId, response)
        if (outcome.kind === "abandon") {
            await this.options.repository.complete(principal, OPERATION, requestId)
            return DEFERRED
        }
        if (outcome.kind === "unknown") {
            return outcome.retryAfterMs === undefined ? DEFERRED : { kind: "deferred", retryAfterMs: outcome.retryAfterMs }
        }
        try {
            await this.options.repository.storeReceipt(prepared.intent, deviceSecret, response)
        } catch (error) {
            // Another process may have published and completed the same operation while this
            // response was in flight. Prefer the stable authority over recreating the journal.
            const active = await this.options.port.readActive(profile, this.clock())
            if (active) return { kind: "granted", grant: active }
            throw error
        }
        return this.publishGrant(profile, deviceSecret, requestId, outcome.grant)
    }

    /** Persist a new intent or resume the pending one; an intent that cannot be replayed is replaced. */
    private async prepare(
        profile: DeviceGrantProfile,
        deviceSecret: string,
        principal: string,
    ): Promise<PreparedExchangeOperation> {
        const input = {
            principal,
            receiptSecret: deviceSecret,
            request: this.buildRequest(profile, deviceSecret, this.requestId()),
        }
        try {
            return await this.options.repository.prepare(input)
        } catch (error) {
            if (!(error instanceof ExchangeOperationConflictError || error instanceof ExchangeOperationExpiredError)) throw error
            // An upgrade changed the canonical body, or the replay window closed: the pending
            // request can never be replayed byte for byte, so its intent is dropped.
            await this.options.repository.complete(principal, OPERATION)
            return this.options.repository.prepare(input)
        }
    }

    private recoveredGrant(
        profile: DeviceGrantProfile,
        prepared: PreparedExchangeOperation,
        rejectedAccessToken: string | undefined,
    ): AtomicDeviceGrant | undefined {
        const json = prepared.response?.json
        if (prepared.response?.status !== 200 || !isRecord(json) || json.request_id !== prepared.intent.requestId)
            return undefined
        const grant = parseAtomicDeviceGrant(json)
        if (!grant || grant.profile !== profile || grant.expiresAt <= this.clock()) return undefined
        return grant.accessToken === rejectedAccessToken ? undefined : grant
    }

    private async settleResponse(
        profile: DeviceGrantProfile,
        principal: string,
        requestId: string,
        response: WireResponse,
    ): Promise<GrantResponseOutcome> {
        if (response.status === 200) {
            const json = response.json
            const grant =
                isRecord(json) && json.ok === true && json.request_id === requestId ? parseAtomicDeviceGrant(json) : undefined
            if (grant && grant.profile === profile && grant.expiresAt > this.clock()) return { kind: "granted", grant }
            // The service committed an answer this client cannot use, for example a grant of an
            // older contract revision. Replaying would return it again, so the operation ends here.
            await this.options.repository.complete(principal, OPERATION, requestId)
            throw new DeviceGrantRefusalError({ kind: "stop", scope: "profile", code: "malformed_grant" })
        }
        const error = parseServiceError(response.json, response.retryAfter, this.clock())
        if ((response.status === 409 || response.status === 410) && error.code && REPLAY_IDENTITY_CODES.has(error.code)) {
            return { kind: "abandon" }
        }
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
            return error.retryAfterMs === undefined ? { kind: "unknown" } : { kind: "unknown", retryAfterMs: error.retryAfterMs }
        }
        if (response.status === 403 && error.code && REVOKED_CREDENTIAL_CODES.has(error.code)) {
            throw new DeviceGrantRefusalError({ kind: "reset_credential", code: error.code })
        }
        // A refusal without a service body is the edge's: it holds the whole machine, like an IP ban.
        if (response.json === undefined) throw new DeviceGrantRefusalError({ kind: "stop", scope: "all", code: EDGE_BLOCKED })
        const scope = error.code === "ip_blocked" ? "all" : "profile"
        throw new DeviceGrantRefusalError({ kind: "stop", scope, code: error.code ?? `http_${response.status}` })
    }

    private async publishGrant(
        profile: DeviceGrantProfile,
        deviceSecret: string,
        requestId: string,
        grant: AtomicDeviceGrant,
    ): Promise<DeviceGrantAttempt> {
        const principal = grantPrincipal(profile, deviceSecret)
        const published = await this.options.port.publish(grant, deviceSecret)
        // Either way the operation is over: its grant is published, or its device identity is gone.
        const active = published ? await this.options.port.readActive(profile, this.clock()) : null
        await this.options.repository.complete(principal, OPERATION, requestId)
        return active ? { kind: "granted", grant: active } : DEFERRED
    }

    private buildRequest(profile: DeviceGrantProfile, deviceSecret: string, requestId: string): DeviceGrantRequest {
        return {
            operation: OPERATION,
            request_id: requestId,
            device_secret: deviceSecret,
            requested_profile: profile,
            client_version: boundExchangeClientField(this.options.clientVersion),
            platform: boundExchangeClientField(this.options.platform),
            supported_usage_schema_versions: [USAGE_SCHEMA_VERSION],
        }
    }
}

/** Local journal identity: each profile is its own operation, so the two never conflict or complete each other. */
function grantPrincipal(profile: DeviceGrantProfile, deviceSecret: string): string {
    return `${profile}:${deviceSecret}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
