import type { AtomicDeviceGrant, DeviceGrantProfile } from "../contracts/deviceGrant"
import type { USAGE_SCHEMA_VERSION } from "../contracts/usageBodySchema"

/** The `/auth/device/grant` body (telemetry-exchange-flow §4); an unknown outcome replays it unchanged. */
export interface DeviceGrantRequest {
    readonly operation: "device.grant"
    readonly request_id: string
    readonly device_secret: string
    readonly requested_profile: DeviceGrantProfile
    readonly client_version: string
    readonly platform: string
    readonly supported_usage_schema_versions: readonly [typeof USAGE_SCHEMA_VERSION]
}

/** Stable credential authority: one complete grant per profile, published and read as a unit. */
export interface DeviceGrantPort {
    /**
     * Publish a grant obtained for `deviceSecret`. Resolves `false`, publishing
     * nothing, when that device identity was reset while the request was in flight.
     */
    publish(grant: AtomicDeviceGrant, deviceSecret: string): Promise<boolean>
    readActive(profile: DeviceGrantProfile, now: number): Promise<AtomicDeviceGrant | null>
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

export interface EnsureDeviceGrantOptions {
    /** A token the service just answered with 401; a stored grant carrying it counts as absent. */
    readonly rejectedAccessToken?: string
    readonly signal?: AbortSignal
}

export type DeviceGrantAttempt =
    | { readonly kind: "granted"; readonly grant: AtomicDeviceGrant }
    /** Nothing was granted now: the outcome is transient or unknown. `retryAfterMs` is the delay the service named. */
    | { readonly kind: "deferred"; readonly retryAfterMs?: number }

/** Device grant acquisition consumed by the token broker. */
export interface DeviceGrantClient {
    /** No-network projection read before the broker takes the machine-wide acquisition claim. */
    readActiveGrant(profile: DeviceGrantProfile, now: number): Promise<AtomicDeviceGrant | null>
    /**
     * Return an active grant, requesting one when needed. Rejects with
     * {@link DeviceGrantRefusalError} when the service refused the device.
     */
    ensureActiveGrant(
        profile: DeviceGrantProfile,
        deviceSecret: string,
        options?: EnsureDeviceGrantOptions,
    ): Promise<DeviceGrantAttempt>
}

/** Repository shape kept structural so the service contract does not depend on a concrete storage class. */
export interface AtomicDeviceGrantRepository {
    publishDeviceGrantAtomically(grant: AtomicDeviceGrant, deviceSecret: string): Promise<boolean>
    readActiveDeviceGrant(now: number, profile: DeviceGrantProfile): Promise<AtomicDeviceGrant | null>
}

export function deviceGrantPortFromRepository(repository: AtomicDeviceGrantRepository): DeviceGrantPort {
    return {
        publish: (grant, deviceSecret) => repository.publishDeviceGrantAtomically(grant, deviceSecret),
        readActive: (profile, now) => repository.readActiveDeviceGrant(now, profile),
    }
}
