import type { WireResponse } from "../contracts/classification"
import type { AtomicDeviceGrant } from "../contracts/deviceGrant"

/** One bounded Phase U request; Phase E may replay it but must preserve these semantics. */
export interface BootstrapDeviceGrantRequest {
    readonly operation: "device.grant"
    readonly request_id: string
    readonly device_secret: string
    readonly requested_profile: "usage"
    readonly client_version: string
    readonly platform: string
    readonly supported_usage_schema_versions: readonly [4]
}

/** Transport-only boundary. It does not own credential publication. */
export interface DeviceGrantTransport {
    requestBootstrapDeviceGrant(request: BootstrapDeviceGrantRequest, signal?: AbortSignal): Promise<WireResponse>
}

/** Stable credential authority shared by the bootstrap and recoverable exchange clients. */
export interface DeviceGrantPort {
    publish(grant: AtomicDeviceGrant): Promise<void>
    readActive(now: number): Promise<AtomicDeviceGrant | null>
}

export type DeviceGrantRefusal =
    | { readonly kind: "reset_credential"; readonly code: string }
    | { readonly kind: "stop"; readonly scope: "profile" | "all"; readonly code: string }

/** Determinate refusal from the recoverable endpoint; transient/unknown outcomes return no grant instead. */
export class DeviceGrantRefusalError extends Error {
    constructor(readonly refusal: DeviceGrantRefusal) {
        super(`Device grant refused: ${refusal.code}`)
        this.name = "DeviceGrantRefusalError"
    }
}

/** Adapter contract consumed by Usage; Phase E replaces the bootstrap implementation through the registry. */
export interface DeviceGrantClient {
    /**
     * Phase U may fall back to the legacy device exchange when its bootstrap endpoint is unavailable.
     * A recoverable owner sets this to false because replaying through another issuer could mint a second token.
     */
    readonly allowsLegacyFallback?: boolean
    /** Optional no-network projection used before taking the machine-wide acquisition claim. */
    readActiveGrant?(now: number): Promise<AtomicDeviceGrant | null>
    ensureActiveGrant(deviceSecret: string, signal?: AbortSignal): Promise<AtomicDeviceGrant | null>
}

/** Repository shape kept structural so the service contract does not depend on a concrete storage class. */
export interface AtomicDeviceGrantRepository {
    publishDeviceGrantAtomically(grant: AtomicDeviceGrant): Promise<void>
    readActiveDeviceGrant(now: number): Promise<AtomicDeviceGrant | null>
}

export function deviceGrantPortFromRepository(repository: AtomicDeviceGrantRepository): DeviceGrantPort {
    return {
        publish: (grant) => repository.publishDeviceGrantAtomically(grant),
        readActive: (now) => repository.readActiveDeviceGrant(now),
    }
}
