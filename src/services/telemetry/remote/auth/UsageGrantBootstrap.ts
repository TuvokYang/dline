import { randomUUID } from "node:crypto"
import { type AtomicDeviceGrant, parseAtomicDeviceGrant } from "../contracts/deviceGrant"
import type { BootstrapDeviceGrantRequest, DeviceGrantClient, DeviceGrantPort, DeviceGrantTransport } from "./DeviceGrantPort"

const BASE64URL_43_PATTERN = /^[A-Za-z0-9_-]{43}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CLIENT_FIELD_MAX_LENGTH = 64
export const USAGE_GRANT_BOOTSTRAP_BACKOFF_BASE_MS = 60_000
export const USAGE_GRANT_BOOTSTRAP_BACKOFF_MAX_MS = 60 * 60_000

export interface UsageGrantBootstrapOptions {
    readonly port: DeviceGrantPort
    readonly transport: DeviceGrantTransport
    readonly clientVersion: string
    readonly platform: string
    readonly clock?: () => number
    readonly requestId?: () => string
}

/**
 * Phase U one-shot capability client.
 *
 * It intentionally owns no replay journal. Phase E replaces this adapter with
 * the recoverable coordinator while both continue to publish through the same
 * {@link DeviceGrantPort}.
 */
export class UsageGrantBootstrap implements DeviceGrantClient {
    private readonly clock: () => number
    private readonly requestId: () => string
    private inflight: Promise<AtomicDeviceGrant | null> | undefined
    private consecutiveFailures = 0
    private nextAttemptAt = 0

    constructor(private readonly options: UsageGrantBootstrapOptions) {
        this.clock = options.clock ?? Date.now
        this.requestId = options.requestId ?? randomUUID
    }

    readActiveGrant(now: number): Promise<AtomicDeviceGrant | null> {
        return this.options.port.readActive(now)
    }

    async ensureActiveGrant(deviceSecret: string, signal?: AbortSignal): Promise<AtomicDeviceGrant | null> {
        const now = this.clock()
        const active = await this.readActiveGrant(now)
        if (active) {
            this.consecutiveFailures = 0
            this.nextAttemptAt = 0
            return active
        }
        if (!BASE64URL_43_PATTERN.test(deviceSecret))
            throw new Error("Device secret must be 32 random bytes encoded as base64url")
        if (now < this.nextAttemptAt) return null
        const shared = this.inflight
        if (shared) return shared
        const running = this.requestAndPublish(deviceSecret, signal).finally(() => {
            if (this.inflight === running) this.inflight = undefined
        })
        this.inflight = running
        const grant = await running
        if (grant) {
            this.consecutiveFailures = 0
            this.nextAttemptAt = 0
        } else {
            this.consecutiveFailures += 1
            this.nextAttemptAt =
                this.clock() +
                Math.min(
                    USAGE_GRANT_BOOTSTRAP_BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1),
                    USAGE_GRANT_BOOTSTRAP_BACKOFF_MAX_MS,
                )
        }
        return grant
    }

    private async requestAndPublish(deviceSecret: string, signal: AbortSignal | undefined): Promise<AtomicDeviceGrant | null> {
        const request = this.buildRequest(deviceSecret)
        let response
        try {
            response = await this.options.transport.requestBootstrapDeviceGrant(request, signal)
        } catch (error) {
            if (signal?.aborted) throw error
            return null
        }
        if (response.status !== 200 || !isRecord(response.json) || response.json.ok !== true) return null
        if (response.json.request_id !== request.request_id) return null
        const grant = parseAtomicDeviceGrant(response.json)
        if (!grant || grant.profile !== "usage" || grant.expiresAt <= this.clock()) return null
        await this.options.port.publish(grant)
        return this.options.port.readActive(this.clock())
    }

    private buildRequest(deviceSecret: string): BootstrapDeviceGrantRequest {
        const requestId = this.requestId()
        if (!UUID_PATTERN.test(requestId)) throw new Error("Device grant request ID must be a UUID")
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
