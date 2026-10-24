import { randomUUID } from "node:crypto"
import type { ExchangeOperationRepository } from "@/core/storage/telemetry-remote/ExchangeOperationRepository"
import type { WireResponse } from "../contracts/classification"
import { type AtomicDeviceGrant, parseAtomicDeviceGrant } from "../contracts/deviceGrant"
import {
    ExchangeOperationConflictError,
    ExchangeOperationExpiredError,
    type RecoverableExchangeTransport,
} from "../contracts/exchangeOperation"
import { parseServiceError } from "../contracts/wire"
import {
    type BootstrapDeviceGrantRequest,
    type DeviceGrantClient,
    type DeviceGrantPort,
    DeviceGrantRefusalError,
} from "./DeviceGrantPort"

const BASE64URL_43_PATTERN = /^[A-Za-z0-9_-]{43}$/
const CLIENT_FIELD_MAX_LENGTH = 64

export interface RecoverableExchangeCoordinatorOptions {
    readonly port: DeviceGrantPort
    readonly repository: ExchangeOperationRepository
    readonly transport: RecoverableExchangeTransport
    readonly clientVersion: string
    readonly platform: string
    readonly clock?: () => number
    readonly requestId?: () => string
}

/**
 * Recovers a device grant across every client-side crash boundary.
 *
 * The operation intent is durable before transport, the encrypted response is
 * durable before credential publication, and only DeviceGrantPort may publish
 * the final token plus capability. Unknown transport outcomes replay the same
 * request identity/body; this adapter never falls back to another issuer.
 */
export class RecoverableExchangeCoordinator implements DeviceGrantClient {
    readonly allowsLegacyFallback = false
    private readonly clock: () => number
    private readonly requestId: () => string
    private inflight: Promise<AtomicDeviceGrant | null> | undefined

    constructor(private readonly options: RecoverableExchangeCoordinatorOptions) {
        this.clock = options.clock ?? Date.now
        this.requestId = options.requestId ?? randomUUID
    }

    async readActiveGrant(now: number): Promise<AtomicDeviceGrant | null> {
        const active = await this.options.port.readActive(now)
        if (active) await this.options.repository.completeAll("device.grant")
        return active
    }

    async ensureActiveGrant(deviceSecret: string, signal?: AbortSignal): Promise<AtomicDeviceGrant | null> {
        const active = await this.readActiveGrant(this.clock())
        if (active) return active
        if (!BASE64URL_43_PATTERN.test(deviceSecret)) {
            throw new Error("Device secret must be 32 random bytes encoded as base64url")
        }
        const shared = this.inflight
        if (shared) return shared
        const running = this.recoverOrRequest(deviceSecret, signal).finally(() => {
            if (this.inflight === running) this.inflight = undefined
        })
        this.inflight = running
        return running
    }

    private async recoverOrRequest(deviceSecret: string, signal: AbortSignal | undefined): Promise<AtomicDeviceGrant | null> {
        const proposed = this.buildRequest(deviceSecret, this.requestId())
        const prepared = await this.options.repository.prepare({ principal: deviceSecret, request: proposed })
        const request = this.buildRequest(deviceSecret, prepared.intent.requestId)
        const recovered = prepared.response
        if (recovered) {
            const grant = this.parseGrantResponse(prepared.intent.requestId, recovered)
            if (!grant) {
                await this.options.repository.clearReceipt(prepared.intent)
                return null
            }
            return this.publishGrant(deviceSecret, prepared.intent.requestId, grant)
        }

        let response: WireResponse
        try {
            response = await this.options.transport.requestRecoverableDeviceOrIssueExchange(request, signal)
        } catch (error) {
            if (signal?.aborted) throw error
            return null
        }
        const grant = this.parseGrantResponse(prepared.intent.requestId, response)
        if (!grant) return null
        try {
            await this.options.repository.storeReceipt(prepared.intent, deviceSecret, response)
        } catch (error) {
            // Another process may have published and completed the same operation while this
            // response was in flight. Prefer the stable authority over recreating the journal.
            const active = await this.options.port.readActive(this.clock())
            if (active) return active
            throw error
        }
        return this.publishGrant(deviceSecret, prepared.intent.requestId, grant)
    }

    private parseGrantResponse(requestId: string, response: WireResponse): AtomicDeviceGrant | null {
        if (response.status === 200) {
            if (!isRecord(response.json) || response.json.ok !== true || response.json.request_id !== requestId) {
                throw new DeviceGrantRefusalError({ kind: "stop", scope: "profile", code: "malformed_grant" })
            }
            const grant = parseAtomicDeviceGrant(response.json)
            if (!grant || grant.profile !== "usage" || grant.expiresAt <= this.clock()) {
                throw new DeviceGrantRefusalError({ kind: "stop", scope: "profile", code: "malformed_grant" })
            }
            return grant
        }
        const error = parseServiceError(response.json, response.retryAfter, this.clock())
        if (response.status === 409 && (error.code === "exchange_operation_conflict" || error.code === "request_id_conflict")) {
            throw new ExchangeOperationConflictError()
        }
        if (
            (response.status === 409 || response.status === 410) &&
            (error.code === "exchange_operation_expired" || error.code === "request_id_expired")
        ) {
            throw new ExchangeOperationExpiredError()
        }
        if (response.status === 408 || response.status === 429 || response.status >= 500) return null
        if (response.status === 403 && (error.code === "device_revoked" || error.code === "device_credential_revoked")) {
            throw new DeviceGrantRefusalError({ kind: "reset_credential", code: error.code })
        }
        const scope = response.json === undefined || error.code === "ip_blocked" ? "all" : "profile"
        throw new DeviceGrantRefusalError({ kind: "stop", scope, code: error.code ?? `http_${response.status}` })
    }

    private async publishGrant(
        deviceSecret: string,
        requestId: string,
        grant: AtomicDeviceGrant,
    ): Promise<AtomicDeviceGrant | null> {
        await this.options.port.publish(grant)
        const active = await this.options.port.readActive(this.clock())
        if (!active) return null
        await this.options.repository.complete(deviceSecret, "device.grant", requestId)
        return active
    }

    private buildRequest(deviceSecret: string, requestId: string): BootstrapDeviceGrantRequest {
        return {
            operation: "device.grant",
            request_id: requestId,
            device_secret: deviceSecret,
            requested_profile: "usage",
            client_version: boundClientField(this.options.clientVersion),
            platform: boundClientField(this.options.platform),
            supported_usage_schema_versions: [4],
        }
    }
}

function boundClientField(value: string): string {
    const trimmed = value.trim().slice(0, CLIENT_FIELD_MAX_LENGTH)
    if (trimmed.length === 0) throw new Error("Device grant client fields must not be empty")
    return trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
